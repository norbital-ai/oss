import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { vi, afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import * as WorkspaceSchema from '../../src/runtime/schema/workspace-schema.js';
import * as Workspace from '../../src/runtime/workspace.js';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import { createSyncClient } from '../../src/client/replica/sync-client.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import { createLocalReader } from '../../src/client/replica/local-reads.js';
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
 * the design rests on: that a snapshot plus the trigger-owned outbox converges on the server's state
 * regardless of which database writer produced a row.
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
	command: (command, input) => {
		const record =
			input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
		return Effect.tryPromise(() =>
			runtime.runtime.runPromise(
				Effect.gen(function* () {
					const sync = yield* Sync.Service;
					switch (command) {
						case 'sync.provisioning': {
							const plan = (yield* WorkspaceSchema.Service).plan();
							const workspace = yield* Workspace.Service;
							const steps = [
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
							];
							const provisioning = {
								steps,
								fingerprint: WorkspaceSchema.fingerprintSchemaSteps(steps),
								collections: workspace.definition.collections.map(({ name, fields }) => ({
									name,
									fields
								})),
								relations: workspace.definition.relations ?? []
							};
							return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
								JSON.stringify(provisioning)
							);
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
			)
		);
	}
});

const openReplica = async (runtime: BoltTestRuntime) =>
	Effect.runPromise(
		openLocalDatabase(transportFor(runtime), () =>
			Effect.tryPromise(() =>
				PGlite.create('memory://', {
					extensions: { pg_trgm, btree_gist, vector }
				})
			).pipe(
				Effect.tap((database) => Effect.sync(() => databases.push(database))),
				Effect.map(adaptPGlite)
			)
		)
	);

const localRows = async (
	replica: Awaited<ReturnType<typeof openReplica>>,
	input: Readonly<Record<string, unknown>>
): Promise<ReadonlyArray<Schema.Json>> => {
	const reader = createLocalReader(replica.store, replica.shape, replica.readable);
	const answer = await Effect.runPromise(reader.answer('collections.findMany', input as never));
	if (answer === undefined || answer === null || typeof answer !== 'object') return [];
	const rows = Reflect.get(answer, 'rows');
	return Array.isArray(rows) ? rows : [];
};

// Integration-grade: a real server plus an in-process pglite replica is CPU-heavy on CI
// runners; the default 15s budget flakes there while meaning nothing locally.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

describe('a browser replica against a real server', () => {
	it('snapshots seeded rows and continues from their trigger-captured outbox position', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId, database } = harness;

		// Written straight to the table, as a seed or an import does. Database-owned capture means the
		// outbox sees it without that writer knowing anything about sync.
		await database.query("insert into people (id, name, team) values ($1, 'Seeded', 'core')", [
			rid('seeded-1')
		]);
		expect(await database.query('select count(*)::int as count from bolt_sync_outbox', [])).toEqual(
			[{ count: 1 }]
		);

		const replica = await openReplica(harness);
		// The snapshot is what makes this row present; a log-only replica would call the workspace empty.
		expect(
			(await localRows(replica, { collection: 'people' })).map((row) => ({
				name: row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : row
			}))
		).toEqual([{ name: 'Seeded' }]);

		// Now a write through the ordinary collection path, captured by the same trigger.
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
		const client = await Effect.runPromise(
			createSyncClient({
				sink: {
					apply: (changes) => Effect.forEach(changes, replica.store.applyChange, { discard: true }),
					reset: replica.store.reset
				},
				initialCursor: replica.cursor
			})
		);
		// The host reads the outbox from this replica's cursor and puts each permission-filtered page on
		// the stream; the client applies the batches it receives. Walking that same path here keeps the
		// test on the production apply loop without standing up a network.
		const drain = async (): Promise<number> => {
			let applied = 0;
			for (;;) {
				const changes = await Effect.runPromise(
					transport
						.command('sync.diff', { cursor: client.cursor(), limit: 200 })
						.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Sync.SyncChange))))
				);
				if (changes.length === 0) return applied;
				applied += await Effect.runPromise(client.apply(changes));
				if (changes.length < 200) return applied;
			}
		};
		expect(await drain()).toBeGreaterThan(0);

		// Converged: the seeded row and the streamed one, with the update merged onto it.
		expect(
			(
				await localRows(replica, {
					collection: 'people',
					orderBy: { name: 'asc' }
				})
			).map((row) => ({
				name: row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : row
			}))
		).toEqual([{ name: 'Ada Lovelace' }, { name: 'Seeded' }]);

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
		await drain();
		expect(
			(
				await localRows(replica, {
					collection: 'people',
					orderBy: { name: 'asc' }
				})
			).map((row) => ({
				name: row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : row
			}))
		).toEqual([{ name: 'Seeded' }]);
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

		const local = await localRows(replica, {
			collection: 'people',
			where: { team: { eq: 'flight' } },
			orderBy: { name: 'asc' }
		});
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

	it('replaces a divergent projection with a current server snapshot', async () => {
		harness = await makeBoltTestRuntime();
		const { runtime, effectId } = harness;
		const replica = await openReplica(harness);

		await Effect.runPromise(
			replica.store.applyChange({
				cursor: { xid: 1, sequence: 1 },
				collection: 'people',
				recordId: rid('local-only'),
				operation: 'create',
				record: { name: 'Local only', team: 'stale' }
			})
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(effectId('server-only'), adminSubject, {
					collection: 'people',
					id: rid('server-only'),
					values: { name: 'Server only', team: 'current' }
				});
			})
		);

		await Effect.runPromise(replica.resnapshot());
		expect(
			(
				await localRows(replica, {
					collection: 'people',
					orderBy: { name: 'asc' }
				})
			).map((row) => ({
				name: row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : row
			}))
		).toEqual([{ name: 'Server only' }]);
	});
});
