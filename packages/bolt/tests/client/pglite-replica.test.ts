import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import {
	createWindowLedger,
	windowDescriptorOf,
	type WindowLedger
} from '../../src/client/replica/coverage.js';
import {
	createLocalReader,
	type LocalReader,
	type ReplicaShape
} from '../../src/client/replica/local-reads.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import {
	createPGliteStore,
	provision,
	type LocalReplicaStore
} from '../../src/client/replica/pglite-sql.js';
import {
	describeClientQueryWindow,
	type QueryWindowCatalog
} from '../../src/client/replica/query-window.js';
import { provisioningStatements, testWorkspace } from '../support/bolt-test-layer.js';

const ids = {
	ada: '00000000-0000-5000-8000-000000000011',
	grace: '00000000-0000-5000-8000-000000000012',
	aaron: '00000000-0000-5000-8000-000000000013',
	zulu: '00000000-0000-5000-8000-000000000014',
	zebra: '00000000-0000-5000-8000-000000000015',
	angstrom: '00000000-0000-5000-8000-000000000016'
} as const;

const identity = {
	protocolVersion: 6,
	schemaFingerprint: 'sha256:pglite-replica-tests',
	partitionKey: 'partition-a'
};

const catalog: QueryWindowCatalog = {
	people: {
		fields: [
			{ name: 'name', kind: 'string' },
			{ name: 'team', kind: 'string' }
		]
	}
};

const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
});

type Replica = Readonly<{
	readonly database: PGlite;
	readonly store: LocalReplicaStore;
	readonly windows: WindowLedger;
	readonly shape: ReplicaShape;
}>;

const provisionedReplica = async (): Promise<Replica> => {
	const database = await PGlite.create('memory://', {
		extensions: { pg_trgm, btree_gist, vector }
	});
	databases.push(database);
	const engine = adaptPGlite(database);
	const definition = testWorkspace();
	await Effect.runPromise(provision(engine, await provisioningStatements(definition)));
	const fieldsByCollection = Object.fromEntries(
		definition.collections.map(({ name, fields }) => [name, fields])
	);
	const readableFieldsByCollection = Object.fromEntries(
		definition.collections.map(({ name }) => [name, ['id', 'name', 'team']])
	);
	const store = await Effect.runPromise(
		createPGliteStore(engine, fieldsByCollection, readableFieldsByCollection)
	);
	const windows = await Effect.runPromise(createWindowLedger(engine, store));
	const shape: ReplicaShape = {
		collections: definition.collections.map(({ name, fields }) => ({
			name,
			fields,
			readableFields: ['id', 'name', 'team']
		})),
		relations: definition.relations ?? []
	};
	return { database, store, windows, shape };
};

const readerFor = (replica: Replica): LocalReader => createLocalReader(
	replica.store,
	replica.shape,
	new Set(['people']),
	replica.windows,
	identity,
	{ pinnedCollation: true }
);

type PermittedPerson = Readonly<{
	readonly recordId: string;
	readonly rowVersion: number;
	readonly row: Readonly<{ readonly name: string; readonly team: string | null }>;
}>;

const installPeopleWindow = async (
	replica: Replica,
	input: Readonly<Record<string, unknown>>,
	baseRows: ReadonlyArray<PermittedPerson>,
	orderedRowIds: ReadonlyArray<string>
): Promise<void> => {
	const described = await Effect.runPromise(
		describeClientQueryWindow('findMany', input, catalog, identity, {
			pinnedCollation: true
		})
	);
	if (described === undefined) throw new Error('expected a canonical people query');
	await Effect.runPromise(
		replica.windows.installWindow({
			window: windowDescriptorOf(described),
			dependencies: described.dependencies,
			baseRows: baseRows.map((row) => ({ collection: 'people', ...row })),
			orderedRowIds,
			nextCursor: null,
			readCursor: { xid: 0, sequence: 0 },
			dependencyGenerations: { people: 0 },
			continuation: null,
			lookaheadCount: 0
		})
	);
};

const windowRows = async (
	reader: LocalReader,
	input: Readonly<Record<string, unknown>>
): Promise<ReadonlyArray<Readonly<Record<string, Schema.Json>>>> => {
	const answer = await Effect.runPromise(
		reader.answer('collections.findMany', input as Schema.Json)
	);
	if (answer === undefined) throw new Error('expected the installed query window');
	return Schema.decodeUnknownSync(
		Schema.Struct({ rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)) })
	)(answer.value).rows;
};

const allPeople = (store: LocalReplicaStore) => store.findMany({
	collection: 'people',
	filter: { sql: 'true', parameters: [] },
	orderBy: []
});

describe('the authoritative base/window replica on PGlite', () => {
	it('provisions identity-only windows', async () => {
		const { database } = await provisionedReplica();
		const tables = await database.query<{ table_name: string }>(
			`select table_name from information_schema.tables
			 where table_schema = 'public' and table_name like 'bolt_replica_%'`
		);
		const names = tables.rows.map(({ table_name }) => table_name);
		expect(names).toEqual(expect.arrayContaining([
			'bolt_replica_base_row',
			'bolt_replica_window',
			'bolt_replica_window_row',
			'bolt_replica_position'
		]));
		const membershipColumns = await database.query<{ column_name: string }>(
			`select column_name from information_schema.columns
			 where table_name = 'bolt_replica_window_row' order by ordinal_position`
		);
		expect(membershipColumns.rows.map(({ column_name }) => column_name)).toEqual([
			'query_key',
			'ordinal',
			'collection',
			'record_id'
		]);
	});

	it('serves a window in membership order and never admits an unlisted base row', async () => {
		const replica = await provisionedReplica();
		const input = { collection: 'people', orderBy: { name: 'asc' } };
		await Effect.runPromise(
			replica.store.applyAuthoritativeRow({
				collection: 'people',
				recordId: ids.aaron,
				rowVersion: 1,
				row: { name: 'Aaron', team: 'other' }
			})
		);
		await installPeopleWindow(
			replica,
			input,
			[
				{ recordId: ids.grace, rowVersion: 2, row: { name: 'Grace', team: 'flight' } },
				{ recordId: ids.ada, rowVersion: 3, row: { name: 'Ada', team: 'core' } }
			],
			[ids.ada, ids.grace]
		);

		const projected = await windowRows(readerFor(replica), {
			...input,
			columns: { name: true }
		});
		expect(projected).toEqual([{ name: 'Ada' }, { name: 'Grace' }]);
		expect(projected.some((row) => row['name'] === 'Aaron')).toBe(false);
		expect(await Effect.runPromise(replica.store.recordIds('people'))).toHaveLength(3);
	});

	it('requires complete permitted rows and version-gates duplicates, removals, and resurrection', async () => {
		const { store } = await provisionedReplica();
		await expect(
			Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId: ids.ada,
					rowVersion: 1,
					row: { name: 'Partial Ada' }
				})
			)
		).rejects.toThrow(/partial.*team/i);

		expect(
			await Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId: ids.ada,
					rowVersion: 2,
					row: { name: 'Ada', team: 'core' }
				})
			)
		).toMatchObject({ applied: true, present: true });
		expect(
			await Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId: ids.ada,
					rowVersion: 2,
					row: { name: 'Delayed duplicate', team: 'wrong' }
				})
			)
		).toMatchObject({ applied: false, present: true, previousVersion: 2 });
		expect(
			await Effect.runPromise(
				store.removeAuthoritativeRow({
					collection: 'people', recordId: ids.ada, rowVersion: 1
				})
			)
		).toMatchObject({ applied: false, present: true, previousVersion: 2 });

		expect(
			await Effect.runPromise(
				store.removeAuthoritativeRow({
					collection: 'people', recordId: ids.ada, rowVersion: 3
				})
			)
		).toMatchObject({ applied: true, present: false, previousVersion: 2 });
		expect(
			await Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId: ids.ada,
					rowVersion: 2,
					row: { name: 'Stale resurrection', team: 'wrong' }
				})
			)
		).toMatchObject({ applied: false, present: false, previousVersion: 3 });
		expect(await Effect.runPromise(store.hasRecord('people', ids.ada))).toBe(false);

		expect(
			await Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId: ids.ada,
					rowVersion: 4,
					row: { name: 'Ada Lovelace', team: null }
				})
			)
		).toMatchObject({ applied: true, present: true, previousVersion: 3 });
		const row = (await Effect.runPromise(allPeople(store)))[0];
		expect(row).toMatchObject({ name: 'Ada Lovelace', team: null, row_version: 4 });
	});

	it('uses the pinned PostgreSQL C collation for authored text order terms', async () => {
		const { store } = await provisionedReplica();
		for (const [recordId, name] of [
			[ids.zebra, 'zebra'],
			[ids.zulu, 'Zulu'],
			[ids.aaron, 'apple'],
			[ids.angstrom, 'Ångström']
		] as const) {
			await Effect.runPromise(
				store.applyAuthoritativeRow({
					collection: 'people',
					recordId,
					rowVersion: 1,
					row: { name, team: null }
				})
			);
		}

		const ordered = await Effect.runPromise(
			store.findMany({
				collection: 'people',
				filter: { sql: 'true', parameters: [] },
				orderBy: [{ column: 'name', direction: 'asc', collation: 'C' }]
			})
		);
		expect(ordered.map((row) => Reflect.get(row as object, 'name'))).toEqual([
			'Zulu',
			'apple',
			'zebra',
			'Ångström'
		]);
	});
});
