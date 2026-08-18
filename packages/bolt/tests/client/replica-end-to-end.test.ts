import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { Collections } from '../../src/runtime/collections/collections.js';
import { Sync } from '../../src/runtime/sync/sync.js';
import { WorkspaceSchema } from '../../src/runtime/schema/workspace-schema.js';
import { Workspace } from '../../src/runtime/workspace.js';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import { createSyncClient } from '../../src/client/replica/sync-client.js';
import type { PGliteLike } from '../../src/client/replica/pglite-sql.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The whole sync engine, end to end, with no stand-ins on either side.
 *
 * A real server runtime over a real PostgreSQL, and a real client replica over a second real
 * PostgreSQL provisioned from the first one's own DDL. What this is actually checking is the property
 * the design rests on: that a replica built this way converges on the server's state, including the
 * rows the outbox never saw.
 */

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

let harness: BoltTestRuntime | undefined;
const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
	await harness?.dispose();
	harness = undefined;
});

/** The client's transport, wired straight into the server runtime rather than over HTTP. */
const transportFor = (runtime: BoltTestRuntime): BootstrapTransport => ({
	command: async (command, input) => {
		const record =
			input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
		return runtime.runtime.runPromise(
			Effect.gen(function* () {
				const sync = yield* Sync.Service;
				switch (command) {
					case 'sync.provisioning': {
						const plan = (yield* WorkspaceSchema.Service).plan();
						const workspace = yield* Workspace.Service;
						return {
							steps: [
								...plan.steps
									.filter(({ id }) => id.startsWith('bolt:'))
									.map(({ id, sql }) => ({ id, sql })),
								...[...(workspace.definition.migrations ?? [])]
									.toSorted((left, right) => left.tag.localeCompare(right.tag))
									.flatMap((entry) =>
										entry.statements.map((sql, index) => ({
											id: `lineage:${entry.tag}:${index}`,
											sql
										}))
									),
								...plan.steps
									.filter(({ id }) => !id.startsWith('bolt:'))
									.map(({ id, sql }) => ({ id, sql }))
							],
							fingerprint: plan.fingerprint
						} as Schema.Json;
					}
					case 'sync.shape':
						return (yield* sync.shape(adminSubject)) as unknown as Schema.Json;
					case 'sync.snapshot':
						return (yield* sync.snapshot(
							runtime.effectId(
								`snapshot:${String(Reflect.get(record, 'collection'))}:${String(Reflect.get(record, 'after') ?? 'first')}`
							),
							adminSubject,
							String(Reflect.get(record, 'collection')),
							typeof Reflect.get(record, 'after') === 'string'
								? String(Reflect.get(record, 'after'))
								: undefined,
							Number(Reflect.get(record, 'limit') ?? 500)
						)) as unknown as Schema.Json;
					case 'sync.diff': {
						const cursor = Reflect.get(record, 'cursor');
						const position =
							cursor !== null && typeof cursor === 'object'
								? {
										xid: Number(Reflect.get(cursor, 'xid') ?? 0),
										sequence: Number(Reflect.get(cursor, 'sequence') ?? 0)
									}
								: { xid: 0, sequence: 0 };
						return (yield* sync.diff(
							runtime.effectId(`diff:${position.xid}:${position.sequence}`),
							adminSubject,
							position,
							Number(Reflect.get(record, 'limit') ?? 500)
						)) as unknown as Schema.Json;
					}
					default:
						throw new Error(`unexpected command ${command}`);
				}
			})
		);
	}
});

const openReplica = async (runtime: BoltTestRuntime) =>
	openLocalDatabase(transportFor(runtime), async () => {
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		databases.push(database);
		return database as unknown as PGliteLike;
	});

describe('a browser replica against a real server', () => {
	it('holds the seeded rows the outbox never saw, and streams the writes that follow', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;

		// Written straight to the table, as a seed or an import does. The outbox knows nothing about it.
		await database.query(
			"insert into people (norbital_id, name, team) values ($1, 'Seeded', 'core')",
			[rid('seeded-1')]
		);
		expect(await database.query('select count(*)::int as count from bolt_sync_outbox', [])).toEqual(
			[{ count: 0 }]
		);

		const replica = await openReplica(harness);
		// The snapshot is what makes this row present; a log-only replica would call the workspace empty.
		expect(await replica.sql.query('select name from people', [])).toEqual([{ name: 'Seeded' }]);

		// Now a write through the real write path, which does reach the outbox.
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('create'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
				yield* collections.update(effectId('rename'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada Lovelace' }
				});
			})
		);

		const transport = transportFor(harness);
		const client = createSyncClient({
			transport: {
				head: async () => ({ xid: 0, sequence: 0 }),
				diff: async (cursor, limit) =>
					(await transport.command('sync.diff', { cursor, limit })) as never
			},
			sink: {
				apply: async (changes) => {
					for (const change of changes)
						await replica.sql.applyChange(change as unknown as Schema.Json);
				},
				reset: async () => replica.sql.reset()
			},
			initialCursor: replica.cursor
		});
		expect(await client.drain()).toBeGreaterThan(0);

		// Converged: the seeded row and the streamed one, with the update merged onto it.
		expect(await replica.sql.query('select name from people order by name', [])).toEqual([
			{ name: 'Ada Lovelace' },
			{ name: 'Seeded' }
		]);

		// And a delete propagates too.
		await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).delete(
					effectId('delete'),
					adminSubject,
					'people',
					rid('p1')
				);
			})
		);
		await client.drain();
		expect(await replica.sql.query('select name from people order by name', [])).toEqual([
			{ name: 'Seeded' }
		]);
	});

	it('answers a relational query locally with the same rows the server returns', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		await runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(effectId('a'), adminSubject, {
					collection: 'people',
					id: rid('p1'),
					values: { name: 'Ada', team: 'core' }
				});
				yield* collections.create(effectId('b'), adminSubject, {
					collection: 'people',
					id: rid('p2'),
					values: { name: 'Grace', team: 'flight' }
				});
				yield* collections.create(effectId('c'), adminSubject, {
					collection: 'people',
					id: rid('p3'),
					values: { name: 'Katherine', team: 'flight' }
				});
			})
		);
		const replica = await openReplica(harness);

		const local = await replica.sql.query('select name from people where team = $1 order by name', [
			'flight'
		]);
		const server = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(effectId('server-read'), adminSubject, {
					collection: 'people',
					where: { team: { eq: 'flight' } },
					orderBy: { name: 'asc' }
				});
			})
		);
		// The same question, answered by two PostgreSQLs holding the same schema and the same rows.
		// Compared on the values rather than the row shape: the server's read returns whole records,
		// and what is under test is that the predicate and the ordering agree, not the projection.
		const names = (rows: ReadonlyArray<Schema.Json>): ReadonlyArray<unknown> =>
			rows.map((row) => (row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : row));
		expect(names(local)).toEqual(names(server));
		expect(names(local)).toEqual(['Grace', 'Katherine']);
	});
});
