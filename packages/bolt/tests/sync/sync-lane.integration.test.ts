import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	SyncConnectionLane,
	type SyncAdvanceRequest,
	type SyncApplyFrame,
	type SyncConnectRequest,
	type SyncConnectResponse,
	type SyncQueryInput,
	type SyncRegistryConnection
} from '@norbital-ai/bolt-protocol';
import { field } from '../../src/authoring/workspace-schema.js';
import { applyPrefixDelta } from '../../src/client/live-query/project.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as Identity from '../../src/runtime/identity/identity.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import { SyncCommit } from '../../src/runtime/facilities/services.js';
import { seedSession } from '../support/fixture-identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The sync lane over the real runtime.
 *
 * `sync-lane-failure.test.ts` drives `SyncConnectionLane` against a stubbed guest, because that is
 * where its fail-closed decisions live. This file does the opposite half: the lane is wired to the
 * actual `Sync` service over a real PGlite database, so the answers it validates are ones the
 * effective-plan compiler and the delta engine really produced, and the mutations it publishes are
 * ones the write path really committed. Between the two, probes S3, S4, S6 and S7 stop depending on
 * a browser being open.
 *
 * What stays browser-only is named where it applies, rather than approximated here.
 */

type CloseReason = 'client' | 'guest-failed';
type LaneConnection = SyncRegistryConnection & Readonly<{ id: string }>;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

type Viewer = Readonly<{
	readonly connection: LaneConnection;
	readonly frames: Array<SyncApplyFrame>;
	readonly closes: Array<CloseReason>;
	readonly refuseWrite: () => void;
}>;

const makeViewer = (id: string, credential: string): Viewer => {
	const frames: Array<SyncApplyFrame> = [];
	const closes: Array<CloseReason> = [];
	let accepts = true;
	return {
		connection: {
			id,
			credential,
			sink: {
				writable: () => true,
				write: (frame) => {
					if (!accepts) return false;
					frames.push(frame);
					return true;
				}
			},
			subscriptions: new Map<string, string>(),
			closed: false
		},
		frames,
		closes,
		refuseWrite: () => {
			accepts = false;
		}
	};
};

/**
 * A lane bound to this runtime's `Sync` service, the way `bolt-server`'s host binds one.
 *
 * The guest bridge is not stubbed: `connect` resolves the connection's stored credential through
 * `Identity.authenticate` — the same resolution the `sync.connect` command binding performs — and
 * then calls the service. So an answer the lane accepts is an answer the effective-plan compiler
 * admitted, not a fixture that happens to typecheck.
 */
const makeLaneHost = (harness: BoltTestRuntime) => {
	const viewers = new Map<string, Viewer>();
	const advanceRequests: Array<SyncAdvanceRequest> = [];
	let sequence = 0;
	const nextId = (name: string): EffectId => EffectId.make(`${name}:${++sequence}`);
	const subjectFor = (credential: string) =>
		Effect.flatMap(Identity.Service, (identity) => identity.authenticate(nextId('auth'), credential));

	// Annotated because the `extendPrefix` callback reads `lane.registry`, and an inferred type would
	// be circular through its own initializer.
	const lane: SyncConnectionLane<LaneConnection, CloseReason> = new SyncConnectionLane<
		LaneConnection,
		CloseReason
	>({
		hash: sha256,
		connect: (connection, request) =>
			harness.runtime.runPromise(
				Effect.gen(function* () {
					const subject = yield* subjectFor(connection.credential);
					return yield* (yield* Sync.Service).connect(
						nextId('connect'),
						subject,
						subject,
						null,
						request
					);
				})
			),
		extendPrefix: (connection, request) => {
			const viewer = lane.registry.prefixViewer(connection, request.queryKey);
			const details = viewer === undefined ? undefined : lane.registry.details(viewer.subId);
			if (details === undefined) return Promise.reject(new Error('the viewer is not attached'));
			const { impersonatedTeam: _representative, ...shared } = details.subscription;
			return harness.runtime.runPromise(
				Effect.flatMap(Sync.Service, (sync) =>
					sync.extendPrefix(
						nextId('extend'),
						{ ...shared, credential: connection.credential },
						request
					)
				)
			);
		},
		guestFailure: 'guest-failed',
		close: (connection, reason) => viewers.get(connection.id)?.closes.push(reason)
	});

	const advance = (request: SyncAdvanceRequest) => {
		advanceRequests.push(request);
		return harness.runtime.runPromise(
			Effect.flatMap(Sync.Service, (sync) => sync.advance(nextId('advance'), request))
		);
	};

	return {
		lane,
		viewers,
		advanceRequests,
		nextId,
		/** Opens a viewer whose credential is the session token seeded for `token`. */
		open: (id: string, token: string): Viewer => {
			const viewer = makeViewer(id, token);
			viewers.set(id, viewer);
			lane.open(viewer.connection, 'client');
			return viewer;
		},
		connect: (viewer: Viewer, request: SyncConnectRequest): Promise<SyncConnectResponse> =>
			lane.connect({
				request,
				resolve: () => (viewer.connection.closed ? undefined : viewer.connection),
				unavailable: () => new Error(`connection ${viewer.connection.id} is unavailable`)
			}),
		/**
		 * Publishes a committed batch through the lane exactly as the host's `SyncCommit` facility
		 * does — the changes come out of the write path, never out of the test.
		 */
		publish: (
			changes: SyncAdvanceRequest['changes'],
			writer?: Viewer
		): Promise<void> =>
			lane.committed({
				changes,
				pending: [],
				resolveWriter: () => writer?.connection,
				writerProof: (connection) => ({ credential: connection.credential }),
				advance
			})
	};
};

const definition = testWorkspace({
	collections: [
		{
			name: 'people',
			fields: { name: field.string({ required: true }), team: field.string() }
		},
		{ name: 'invoices', fields: { label: field.string({ required: true }) } }
	]
});

const peopleQuery: SyncQueryInput = {
	kind: 'findMany',
	collection: 'people',
	orderBy: { name: 'asc' },
	limit: 10
};
const invoiceQuery: SyncQueryInput = {
	kind: 'findMany',
	collection: 'invoices',
	orderBy: { label: 'asc' },
	limit: 10
};

const connectRequest = (
	queries: ReadonlyArray<Readonly<{ queryKey: string; input: SyncQueryInput }>>,
	requestedPrefix = 10
): SyncConnectRequest => ({
	queries: queries.map(({ queryKey, input }) => ({ queryKey, input, requestedPrefix })),
	detached: [],
	pending: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** Seeds people and invoices, plus a session token per named viewer. */
const boot = async (tokens: ReadonlyArray<string>) => {
	const h = await makeBoltTestRuntime(definition);
	harness = h;
	for (const token of tokens)
		await seedSession(h, { token, user: `user-${token}`, team: 'admin' });
	await h.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				EffectId.make('seed-people'),
				adminSubject,
				'people',
				[
					{ name: 'Ada', team: 'core' },
					{ name: 'Grace', team: 'core' },
					{ name: 'Linus', team: 'edge' },
					{ name: 'Mia', team: 'edge' }
				],
				false,
				0
			);
			yield* collections.mutate(
				EffectId.make('seed-invoices'),
				adminSubject,
				'invoices',
				[{ label: 'INV-1' }],
				false,
				0
			);
			// Setup writes are not the publication under test.
			yield* (yield* SyncCommit.Service).drainChanges;
		})
	);
	return h;
};

/** Runs one mutation and hands back exactly the changes the runtime announced for it. */
const mutateAndDrain = (
	h: BoltTestRuntime,
	name: string,
	collection: string,
	payloads: ReadonlyArray<Readonly<Record<string, unknown>>>
) =>
	h.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).mutate(
				EffectId.make(name),
				adminSubject,
				collection,
				payloads,
				false,
				0
			);
			return yield* (yield* SyncCommit.Service).drainChanges;
		})
	);

const freshPeople = (h: BoltTestRuntime, name: string) =>
	h.runtime.runPromise(
		Effect.flatMap(Collections.Service, (collections) =>
			collections.findMany(EffectId.make(name), adminSubject, {
				collection: 'people',
				orderBy: { name: 'asc' },
				limit: 10
			})
		)
	);

describe('sync lane over the live runtime: opening race (S3)', () => {
	it('answers a query registered after the connection is already open', async () => {
		const h = await boot(['reader-token']);
		const host = makeLaneHost(h);
		const reader = host.open('reader', 'reader-token');
		const first = await host.connect(
			reader,
			connectRequest([{ queryKey: 'people', input: peopleQuery }])
		);
		expect(first.queries[0]?.rows).toHaveLength(4);
		const peopleSub = reader.connection.subscriptions.get('people');

		// The view mounted second. It registers on the connection that is already live, which is the
		// state probe S3 describes as "mounted after first connect".
		const second = await host.connect(
			reader,
			connectRequest([{ queryKey: 'invoices', input: invoiceQuery }])
		);

		expect(second.queries.map(({ queryKey }) => queryKey)).toEqual(['invoices']);
		expect(second.queries[0]?.rows).toHaveLength(1);
		expect(second.queries[0]?.version).toBe(0);
		// The first query is untouched: registering a second one is not a reconnect.
		expect(reader.connection.subscriptions.get('people')).toBe(peopleSub);
		expect(reader.connection.subscriptions.get('invoices')).toBeDefined();
		expect(reader.closes).toEqual([]);
	});

	it('settles a late registration that races a commit, and answers it from committed truth', async () => {
		const h = await boot(['reader-token']);
		const host = makeLaneHost(h);
		const reader = host.open('reader', 'reader-token');
		await host.connect(reader, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		const changes = await mutateAndDrain(h, 'race-insert', 'people', [
			{ name: 'Aaron', team: 'core' }
		]);

		// Both in flight at once, in the order the host would have them: a commit publishing while a
		// newly mounted view is opening. The lane serializes them; nothing here awaits between.
		const published = host.publish(changes);
		const late = host.connect(
			reader,
			connectRequest([{ queryKey: 'people-late', input: peopleQuery }])
		);
		const [, answer] = await Promise.all([published, late]);
		await host.lane.idle();

		// Answered, not pending: an opening that raced a commit sees the commit, and joins the shared
		// plan at the version that commit left it at rather than at a zero it would never advance from.
		const late_answer = answer.queries[0];
		expect(late_answer?.rows).toEqual(await freshPeople(h, 'race-fresh'));
		expect(late_answer?.version).toBe(1);
		expect(reader.closes).toEqual([]);
	});

	it('admits a second connection to a query another viewer has already advanced', async () => {
		const h = await boot(['reader-token', 'second-token']);
		const host = makeLaneHost(h);
		const first = host.open('first', 'reader-token');
		await host.connect(first, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		await host.publish(
			await mutateAndDrain(h, 'advance-once', 'people', [{ name: 'Aaron', team: 'core' }])
		);

		// A second browser profile opening the same query. Its evaluation is freshly resolved, so it
		// says version 0 while the shared plan is at 1 — and refusing that mismatch used to close this
		// connection outright with `incompatible versioned sync registration`, which is probe S2's
		// whole subject. The registry adopts the plan's version instead, because the lane serialized
		// this evaluation against the commit and it therefore *is* the current answer.
		const second = host.open('second', 'second-token');
		const answer = await host.connect(
			second,
			connectRequest([{ queryKey: 'people', input: peopleQuery }])
		);

		expect(second.closes).toEqual([]);
		expect(answer.queries[0]?.rows).toEqual(await freshPeople(h, 'second-fresh'));
		// The fence the second viewer is told to continue from has to be the live one; a 0 here would
		// make it throw away the very next update as discontinuous.
		expect(answer.queries[0]?.version).toBe(1);

		// And it really does continue: the next commit reaches both viewers as 1 → 2.
		await host.publish(
			await mutateAndDrain(h, 'advance-twice', 'people', [{ name: 'Aaron II', team: 'core' }])
		);
		expect(first.frames.at(-1)?.updates[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
		expect(second.frames.at(-1)?.updates[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
	});

	it('fails a late registration the plan cannot admit with a real error rather than silence', async () => {
		const h = await boot(['reader-token']);
		const host = makeLaneHost(h);
		const reader = host.open('reader', 'reader-token');
		await host.connect(reader, connectRequest([{ queryKey: 'people', input: peopleQuery }]));

		// A collection this workspace does not declare. The effective-plan compiler refuses it, and
		// what matters for S3 is that the refusal reaches the caller: a query that cannot be admitted
		// must not sit in `loading` for the life of the connection.
		await expect(
			host.connect(
				reader,
				connectRequest([
					{ queryKey: 'ghosts', input: { kind: 'findMany', collection: 'ghosts', limit: 10 } }
				])
			)
		).rejects.toThrow();
		// Fail-closed, so the browser reopens from PostgreSQL truth rather than half-registering.
		expect(reader.closes).toEqual(['guest-failed']);
		expect(host.lane.get('reader')).toBeUndefined();
	});
});

describe('sync lane over the live runtime: unrelated publication (S4)', () => {
	it('does no work and sends no frame to a subscription the commit cannot touch', async () => {
		const h = await boot(['reader-token']);
		const host = makeLaneHost(h);
		const reader = host.open('reader', 'reader-token');
		await host.connect(reader, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		const before = host.lane.registry.prefixViewer(reader.connection, 'people');
		const changes = await mutateAndDrain(h, 'unrelated-insert', 'invoices', [{ label: 'INV-2' }]);
		h.database.forget();

		await host.publish(changes);

		expect(host.advanceRequests.at(-1)?.subscriptions).toEqual([]);
		// Zero SQL. The subscription's dependencies do not name `invoices`, so no plan is re-evaluated
		// and the database is never asked anything on behalf of this publication.
		expect(h.database.statements).toEqual([]);
		expect(reader.frames).toEqual([]);
		// A stable subscription identity is what keeps the browser from remounting the view.
		expect(host.lane.registry.prefixViewer(reader.connection, 'people')).toEqual(before);
		expect(before?.version).toBe(0);
	});
});

describe('sync lane over the live runtime: version-fenced delta (S6)', () => {
	it('delivers another subscriber a fenced delta that reproduces authoritative truth', async () => {
		const h = await boot(['writer-token', 'reader-token']);
		const host = makeLaneHost(h);
		const writer = host.open('writer', 'writer-token');
		const reader = host.open('reader', 'reader-token');
		// Two loaded rows out of four, so the retained prefix is unambiguously a *prefix* and the
		// oracle below is the first two rows of the authoritative answer, not the whole of it.
		await host.connect(writer, connectRequest([{ queryKey: 'people', input: peopleQuery }], 2));
		const opened = await host.connect(
			reader,
			connectRequest([{ queryKey: 'people', input: peopleQuery }], 2)
		);
		const initial = opened.queries[0]?.rows ?? [];
		expect(initial.map((row) => row['name'])).toEqual(['Ada', 'Grace']);

		const inserted = await mutateAndDrain(h, 'tab-a-insert', 'people', [
			{ name: 'Aaron', team: 'core' }
		]);
		await host.publish(inserted, writer);

		// Not a silent no-op: exactly one frame, carrying one fenced transition.
		expect(reader.frames).toHaveLength(1);
		const update = reader.frames[0]?.updates[0];
		expect(update).toMatchObject({ queryKey: 'people', fromVersion: 0, toVersion: 1 });
		if (update === undefined) throw new Error('the reader received no version update');
		// Not memory-only: applying the delta to the rows the reader holds reproduces exactly what a
		// fresh authoritative query returns. This is the RFC §9 central property, across the lane.
		expect(applyPrefixDelta(initial, update.delta)).toEqual(
			(await freshPeople(h, 's6-fresh')).slice(0, initial.length)
		);
		expect(host.lane.registry.prefixViewer(reader.connection, 'people')?.version).toBe(1);

		// And the fence advances rather than repeating: the next commit is 1 → 2 for both viewers.
		const updated = await mutateAndDrain(h, 'tab-a-update', 'people', [
			{ id: String(initial[0]?.['id']), team: 'edge' }
		]);
		await host.publish(updated, writer);
		expect(reader.frames).toHaveLength(2);
		expect(reader.frames[1]?.updates[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
		expect(writer.frames.at(-1)?.updates[0]).toMatchObject({ fromVersion: 1, toVersion: 2 });
		expect(host.lane.registry.prefixViewer(reader.connection, 'people')?.version).toBe(2);
	});

	it('resets rather than silently skipping when the answer can no longer be a delta', async () => {
		const h = await boot(['reader-token']);
		const host = makeLaneHost(h);
		const reader = host.open('reader', 'reader-token');
		await host.connect(reader, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		// The session behind the subscription is revoked, so the guest can no longer authenticate the
		// credential the subscription carries. S6's "or an explicit reset+reconnect" branch.
		await h.database.query(`delete from "session" where "token" = $1`, ['reader-token']);
		const changes = await mutateAndDrain(h, 'after-revoke', 'people', [
			{ name: 'Aaron', team: 'core' }
		]);

		await host.publish(changes);

		expect(reader.frames).toHaveLength(1);
		expect(reader.frames[0]?.updates).toEqual([]);
		expect(reader.frames[0]?.resets).toEqual([
			{ queryKey: 'people', reason: 'authority-changed' }
		]);
		// A reset retires the plan, so the browser reopens from PostgreSQL truth.
		expect(reader.connection.subscriptions.get('people')).toBeUndefined();
	});
});

describe('sync lane over the live runtime: fail-closed delivery (S7)', () => {
	it('closes a subscriber whose delivery fails while the commit itself stands', async () => {
		const h = await boot(['writer-token', 'reader-token']);
		const host = makeLaneHost(h);
		const writer = host.open('writer', 'writer-token');
		const reader = host.open('reader', 'reader-token');
		await host.connect(writer, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		await host.connect(reader, connectRequest([{ queryKey: 'people', input: peopleQuery }]));
		reader.refuseWrite();
		const changes = await mutateAndDrain(h, 's7-insert', 'people', [
			{ name: 'Aaron', team: 'core' }
		]);

		await host.publish(changes, writer);

		expect(reader.closes).toEqual(['guest-failed']);
		expect(host.lane.get('reader')).toBeUndefined();
		// The writer's own frame was accepted, so its mutation is genuinely settled — and the row is in
		// the database either way, which is why closing the reader is the only honest answer.
		expect(writer.frames).toHaveLength(1);
		expect((await freshPeople(h, 's7-fresh')).map((row) => row['name'])).toEqual([
			'Aaron',
			'Ada',
			'Grace',
			'Linus',
			'Mia'
		]);
	});
});
