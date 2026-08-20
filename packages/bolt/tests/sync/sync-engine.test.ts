import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { Collections } from '../../src/runtime/collections/collections.js';
import { Sync } from '../../src/runtime/sync/sync.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * A valid record id for a readable fixture name.
 *
 * Records are keyed by `norbital_id uuid`. Names like `'person-1'` were only ever accepted by the
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

		const rows = await database.query(
			'select norbital_id, name, team from people where norbital_id = $1',
			[rid('p9')]
		);
		expect(rows).toEqual([{ norbital_id: rid('p9'), name: 'Katherine', team: 'flight' }]);

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
		expect(
			await database.query('select team from people where norbital_id = $1', [rid('p1')])
		).toEqual([{ team: 'analytical' }]);

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
		expect(
			await database.query('select norbital_id from people where norbital_id = $1', [rid('p1')])
		).toEqual([]);
	});

	it('refuses a mutation the subject may not perform, and writes nothing', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		const outsider = { userId: 'guest-1', tenantId: 'test-tenant', teamPath: ['guest'] };

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
		expect(await database.query('select norbital_id from people')).toEqual([]);
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
		const mark = await database.query('select xid, sequence from bolt_sync_horizon where id', []);
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

	it('serves a snapshot of seeded rows the log never saw, with a cursor to stream on from', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;
		// Written straight to the table, exactly as a seed, an import or a restore does — so the outbox
		// knows nothing about it and a log-only replica would call this workspace empty.
		await database.query(
			"insert into people (norbital_id, name, team) values ($1, 'Seeded', 'core')",
			[rid('seeded-1')]
		);
		const outboxed = await database.query(
			'select count(*)::int as count from bolt_sync_outbox',
			[]
		);
		expect(outboxed[0]?.count).toBe(0);

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
		const outsider = { userId: 'guest-1', tenantId: 'test-tenant', teamPath: ['guest'] };
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
			// `document_asset` replicates with them: a `file()` column is a uuid whose row lives here, and
			// the renderer resolves it client-side, so a surface that cannot replicate it shows an empty
			// file. It is not one of the identity collections, which stay out of the shape deliberately.
		).toEqual(['approval_request', 'document_asset', 'people', 'requestor']);
		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Sync.Service).shape(outsider);
				})
			)
		).toEqual([]);
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
