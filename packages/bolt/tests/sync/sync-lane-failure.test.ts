import { describe, expect, it } from 'vitest';
import {
	CollectionMutationIdempotencyKey,
	SyncConnectionLane,
	type SyncAdvanceRequest,
	type SyncAdvanceResponse,
	type SyncApplyFrame,
	type SyncConnectEvaluation,
	type SyncConnectEvaluationResult,
	type SyncExtendPrefixEvaluation,
	type SyncRegistryConnection
} from '@norbital-ai/bolt-protocol';
import { createHash } from 'node:crypto';

/**
 * The lane's fail-closed half, driven directly.
 *
 * `SyncConnectionLane` is where a commit stops being a database fact and becomes a delivered frame,
 * and it is the only place that can decide what happens when delivery does not work. Probe S7 asks
 * that question through a browser — "failed delivery closes the stream; the write never
 * 200-and-forgets" — which a browser can only observe as a dropped `EventSource`. The decision
 * itself is here, in `#failCommit` and the `guestFailure` close reason, and it is reachable without
 * a database, a socket, or a guest: a sink that refuses a write, and a guest answer that does not
 * describe the subscriptions it was asked about, are both ordinary values.
 *
 * These run in the unit suite deliberately. The failure modes they cover are the ones that bite on
 * the merge path, and nothing they assert needs Postgres — the runtime-backed half of S3/S4/S6/S7
 * lives in `sync-lane.integration.test.ts` alongside a real one.
 */

type CloseReason = 'client' | 'guest-failed';
type LaneConnection = SyncRegistryConnection & Readonly<{ id: string }>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

type Viewer = Readonly<{
	readonly connection: LaneConnection;
	/** Every frame the lane handed this sink, in order. */
	readonly frames: Array<SyncApplyFrame>;
	/** Every close the lane performed on this connection, with the reason it gave. */
	readonly closes: Array<CloseReason>;
	/** Makes `sink.write` answer `false`, which is a slow or dead reader. */
	readonly refuseWrite: () => void;
	/** Makes `sink.writable` answer `false`, which is a socket already gone. */
	readonly stopBeingWritable: () => void;
	/** Makes `sink.write` throw, which is a sink whose transport blew up mid-write. */
	readonly throwOnWrite: () => void;
}>;

const makeViewer = (id: string, credential: string): Viewer => {
	const frames: Array<SyncApplyFrame> = [];
	const closes: Array<CloseReason> = [];
	let writable = true;
	let accepts = true;
	let throws = false;
	const connection: LaneConnection = {
		id,
		credential,
		sink: {
			writable: () => writable,
			write: (frame) => {
				if (throws) throw new Error(`sink ${id} lost its transport`);
				if (!accepts) return false;
				frames.push(frame);
				return true;
			}
		},
		subscriptions: new Map<string, string>(),
		closed: false
	};
	return {
		connection,
		frames,
		closes,
		refuseWrite: () => {
			accepts = false;
		},
		stopBeingWritable: () => {
			writable = false;
		},
		throwOnWrite: () => {
			throws = true;
		}
	};
};

/** One admitted live query, as the guest would have answered for it. */
const evaluationResult = (
	queryKey: string,
	collection: string,
	rows: ReadonlyArray<Readonly<{ id: string }>>
): SyncConnectEvaluationResult => ({
	key: queryKey,
	input: { kind: 'findMany', collection, orderBy: { rank: 'asc' }, limit: 10 },
	planKey: `plan:${collection}`,
	version: 0,
	prefixKeys: rows.map(({ id }, index) => ({ id, order: [index + 1, id] })),
	loadedPrefix: rows.length,
	prefixBytes: rows.length * 32,
	authorityFingerprint: `authority:${collection}`,
	dependencies: [collection],
	routing: [],
	rows
});

type LaneHarness = {
	readonly lane: SyncConnectionLane<LaneConnection, CloseReason>;
	/** What the guest answers next; a case replaces it, and the lane reads it through this object. */
	advance: (request: SyncAdvanceRequest) => Promise<SyncAdvanceResponse>;
	connect: () => Promise<SyncConnectEvaluation>;
	/** Every advance request the lane actually issued, so "no work" is observable. */
	readonly advanceRequests: Array<SyncAdvanceRequest>;
	readonly viewers: Map<string, Viewer>;
};

const makeLane = (): LaneHarness => {
	const viewers = new Map<string, Viewer>();
	// Assembled in two steps because the lane's callbacks close over `harness` — a spread copy would
	// freeze today's stubs into the lane and silently ignore every later replacement.
	const harness: LaneHarness = {
		lane: new SyncConnectionLane<LaneConnection, CloseReason>({
			hash: sha256,
			connect: () => harness.connect(),
			extendPrefix: (): Promise<SyncExtendPrefixEvaluation> =>
				Promise.reject(new Error('this lane does not extend prefixes')),
			guestFailure: 'guest-failed',
			close: (connection, reason) => viewers.get(connection.id)?.closes.push(reason)
		}),
		advance: () => Promise.resolve({ updates: [], resets: [], outcomes: [] }),
		connect: () => Promise.resolve({ results: [], outcomes: [] }),
		advanceRequests: [],
		viewers
	};
	return harness;
};

/** Opens a viewer on the lane and registers `queryKey` over `collection`. */
const open = async (
	harness: LaneHarness,
	id: string,
	queryKey: string,
	collection: string,
	rows: ReadonlyArray<Readonly<{ id: string }>>
): Promise<Viewer> => {
	const viewer = makeViewer(id, `credential:${id}`);
	harness.viewers.set(id, viewer);
	harness.lane.open(viewer.connection, 'client');
	harness.connect = () =>
		Promise.resolve({ results: [evaluationResult(queryKey, collection, rows)], outcomes: [] });
	await harness.lane.connect({
		request: {
			queries: [
				{
					queryKey,
					input: { kind: 'findMany', collection, orderBy: { rank: 'asc' }, limit: 10 },
					requestedPrefix: 10
				}
			],
			detached: [],
			pending: []
		},
		resolve: () => viewer.connection,
		unavailable: () => new Error(`connection ${id} is unavailable`)
	});
	return viewer;
};

const PEOPLE = [{ id: 'r1' }, { id: 'r2' }] as const;

/** A well-formed advance of the `people` plan from version 0 to 1, for a viewer loaded to 2 rows. */
const validPeopleUpdate = (subId: string): SyncAdvanceResponse => ({
	updates: [
		{
			subId,
			fromVersion: 0,
			toVersion: 1,
			prefixKeys: [
				{ id: 'r2', order: [2, 'r2'] },
				{ id: 'r3', order: [3, 'r3'] }
			],
			prefixBytes: 64,
			deltas: [
				{
					loadedPrefix: 2,
					delta: { removeIds: ['r1'], put: [{ id: 'r3', index: 1, row: { id: 'r3' } }] }
				}
			],
			authorityFingerprint: 'authority:people',
			dependencies: ['people']
		}
	],
	resets: [],
	outcomes: []
});

const peopleChange: SyncAdvanceRequest['changes'] = [
	{ collection: 'people', id: 'r3', operation: 'insert', after: {} }
];

describe('sync lane fail-closed delivery (S7)', () => {
	it('closes a subscriber whose sink refuses the frame instead of reporting the commit delivered', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		harness.advance = (request) => {
			harness.advanceRequests.push(request);
			return Promise.resolve(validPeopleUpdate(subId));
		};
		reader.refuseWrite();

		await harness.lane.committed({
			changes: peopleChange,
			pending: [],
			resolveWriter: () => undefined,
			writerProof: (connection) => ({ credential: connection.credential }),
			advance: harness.advance
		});

		// Fail-closed: the frame was refused, so the subscription is gone and the socket is closed
		// with the guest-failure reason rather than left believing it is current.
		expect(reader.frames).toEqual([]);
		expect(reader.closes).toEqual(['guest-failed']);
		expect(reader.connection.closed).toBe(true);
		expect(harness.lane.get('reader')).toBeUndefined();
		expect(harness.lane.registry.details(subId)).toBeUndefined();
	});

	it('closes a subscriber whose sink is no longer writable without attempting the write', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		harness.advance = () => Promise.resolve(validPeopleUpdate(subId));
		reader.stopBeingWritable();

		await harness.lane.committed({
			changes: peopleChange,
			pending: [],
			resolveWriter: () => undefined,
			writerProof: (connection) => ({ credential: connection.credential }),
			advance: harness.advance
		});

		expect(reader.frames).toEqual([]);
		expect(reader.closes).toEqual(['guest-failed']);
	});

	it('closes a subscriber whose sink throws mid-write rather than letting the throw escape', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		harness.advance = () => Promise.resolve(validPeopleUpdate(subId));
		reader.throwOnWrite();

		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				resolveWriter: () => undefined,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: harness.advance
			})
		).resolves.toBeUndefined();
		expect(reader.closes).toEqual(['guest-failed']);
	});

	it('refuses the writer its success when the writer could not be handed its own frame', async () => {
		const harness = makeLane();
		const writer = await open(harness, 'writer', 'people', 'people', PEOPLE);
		const subId = writer.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the writer did not register its query');
		harness.advance = () => Promise.resolve(validPeopleUpdate(subId));
		writer.refuseWrite();

		// The one thing a fail-closed lane must never do: resolve. A resolved `committed` is what the
		// facility turns into a 200 for a mutation whose delta nobody received.
		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				resolveWriter: () => writer.connection,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: harness.advance
			})
		).rejects.toThrow('writer sync frame was not accepted');
		expect(writer.closes).toEqual(['guest-failed']);
	});

	it('closes every affected subscriber when the guest advance itself fails', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const other = await open(harness, 'other', 'people', 'people', PEOPLE);

		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				resolveWriter: () => undefined,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: () => Promise.reject(new Error('guest evaluation exploded'))
			})
		).rejects.toThrow('guest evaluation exploded');
		expect(reader.closes).toEqual(['guest-failed']);
		expect(other.closes).toEqual(['guest-failed']);
	});

	it('rejects and closes when the guest answers about a subscription it was not asked about', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);

		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				resolveWriter: () => undefined,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: () => Promise.resolve(validPeopleUpdate('a-subscription-nobody-registered'))
			})
		).rejects.toThrow('invalid sync version advance');
		expect(reader.closes).toEqual(['guest-failed']);
	});

	it('rejects and closes when the guest advances a version it does not currently hold', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		const stale = validPeopleUpdate(subId);
		const update = stale.updates[0];
		if (update === undefined) throw new Error('the fixture update went missing');

		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				resolveWriter: () => undefined,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: () =>
					Promise.resolve({
						...stale,
						// Version 5 → 6 against a plan sitting at 0: a fence the lane must not step over.
						updates: [{ ...update, fromVersion: 5, toVersion: 6 }]
					})
			})
		).rejects.toThrow('invalid sync version advance');
		expect(reader.closes).toEqual(['guest-failed']);
		expect(reader.frames).toEqual([]);
	});

	it('rejects write outcomes that arrive without an owning connection', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);

		await expect(
			harness.lane.committed({
				changes: peopleChange,
				pending: [],
				// No writer: the commit came from somewhere with no browser behind it.
				resolveWriter: () => undefined,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance: () =>
					Promise.resolve({
						updates: [],
						resets: [],
						outcomes: [
							{
								id: CollectionMutationIdempotencyKey.make(
									'11111111-1111-5111-8111-111111111111'
								),
								status: { resolution: 'accepted' as const, schemaFingerprint: 'sha256:schema' }
							}
						]
					})
			})
		).rejects.toThrow('writer outcomes require an owning connection');
		expect(reader.closes).toEqual(['guest-failed']);
	});

	it('closes the connection when the guest fails to evaluate its opening request', async () => {
		const harness = makeLane();
		const viewer = makeViewer('opener', 'credential:opener');
		harness.viewers.set('opener', viewer);
		harness.lane.open(viewer.connection, 'client');
		harness.connect = () => Promise.reject(new Error('guest connect exploded'));

		await expect(
			harness.lane.connect({
				request: {
					queries: [
						{
							queryKey: 'people',
							input: { kind: 'findMany', collection: 'people', orderBy: { rank: 'asc' }, limit: 10 },
							requestedPrefix: 10
						}
					],
					detached: [],
					pending: []
				},
				resolve: () => viewer.connection,
				unavailable: () => new Error('opener is unavailable')
			})
		).rejects.toThrow('guest connect exploded');
		expect(viewer.closes).toEqual(['guest-failed']);
	});

	it('closes the connection when the opening answer does not cover the queries that were asked', async () => {
		const harness = makeLane();
		const viewer = makeViewer('opener', 'credential:opener');
		harness.viewers.set('opener', viewer);
		harness.lane.open(viewer.connection, 'client');
		// The guest answered about a different query than the one requested. Answering the wrong
		// question is not a smaller failure than answering none: the browser would install a prefix it
		// never asked for and wait forever for the one it did.
		harness.connect = () =>
			Promise.resolve({ results: [evaluationResult('orders', 'orders', [])], outcomes: [] });

		await expect(
			harness.lane.connect({
				request: {
					queries: [
						{
							queryKey: 'people',
							input: { kind: 'findMany', collection: 'people', orderBy: { rank: 'asc' }, limit: 10 },
							requestedPrefix: 10
						}
					],
					detached: [],
					pending: []
				},
				resolve: () => viewer.connection,
				unavailable: () => new Error('opener is unavailable')
			})
		).rejects.toThrow('sync initial answer does not match its prefix');
		expect(viewer.closes).toEqual(['guest-failed']);
	});
});

describe('sync lane isolation of unrelated publications (S4)', () => {
	it('asks the guest nothing and writes no frame when an unrelated collection changes', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		const before = harness.lane.registry.prefixViewer(reader.connection, 'people');
		harness.advance = (request) => {
			harness.advanceRequests.push(request);
			return Promise.resolve({ updates: [], resets: [], outcomes: [] });
		};

		await harness.lane.committed({
			changes: [{ collection: 'invoices', id: 'i1', operation: 'insert', after: {} }],
			pending: [],
			resolveWriter: () => undefined,
			writerProof: (connection) => ({ credential: connection.credential }),
			advance: harness.advance
		});

		// No subscription was named, so the guest had no plan to re-evaluate — the "zero SQL for an
		// unrelated publication" performance gate, asserted where it is decided.
		expect(harness.advanceRequests).toHaveLength(1);
		expect(harness.advanceRequests[0]?.subscriptions).toEqual([]);
		// And nothing reached the browser, so nothing can remount.
		expect(reader.frames).toEqual([]);
		expect(reader.closes).toEqual([]);
		// Same subscription, same version, same loaded prefix: a stable `current` identity.
		expect(harness.lane.registry.prefixViewer(reader.connection, 'people')).toEqual(before);
		expect(reader.connection.subscriptions.get('people')).toBe(subId);
	});

	it('leaves a bystander subscription untouched while another plan advances', async () => {
		const harness = makeLane();
		const reader = await open(harness, 'reader', 'people', 'people', PEOPLE);
		const bystander = await open(harness, 'bystander', 'invoices', 'invoices', [{ id: 'i1' }]);
		const bystanderBefore = harness.lane.registry.prefixViewer(bystander.connection, 'invoices');
		const subId = reader.connection.subscriptions.get('people');
		if (subId === undefined) throw new Error('the reader did not register its query');
		harness.advance = (request) => {
			harness.advanceRequests.push(request);
			return Promise.resolve(validPeopleUpdate(subId));
		};

		await harness.lane.committed({
			changes: peopleChange,
			pending: [],
			resolveWriter: () => undefined,
			writerProof: (connection) => ({ credential: connection.credential }),
			advance: harness.advance
		});

		expect(harness.advanceRequests[0]?.subscriptions.map(({ subId: id }) => id)).toEqual([subId]);
		expect(reader.frames).toHaveLength(1);
		expect(reader.frames[0]?.updates[0]).toMatchObject({
			queryKey: 'people',
			fromVersion: 0,
			toVersion: 1
		});
		expect(bystander.frames).toEqual([]);
		expect(bystander.closes).toEqual([]);
		expect(harness.lane.registry.prefixViewer(bystander.connection, 'invoices')).toEqual(
			bystanderBefore
		);
	});
});
