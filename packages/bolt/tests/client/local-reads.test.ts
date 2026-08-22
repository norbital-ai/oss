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

describe('reads answered by the replica', () => {
	it('returns what the server returns, for a filter and an ordering', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.engine, replica.shape, replica.readable);

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
		const reader = createLocalReader(replica.engine, replica.shape, replica.readable);

		const counted = await Effect.runPromise(
			reader.answer('collections.count', {
				collection: 'people',
				where: { team: { eq: 'core' } }
			} as never)
		);
		expect(counted).toBe(2);
	});

	it('declines a page that has a successor, so only the server ever mints a cursor', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.engine, replica.shape, replica.readable);

		// Four rows, asking for two: the caller needs a `nextCursor`, and only the server can mint one
		// that seeks correctly.
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people', limit: 2 } as never)
			)
		).toBeUndefined();
		// The whole result fits, so there is no successor and `nextCursor: null` is the honest answer.
		expect(
			await Effect.runPromise(
				reader.answer('collections.findMany', { collection: 'people', limit: 50 } as never)
			)
		).toBeDefined();
	});

	it('declines a query carrying a key it does not implement', async () => {
		harness = await makeBoltTestRuntime();
		await seed(harness);
		const replica = await openReplica(harness);
		const reader = createLocalReader(replica.engine, replica.shape, replica.readable);

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
		const reader = createLocalReader(replica.engine, replica.shape, new Set<string>());

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
		const reader = createLocalReader(replica.engine, replica.shape, replica.readable);

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
