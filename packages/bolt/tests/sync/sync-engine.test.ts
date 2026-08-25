import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectId, success, type TransportRequest } from '@norbital-ai/bolt-protocol';
import { approveBy } from '../../src/authoring/approval-flow.js';
import { describePolicy } from '../../src/authoring/policy-introspection.js';
import { policy } from '../../src/authoring/workspace-schema.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import { decodeWake, SYNC_TOPIC } from '../../src/runtime/sync/wake.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * A valid record id for a readable fixture name.
 *
 * Records are keyed by `id uuid`. Names like `'person-1'` were only ever accepted by the
 * `id text` primary key Bolt used to invent, so these fixtures built rows a real database would have
 * rejected — and passed anyway.
 */
const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const field = (row: Schema.Json, name: string): unknown =>
	row !== null && typeof row === 'object' && !Array.isArray(row)
		? Reflect.get(row, name)
		: undefined;

type Published = { readonly topic: string; readonly collections: ReadonlyArray<string> };

/** A mounted client has its own cursor even when another tab has already drained the same write. */
type MountedClient = Readonly<{
	readonly subject: Identity.Subject;
	readonly cursor: Sync.SyncCursor;
}>;

const drainMountedClient = (
	runtime: BoltTestRuntime,
	client: MountedClient,
	name: string
): Promise<
	Readonly<{
		client: MountedClient;
		changes: ReadonlyArray<Sync.SyncChange>;
	}>
> =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const changes = yield* (yield* Sync.Service).diff(
				runtime.effectId(`mounted-${name}`),
				client.subject,
				client.cursor,
				100
			);
			return {
				client: { ...client, cursor: changes.at(-1)?.cursor ?? client.cursor },
				changes
			};
		})
	);

describe('Sync engine over SQL', () => {
	it('advances the head as collection writes land, and replays them in order from a cursor', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;

		const start = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).head(effectId('head-empty'));
			})
		);
		expect(start).toEqual({ xid: 0, sequence: 0 });

		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('create-ada'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
				yield* collections.create(effectId('create-grace'), adminSubject, {
					collection: 'people',
					id: rid('p2'),
					values: { name: 'Grace', team: 'core' }
				});
				yield* collections.update(effectId('rename-ada'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada Lovelace' }
				});
			})
		);

		const head = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).head(effectId('head-after'));
			})
		);
		expect(head.sequence).toBeGreaterThan(0);

		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff'),
					adminSubject,
					{ xid: 0, sequence: 0 },
					100
				);
			})
		);
		expect(changes.map((change) => [change.collection, change.recordId, change.operation])).toEqual(
			[
				['people', rid('p1'), 'create'],
				['people', rid('p2'), 'create'],
				['people', rid('p1'), 'update']
			]
		);

		// Resuming from a cursor replays only what came after it.
		const first = changes[0];
		if (first === undefined) throw new Error('expected a first change');
		const resumed = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff-resumed'),
					adminSubject,
					first.cursor,
					100
				);
			})
		);
		expect(resumed.map((change) => change.recordId)).toEqual([rid('p2'), rid('p1')]);
	});

	it('applies a client mutation to the collection it names, not to a queue nothing reads', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).mutate(effectId('mutate'), adminSubject, [
					{
						cursor: { xid: 0, sequence: 0 },
						collection: 'people',
						recordId: rid('p9'),
						operation: 'create',
						record: { name: 'Katherine', team: 'flight' }
					}
				]);
			})
		);

		const rows = await database.query('select id, name, team from people where id = $1', [
			rid('p9')
		]);
		expect(rows).toEqual([{ id: rid('p9'), name: 'Katherine', team: 'flight' }]);

		// The write is replicable: a client that applied it optimistically sees it confirmed.
		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff-after-mutate'),
					adminSubject,
					{ xid: 0, sequence: 0 },
					100
				);
			})
		);
		expect(
			changes.some((change) => change.recordId === rid('p9') && change.operation === 'create')
		).toBe(true);
	});

	it('applies update and delete mutations through the same path', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const sync = yield* Sync.Service;
				yield* sync.mutate(effectId('m1'), adminSubject, [
					{
						cursor: { xid: 0, sequence: 0 },
						collection: 'people',
						recordId: rid('p1'),
						operation: 'create',
						record: { name: 'Ada', team: 'core' }
					}
				]);
				yield* sync.mutate(effectId('m2'), adminSubject, [
					{
						cursor: { xid: 0, sequence: 0 },
						collection: 'people',
						recordId: rid('p1'),
						operation: 'update',
						record: { team: 'analytical' }
					}
				]);
			})
		);
		expect(await database.query('select team from people where id = $1', [rid('p1')])).toEqual([
			{ team: 'analytical' }
		]);
		const updateEvent = await database.query(
			"select record from bolt_sync_outbox where collection_name = 'people' and operation = 'update' order by xid desc, sequence desc limit 1"
		);
		expect(updateEvent[0]?.['record']).toMatchObject({
			id: rid('p1'),
			name: 'Ada',
			team: 'analytical'
		});

		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).mutate(effectId('m3'), adminSubject, [
					{
						cursor: { xid: 0, sequence: 0 },
						collection: 'people',
						recordId: rid('p1'),
						operation: 'delete'
					}
				]);
			})
		);
		expect(await database.query('select id from people where id = $1', [rid('p1')])).toEqual([]);
	});

	it('refuses a mutation the subject may not perform, and writes nothing', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		const outsider = {
			userId: 'guest-1',
			tenantId: 'test-tenant',
			teamPath: ['guest'],
			policies: []
		};

		const outcome = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).mutate(effectId('denied'), outsider, [
					{
						cursor: { xid: 0, sequence: 0 },
						collection: 'people',
						recordId: rid('p1'),
						operation: 'create',
						record: { name: 'Mallory' }
					}
				]);
			}).pipe(Effect.result)
		);
		expect(outcome._tag).toBe('Failure');
		expect(await database.query('select id from people')).toEqual([]);
	});

	it('reports a reset when the requested cursor is older than the retained outbox', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('c1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada' }
				});
				yield* collections.create(effectId('c2'), adminSubject, {
					collection: 'people',
					id: rid('p2'),
					values: { name: 'Grace' }
				});
			})
		);
		// Aged past the retention window so `compact` prunes it for the reason production would.
		await database.query(
			"update bolt_sync_outbox set created_at = now() - interval '40 days' where record_id = $1",
			[rid('p1')]
		);
		const removed = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).compact(effectId('compact'), 30);
			})
		);
		expect(removed.pruned).toBe(1);

		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff-reset'),
					adminSubject,
					{ xid: 1, sequence: 1 },
					100
				);
			})
		);
		expect(changes.map((change) => change.operation)).toEqual(['reset']);
	});

	it('collapses superseded versions without stranding any cursor', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('c1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada' }
				});
				yield* collections.update(effectId('u1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada L' }
				});
				yield* collections.update(effectId('u2'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada Lovelace' }
				});
			})
		);
		const outcome = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).compact(effectId('compact'), 30);
			})
		);
		// Two of the three rows for this record are superseded; the newest survives.
		expect(outcome.collapsed).toBe(2);
		expect(outcome.pruned).toBe(0);

		// Collapsing is safe at any cursor, so the mark must not have moved and a replay from the
		// origin must still converge on the final state rather than being told to rebuild.
		const mark = await database.query(
			'select xid, sequence from bolt_sync_horizon where singleton',
			[]
		);
		expect(mark[0]).toMatchObject({ xid: 0, sequence: 0 });
		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('replay'),
					adminSubject,
					{ xid: 0, sequence: 0 },
					100
				);
			})
		);
		expect(changes).toHaveLength(1);
		expect(field(changes[0]?.record ?? null, 'name')).toBe('Ada Lovelace');
	});

	it('serves a snapshot of seeded rows with a cursor beyond their captured change', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		// Written straight to the table, exactly as a seed, an import or a restore does. Database-owned
		// capture means this path cannot bypass sync just because it did not call Collections.
		await database.query("insert into people (id, name, team) values ($1, 'Seeded', 'core')", [
			rid('seeded-1')
		]);
		const outboxed = await database.query(
			'select count(*)::int as count from bolt_sync_outbox',
			[]
		);
		expect(outboxed[0]?.count).toBe(1);

		const page = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).snapshot(
					effectId('snap'),
					adminSubject,
					'people',
					undefined,
					500
				);
			})
		);
		expect(page.collection).toBe('people');
		expect(page.rows).toHaveLength(1);
		expect(field(page.rows[0] ?? null, 'name')).toBe('Seeded');
		expect(page.nextAfter).toBeNull();

		// A write after the snapshot must be reachable from the cursor the snapshot handed back.
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('after'), adminSubject, {
					collection: 'people',
					id: rid('after-1'),
					values: { name: 'Later', team: 'core' }
				});
			})
		);
		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('after-diff'),
					adminSubject,
					page.cursor,
					100
				);
			})
		);
		expect(changes.map((change) => field(change.record ?? null, 'name'))).toEqual(['Later']);
	});

	it('replicates only the collections the subject may read', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		const outsider = {
			userId: 'guest-1',
			tenantId: 'test-tenant',
			teamPath: ['guest'],
			policies: []
		};
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('c1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada' }
				});
			})
		);

		// Runtime-owned collections replicate too: the UI reads approval status from `approval_request`.
		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).shape(adminSubject);
				})
			)
			// No file collection replicates with them. A `file()` column carries the file inline, so it
			// arrives with the record that owns it and there is nothing separate to bulk-replicate —
			// which also stops every file's metadata in the workspace landing in every browser.
		).toEqual([
			'agent_mailbox',
			'agent_run',
			'approval_request',
			'automation_run',
			'bolt_notifications',
			'chat_document',
			'chat_message',
			'chat_session',
			'people',
			'requestor',
			'team',
			'user'
		]);
		/**
		 * The authored collection is what an outsider does not replicate; runtime collections remain
		 * are what they do.
		 *
		 * This used to assert `[]`, and that was the defect rather than the rule: `SYSTEM_READ_POLICY`
		 * grants these reads to any authenticated subject, but nothing selected it — no team can
		 * declare `bolt.system-collections` — so only the `isAdministrator` short-circuit reached them
		 * and every ordinary member replicated an empty shape. The same argument the admin case above
		 * makes applies to a member: approval rows are scoped to their parties, while the user/team
		 * directories are field-masked to `id` and `name`.
		 *
		 * `people` staying out is what carries the test. An outsider holds no authored policy, and the
		 * built-in grant names the runtime's collections and no workspace's.
		 *
		 * **A shape is a list of collections, not a licence over their rows**, and the two answers
		 * moved apart when `approval_request` and `requestor` became conditional. `shape` filters on
		 * `predicate.allowed`, and a narrowed grant is still *allowed* — it carries a `where` instead
		 * of `true` — so both still appear here and both are row-filtered on the way out by the same
		 * predicate `diff` and `snapshot` splice into their SQL. The case below is what pins that
		 * second half; asserting only this list would read as "an outsider replicates every approval".
		 */
		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).shape(outsider);
				})
			)
		).toEqual([
			'agent_mailbox',
			'agent_run',
			'approval_request',
			'automation_run',
			'bolt_notifications',
			'chat_document',
			'chat_message',
			'chat_session',
			'requestor',
			'team',
			'user'
		]);
		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).diff(
						effectId('diff-guest'),
						outsider,
						{ xid: 0, sequence: 0 },
						100
					);
				})
			)
		).toEqual([]);
	});

	/**
	 * The rows behind the shape: a replica pulls the approvals its subject is party to or may decide,
	 * and no others.
	 *
	 * Asserted through `snapshot` rather than `diff` because `bolt_sync_outbox` is written by
	 * `Collections` alone — `Approvals` projects `approval_request` with its own SQL, so an approval
	 * never produces a change row and a `diff` assertion here would pass against any predicate at
	 * all. `snapshot` is the half of replication that reads the table, and it splices in exactly the
	 * predicate `diff` correlates through.
	 *
	 * The approver holds no authored policy whatsoever — `Approvers` is declared with an empty policy
	 * list — so what admits their read is the built-in grant and nothing else.
	 */
	it('replicates only the approvals a subject raised or may decide', async () => {
		const CONTRACTOR_TEAM = 'Contractors';
		const APPROVER_TEAM = 'Approvers';
		const REQUEST_ID = '019f6f10-0004-7000-8000-000000000001';
		const concreteApproval = {
			id: '019f6f10-0004-7000-8000-000000000101',
			steps: [
				{
					id: '019f6f10-0004-7000-8000-000000000201',
					approvers: [APPROVER_TEAM]
				}
			],
			superceded_by: []
		};
		harness = await makeBoltTestRuntime(
			testWorkspace({
				policies: [
					policy({
						name: 'contractor',
						effect: 'allow',
						capabilities: { apps: ['*'] },
						grants: [
							{ collection: 'people', action: 'read' },
							{
								collection: 'people',
								action: 'create',
								approval: concreteApproval
							}
						]
					})
				],
				teams: { [CONTRACTOR_TEAM]: ['contractor'], [APPROVER_TEAM]: [] }
			})
		);
		const { runtime, effectId } = harness;
		await seedTeam(harness, CONTRACTOR_TEAM);
		await seedTeam(harness, APPROVER_TEAM);
		await seedSession(harness, { token: 'p', user: 'party', team: CONTRACTOR_TEAM });
		await seedSession(harness, { token: 'a', user: 'approver', team: APPROVER_TEAM });
		await seedSession(harness, { token: 'b', user: 'bystander', team: CONTRACTOR_TEAM });
		const member = (user: string, team: string): Identity.Subject => ({
			userId: fixtureUserId(user),
			tenantId: 'test-tenant',
			teamPath: [team],
			policies: []
		});
		const party = member('party', CONTRACTOR_TEAM);
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).request(effectId('raise'), party, REQUEST_ID, {
					collection: 'people',
					id: rid('p-approved'),
					action: 'create',
					values: { name: 'Grace' },
					approval: concreteApproval
				});
			})
		);
		const replicated = (subject: Identity.Subject, collection: string) =>
			runtime.runPromise(
				Effect.gen(function* () {
					const page = yield* (yield* Sync.Service).snapshot(
						effectId(`snapshot-${subject.userId}-${collection}`),
						subject,
						collection,
						undefined,
						100
					);
					return page.rows.map((row) => field(row, 'id'));
				})
			);

		expect(await replicated(party, 'approval_request')).toEqual([REQUEST_ID]);
		expect(await replicated(member('approver', APPROVER_TEAM), 'approval_request')).toEqual([
			REQUEST_ID
		]);
		// The row exists and two other subjects replicate it, so an empty page here is a narrowing
		// rather than an empty table — the assertion a collapsed `true` predicate could not survive.
		expect(await replicated(member('bystander', CONTRACTOR_TEAM), 'approval_request')).toEqual([]);
		expect(await replicated(adminSubject, 'approval_request')).toEqual([REQUEST_ID]);
		expect(await replicated(member('bystander', CONTRACTOR_TEAM), 'requestor')).toEqual([]);
		expect(await replicated(party, 'requestor')).toHaveLength(1);
		expect(await replicated(adminSubject, 'requestor')).toHaveLength(1);
	});

	it('publishes a declarative create approval to two mounted inboxes and resumes it atomically', async () => {
		const REQUESTER_TEAM = 'Requesters';
		const APPROVER_TEAM = 'Approvers';
		const published: Array<Published> = [];
		harness = await makeBoltTestRuntime(
			testWorkspace({
				policies: [
					describePolicy('requester', {
						description: 'Creates people through the approver team.',
						grants: {
							people: {
								read: {},
								create: {
									approval: {
										flow: () => approveBy(APPROVER_TEAM),
										superceded_by: []
									}
								}
							}
						}
					}),
					describePolicy('reviewer', {
						description: 'Reads people under review.',
						grants: { people: { read: {} } }
					})
				],
				teams: { [REQUESTER_TEAM]: ['requester'], [APPROVER_TEAM]: ['reviewer'] }
			}),
			{
				transport: {
					call: async (_metadata: unknown, request: TransportRequest) => {
						if (request._tag === 'Publish')
							published.push({
								topic: request.topic,
								collections: decodeWake(request.bytes).collections
							});
						return success({ delivered: 2 });
					}
				} as never
			}
		);
		await seedSession(harness, { token: 'requester', user: 'requester', team: REQUESTER_TEAM });
		await seedSession(harness, { token: 'approver', user: 'approver', team: APPROVER_TEAM });
		await harness.database.query('delete from bolt_sync_outbox');
		published.length = 0;
		const requester: Identity.Subject = {
			userId: fixtureUserId('requester'),
			tenantId: 'test-tenant',
			teamPath: [REQUESTER_TEAM],
			policies: []
		};
		const approver: Identity.Subject = {
			userId: fixtureUserId('approver'),
			tenantId: 'test-tenant',
			teamPath: [APPROVER_TEAM],
			policies: []
		};
		let requesterClient: MountedClient = { subject: requester, cursor: { xid: 0, sequence: 0 } };
		let approverClient: MountedClient = { subject: approver, cursor: { xid: 0, sequence: 0 } };

		const held = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('mounted-approval-create'),
						requester,
						'people',
						[{ name: 'Awaiting review', team: 'core' }],
						false,
						0,
						{ declarative: true }
					);
				})
			)
		);
		expect(held).toBeInstanceOf(Collections.PendingApproval);
		if (!(held instanceof Collections.PendingApproval)) return;

		// A pending graph is discoverable by request id, never through an uncommitted root row.
		expect(await harness.database.query('select id from people')).toEqual([]);
		expect(
			await harness.database.query(
				'select collection_name, record_id, action, status from approval_request where id = $1',
				[held.requestId]
			)
		).toEqual([
			expect.objectContaining({
				collection_name: 'people',
				action: 'create',
				status: 'ONGOING'
			})
		]);
		expect(
			await harness.database.query(
				'select approval_request_id, user_id from requestor where approval_request_id = $1',
				[held.requestId]
			)
		).toEqual([{ approval_request_id: held.requestId, user_id: requester.userId }]);
		expect(
			await harness.database.query(
				'select collection_name, operation from bolt_sync_outbox order by sequence'
			)
		).toEqual([
			{ collection_name: 'approval_request', operation: 'create' },
			{ collection_name: 'requestor', operation: 'create' }
		]);
		expect(published).toEqual([
			{ topic: SYNC_TOPIC, collections: ['approval_request', 'requestor'] }
		]);

		const requesterRequest = await drainMountedClient(
			harness,
			requesterClient,
			'requester-request'
		);
		requesterClient = requesterRequest.client;
		const approverRequest = await drainMountedClient(harness, approverClient, 'approver-request');
		approverClient = approverRequest.client;
		for (const changes of [requesterRequest.changes, approverRequest.changes]) {
			expect(changes.map(({ collection, operation }) => [collection, operation])).toEqual([
				['approval_request', 'create'],
				['requestor', 'create']
			]);
			expect(field(changes[0]?.record ?? null, 'id')).toBe(held.requestId);
			expect(field(changes[0]?.record ?? null, 'status')).toBe('ONGOING');
			expect(field(changes[1]?.record ?? null, 'approval_request_id')).toBe(held.requestId);
		}

		const pending = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(
					EffectId.make('mounted-approval-status'),
					held.requestId
				);
			})
		);
		expect(pending?._tag).toBe('Pending');
		if (pending === undefined) return;
		const decided = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).decide(
					EffectId.make('mounted-approval-decide'),
					approver,
					pending,
					'approve'
				);
			})
		);
		expect(decided._tag).toBe('Approved');
		// A decision updates the inbox first. The approved graph is still absent until its queued resume.
		expect(await harness.database.query('select id from people')).toEqual([]);
		expect(
			await harness.database.query(
				'select collection_name, operation from bolt_sync_outbox order by sequence'
			)
		).toEqual([
			{ collection_name: 'approval_request', operation: 'create' },
			{ collection_name: 'requestor', operation: 'create' },
			{ collection_name: 'bolt_notifications', operation: 'create' },
			{ collection_name: 'approval_request', operation: 'update' }
		]);
		expect(published.at(-1)).toEqual({
			topic: SYNC_TOPIC,
			collections: ['approval_request', 'bolt_notifications']
		});

		const requesterDecision = await drainMountedClient(
			harness,
			requesterClient,
			'requester-decision'
		);
		requesterClient = requesterDecision.client;
		const approverDecision = await drainMountedClient(harness, approverClient, 'approver-decision');
		approverClient = approverDecision.client;
		expect(
			requesterDecision.changes.map(({ collection, operation }) => [collection, operation])
		).toEqual([
			['bolt_notifications', 'create'],
			['approval_request', 'update']
		]);
		expect(field(requesterDecision.changes[0]?.record ?? null, 'recipient')).toBe(requester.userId);
		expect(field(requesterDecision.changes[0]?.record ?? null, 'read')).toBe(false);
		expect(field(requesterDecision.changes[1]?.record ?? null, 'status')).toBe('APPROVED');
		expect(
			approverDecision.changes.map(({ collection, operation }) => [collection, operation])
		).toEqual([['approval_request', 'update']]);
		expect(field(approverDecision.changes[0]?.record ?? null, 'status')).toBe('APPROVED');

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).resume(
					EffectId.make('mounted-approval-resume'),
					held.requestId
				);
			})
		);
		expect(await harness.database.query('select name, team from people')).toEqual([
			{ name: 'Awaiting review', team: 'core' }
		]);
		expect(published.at(-1)).toEqual({ topic: SYNC_TOPIC, collections: ['people'] });

		const requesterResume = await drainMountedClient(harness, requesterClient, 'requester-resume');
		const approverResume = await drainMountedClient(harness, approverClient, 'approver-resume');
		for (const changes of [requesterResume.changes, approverResume.changes]) {
			expect(changes.map(({ collection, operation }) => [collection, operation])).toEqual([
				['people', 'create']
			]);
			expect(field(changes[0]?.record ?? null, 'name')).toBe('Awaiting review');
		}
	}, 60_000);

	it('carries the record body so a replica can apply a change without refetching', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).create(effectId('c1'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
			})
		);
		const changes = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Sync.Service).diff(
					effectId('diff'),
					adminSubject,
					{ xid: 0, sequence: 0 },
					100
				);
			})
		);
		const change = changes[0];
		if (change === undefined) throw new Error('expected a change');
		expect(field(change.record ?? null, 'name')).toBe('Ada');
	});
});
