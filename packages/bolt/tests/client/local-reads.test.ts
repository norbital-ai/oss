import { createHash } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import * as Collections from '../../src/runtime/collections/collections.js';
import * as Sync from '../../src/runtime/sync/sync.js';
import * as WorkspaceSchema from '../../src/runtime/schema/workspace-schema.js';
import * as Workspace from '../../src/runtime/workspace.js';
import { openLocalDatabase, type BootstrapTransport } from '../../src/client/replica/bootstrap.js';
import { createLocalReader } from '../../src/client/replica/local-reads.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import type { LocalReplicaStore } from '../../src/client/replica/pglite-sql.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * The claim the local read path rests on: it answers what the server would have answered.
 *
 * Every case here asks the same question twice — once of the real Collections service over the real
 * server database, once of the replica — and compares. A local read that is merely close is worse
 * than a remote read that is correct, because the difference shows up as a page that changes
 * depending on whether the replica happened to be warm.
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
									fields,
									readableFields: null
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

/** Rows as the server would return them, through the real Collections service. */
const serverRows = (runtime: BoltTestRuntime, input: Record<string, unknown>) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).findMany(
				runtime.effectId(`read:${JSON.stringify(input)}`),
				adminSubject,
				input as never
			);
		})
	);

const seed = async (runtime: BoltTestRuntime) => {
	await runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			for (const [index, person] of [
				{ name: 'Ada', team: 'core' },
				{ name: 'Grace', team: 'flight' },
				{ name: 'Katherine', team: 'flight' },
				{ name: 'Annie', team: 'core' }
			].entries()) {
				yield* collections.create(runtime.effectId(`create:${index}`), adminSubject, {
					collection: 'people',
					id: rid(`p${index}`),
					values: person
				});
			}
		})
	);
};

const seedPaginatedCollection = async (runtime: BoltTestRuntime) => {
	await runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				runtime.effectId('create:paginated'),
				adminSubject,
				'people',
				Array.from({ length: 40 }, (_, index) => ({
					name: `Person ${String(index).padStart(2, '0')}`,
					...(index % 10 === 0 ? {} : { team: index % 2 === 0 ? 'core' : 'flight' })
				}))
			);
		})
	);
};

describe('reads answered by the replica', () => {
	it('declines masked nullable orderings before they can mint a dishonest cursor', async () => {
		let reads = 0;
		const rows = [
			{ id: rid('masked-order:1'), name: 'Zulu', rank: null },
			{ id: rid('masked-order:2'), name: 'Alpha', rank: null }
		];
		const store: LocalReplicaStore = {
			findMany: ({ limit }) =>
				Effect.sync(() => {
					reads += 1;
					return rows.slice(0, limit);
				}),
			count: () => Effect.succeed(rows.length),
			applySnapshot: () => Effect.succeed(0),
			applyChange: () => Effect.void,
			reset: () => Effect.void
		};
		const reader = createLocalReader(
			store,
			{
				collections: [
					{
						name: 'people',
						fields: {
							name: { type: 'string', required: true, indexed: false },
							rank: { type: 'number', required: false, indexed: false }
						},
						readableFields: ['id', 'name']
					}
				],
				relations: []
			},
			new Set(['people'])
		);

		const DefaultPage = Schema.Struct({
			rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
			nextCursor: Schema.NullOr(Schema.String)
		});
		const byId = Schema.decodeUnknownSync(DefaultPage)(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people', limit: 1 })
			)
		);
		expect(byId.nextCursor).toEqual(expect.any(String));
		const byVisibleName = Schema.decodeUnknownSync(DefaultPage)(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' },
					limit: 1
				})
			)
		);
		expect(byVisibleName.nextCursor).toEqual(expect.any(String));

		// This is the token the old local path could cut from the replica's rehydrated SQL null. The
		// server orders by the real rank, masks rank from its answer, and therefore cannot issue it.
		const dishonest = Collections.encodeCollectionCursor(
			[
				{ column: 'rank', direction: 'asc' },
				{ column: 'id', direction: 'asc' }
			],
			rows[0] as never
		);
		expect(dishonest).toEqual(expect.any(String));
		if (dishonest === null) throw new Error('expected the old local cursor candidate');
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { rank: 'asc' },
					limit: 1
				})
			)
		).toBeUndefined();
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					orderBy: { rank: 'asc' },
					after: dishonest,
					limit: 1
				})
			)
		).toBeUndefined();

		const olderShapeReader = createLocalReader(
			store,
			{
				collections: [
					{
						name: 'people',
						fields: {
							name: { type: 'string', required: true, indexed: false },
							rank: { type: 'number', required: false, indexed: false }
						}
					}
				],
				relations: []
			},
			new Set(['people'])
		);
		expect(
			await Effect.runPromise(
				olderShapeReader.answer('collections.findMany', { collection: 'people', limit: 1 })
			)
		).toBeUndefined();
		// The masked query is declined before either ordering or cursor data reaches PGlite.
		expect(reads).toBe(2);
	});

	it('matches the wire page ceiling and safely falls back from a scalar orderBy', async () => {
		let requestedLimit: number | undefined;
		const rows = Array.from({ length: 501 }, (_, index) => ({
			id: rid(`bounded:${index}`),
			name: `Person ${index}`
		}));
		const store: LocalReplicaStore = {
			findMany: (input) =>
				Effect.sync(() => {
					requestedLimit = input.limit;
					return rows.slice(0, input.limit);
				}),
			count: () => Effect.succeed(rows.length),
			applySnapshot: () => Effect.succeed(0),
			applyChange: () => Effect.void,
			reset: () => Effect.void
		};
		const reader = createLocalReader(
			store,
			{
				collections: [
					{
						name: 'people',
						fields: { name: { type: 'string', required: true, indexed: false } },
						readableFields: null
					}
				],
				relations: []
			},
			new Set(['people'])
		);

		const answer = await Effect.runPromise(
			reader.answer('collections.findMany', {
				collection: 'people',
				limit: 900,
				// The authoritative compiler treats a scalar orderBy as the default `id asc` order.
				orderBy: 'name'
			})
		);
		const page = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(answer);
		expect(requestedLimit).toBe(501);
		expect(page.rows).toHaveLength(500);
		expect(page.nextCursor).toEqual(expect.any(String));

		rows.pop();
		const terminal = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people', limit: 900 })
			)
		);
		expect(requestedLimit).toBe(501);
		expect(terminal.rows).toHaveLength(500);
		expect(terminal.nextCursor).toBeNull();
	});

	it('returns what the server returns, for a filter and an ordering', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, replica.readable);

		const query = {
			collection: 'people',
			where: { team: { eq: 'flight' } },
			orderBy: { name: 'asc' }
		};
		const local = await Effect.runPromise(reader.answer('collections.findMany', query as never));
		const server = await serverRows(harness, query);

		expect(local).toBeDefined();
		const localRows = Schema.decodeUnknownSync(
			Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
		)(local).rows;
		// The same rows, in the same order — the point of reusing the server's own compiler.
		expect(localRows.map((row) => row['name'])).toEqual(
			server.map((row) => Reflect.get(row as object, 'name'))
		);
		expect(localRows.map((row) => row['name'])).toEqual(['Grace', 'Katherine']);
	});

	it('counts what the server counts', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, replica.readable);

		const counted = await Effect.runPromise(
			reader.answer('collections.count', {
				collection: 'people',
				where: { team: { eq: 'core' } }
			} as never)
		);
		expect(counted).toBe(2);
	});

	it('serves cold paginated slices locally with a server-compatible keyset cursor', async () => {
		harness = await makeBoltTestRuntime();
		await seedPaginatedCollection(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, replica.readable);

		// This is the first query for this slice and calls the replica reader directly: no query-cache
		// entry exists to make the result look fast after an earlier transport fetch.
		const startedAt = performance.now();
		const localFirst = await Effect.runPromise(
			reader.answer('collections.findMany', {
				collection: 'people',
				limit: 25,
				columns: { name: true }
			} as never)
		);
		const localReadMilliseconds = performance.now() - startedAt;
		const first = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(localFirst);
		expect(first.rows).toHaveLength(25);
		expect(first.nextCursor).toEqual(expect.any(String));
		expect(localReadMilliseconds).toBeLessThan(100);

		if (first.nextCursor === null) throw new Error('expected a local successor cursor');
		const nextQuery = { collection: 'people', limit: 25, after: first.nextCursor };
		const second = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(await Effect.runPromise(reader.answer('collections.findMany', nextQuery as never)));
		const authoritative = await serverRows(harness, nextQuery);
		expect(second.rows.map((row) => row['id'])).toEqual(
			authoritative.map((row) => Reflect.get(row as object, 'id'))
		);
		expect(second.nextCursor).toBeNull();

		const filtered = {
			collection: 'people',
			where: { team: { eq: 'flight' } },
			orderBy: { name: 'asc' },
			limit: 7
		};
		const filteredFirst = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(await Effect.runPromise(reader.answer('collections.findMany', filtered as never)));
		if (filteredFirst.nextCursor === null) throw new Error('expected a filtered successor cursor');
		const filteredNext = { ...filtered, after: filteredFirst.nextCursor };
		const filteredSecond = Schema.decodeUnknownSync(
			Schema.Struct({
				rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
				nextCursor: Schema.NullOr(Schema.String)
			})
		)(await Effect.runPromise(reader.answer('collections.findMany', filteredNext as never)));
		const authoritativeFilteredSecond = await serverRows(harness, filteredNext);
		expect(filteredSecond.rows.map((row) => row['id'])).toEqual(
			authoritativeFilteredSecond.map((row) => Reflect.get(row as object, 'id'))
		);

		const compound = {
			collection: 'people',
			orderBy: { team: 'desc', name: 'asc' },
			limit: 6
		};
		const walked: Array<unknown> = [];
		let after: string | undefined;
		for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
			const query = { ...compound, ...(after === undefined ? {} : { after }) };
			const localPage = Schema.decodeUnknownSync(
				Schema.Struct({
					rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
					nextCursor: Schema.NullOr(Schema.String)
				})
			)(await Effect.runPromise(reader.answer('collections.findMany', query as never)));
			const authoritativePage = await serverRows(harness, query);
			expect(localPage.rows.map((row) => row['id'])).toEqual(
				authoritativePage.map((row) => Reflect.get(row as object, 'id'))
			);
			walked.push(...localPage.rows.map((row) => row['id']));
			if (localPage.nextCursor === null) break;
			after = localPage.nextCursor;
		}
		const authoritativeCompound = await serverRows(harness, { ...compound, limit: 100 });
		expect(walked).toEqual(authoritativeCompound.map((row) => Reflect.get(row as object, 'id')));

		const malformed = await Effect.runPromise(
			reader
				.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'asc' },
					after: 'not-a-cursor'
				})
				.pipe(Effect.result)
		);
		expect(malformed._tag).toBe('Failure');
		const mismatched = await Effect.runPromise(
			reader
				.answer('collections.findMany', {
					collection: 'people',
					orderBy: { name: 'desc' },
					after: first.nextCursor
				})
				.pipe(Effect.result)
		);
		expect(mismatched._tag).toBe('Failure');
	});

	it('declines a query carrying a key it does not implement', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, replica.readable);

		// `with` expands relationships, which lives in the Collections service. Ignoring the key would
		// answer a different question while looking successful.
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', {
					collection: 'people',
					with: { team: true }
				} as never)
			)
		).toBeUndefined();
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people', search: 'ada' } as never)
			)
		).toBeUndefined();
	});

	it('declines a collection the subject may not read', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, new Set<string>());

		// The replica holds only permitted rows, but a collection outside the reported shape must never
		// be served from it regardless.
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people' } as never)
			)
		).toBeUndefined();
	});

	it('declines commands that are not reads at all', async () => {
		harness = await makeBoltTestRuntime();
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.store, replica.shape, replica.readable);

		expect(
			await Effect.runPromise(
				reader.answer('collections.create', { collection: 'people' } as never)
			)
		).toBeUndefined();
		expect(
			await Effect.runPromise(
				reader.answer('collections.history', { collection: 'people' } as never)
			)
		).toBeUndefined();
	});
});
