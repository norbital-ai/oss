import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { createHash } from 'node:crypto';
import { Effect } from 'effect';
import {
	createPGliteSql,
	markProvisioned,
	provision,
	readReplicaState,
	writeReplicaCursor
} from '../../src/client/replica/pglite-sql.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import { provisioningStatements, testWorkspace } from '../support/bolt-test-layer.js';

/**
 * The replica against a real PostgreSQL, provisioned from the same DDL a tenant's database gets.
 *
 * The point of the whole arrangement is that there is no second implementation to keep honest, so
 * these exercise the real engine rather than a stand-in: the schema comes from `provisioningStatements`
 * — plan foundation, then the drizzle lineage — and the queries are ordinary SQL.
 */

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
});

const provisionedReplica = async () => {
	// The extensions PGlite ships but does not enable; the plan's `create extension` needs them present.
	const database = await PGlite.create('memory://', {
		extensions: { pg_trgm, btree_gist, vector }
	});
	databases.push(database);
	const driver = adaptPGlite(database);
	const definition = testWorkspace();
	await Effect.runPromise(provision(driver, await provisioningStatements(definition)));
	return {
		database,
		sql: await Effect.runPromise(
			createPGliteSql(
				driver,
				Object.fromEntries(definition.collections.map(({ name, fields }) => [name, fields]))
			)
		)
	};
};

describe('the browser replica on PGlite', () => {
	it('provisions the tenant schema and answers a real query over it', async () => {
		const { database, sql } = await provisionedReplica();

		// The columns exist because the lineage created them, not because the client guessed a mapping.
		const columns = await database.query<{ column_name: string }>(
			"select column_name from information_schema.columns where table_name = 'people'"
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual(
			expect.arrayContaining(['id', 'sys_period', 'name', 'team'])
		);

		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 1 },
				collection: 'people',
				recordId: rid('p1'),
				operation: 'create',
				record: { name: 'Ada', team: 'core' }
			})
		);
		// An ordinary `where` + `order by`, which the `Map` projection could never have answered.
		expect(
			await Effect.runPromise(
				sql.query('select name from people where team = $1 order by name', ['core'])
			)
		).toEqual([{ name: 'Ada' }]);
	});

	it('converges when the same change arrives twice, because the stream is at-least-once', async () => {
		const { sql } = await provisionedReplica();
		const change = {
			cursor: { xid: 1, sequence: 1 },
			collection: 'people',
			recordId: rid('p1'),
			operation: 'create' as const,
			record: { name: 'Ada', team: 'core' }
		};
		// A snapshot is paged while the workspace is being written, so a row that commits mid-page is
		// delivered by both the snapshot and the log. That has to converge rather than raise.
		await Effect.runPromise(sql.applyChange(change));
		await Effect.runPromise(sql.applyChange(change));
		expect(
			await Effect.runPromise(sql.query('select count(*)::int as count from people', []))
		).toEqual([{ count: 1 }]);
	});

	it('merges an update onto the row it already holds rather than replacing it', async () => {
		const { sql } = await provisionedReplica();
		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 1 },
				collection: 'people',
				recordId: rid('p1'),
				operation: 'create',
				record: { name: 'Ada', team: 'core' }
			})
		);
		// An update carries the columns that changed, not the whole row.
		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 2 },
				collection: 'people',
				recordId: rid('p1'),
				operation: 'update',
				record: { name: 'Ada Lovelace' }
			})
		);
		expect(await Effect.runPromise(sql.query('select name, team from people', []))).toEqual([
			{ name: 'Ada Lovelace', team: 'core' }
		]);
	});

	it('applies a delete, and drops everything on a reset', async () => {
		const { sql } = await provisionedReplica();
		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 1 },
				collection: 'people',
				recordId: rid('p1'),
				operation: 'create',
				record: { name: 'Ada', team: 'core' }
			})
		);
		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 2 },
				collection: 'people',
				recordId: rid('p1'),
				operation: 'delete'
			})
		);
		expect(
			await Effect.runPromise(sql.query('select count(*)::int as count from people', []))
		).toEqual([{ count: 0 }]);

		await Effect.runPromise(
			sql.applyChange({
				cursor: { xid: 1, sequence: 3 },
				collection: 'people',
				recordId: rid('p2'),
				operation: 'create',
				record: { name: 'Grace', team: 'core' }
			})
		);
		await Effect.runPromise(sql.reset());
		expect(
			await Effect.runPromise(sql.query('select count(*)::int as count from people', []))
		).toEqual([{ count: 0 }]);
	});

	it('skips provisioning when the local database already matches the fingerprint', async () => {
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		databases.push(database);
		const driver = adaptPGlite(database);
		const steps = await provisioningStatements(testWorkspace());
		// A persisted replica opens an already-provisioned database on the second visit. Re-running the
		// lineage there fails on its own unguarded `CREATE TABLE`, which is the lineage being correct.
		expect(await Effect.runPromise(provision(driver, steps, 'fnv1a32:abc'))).toBe(true);
		// Not yet skippable: provisioning alone does not mean the replica holds the workspace.
		expect(await Effect.runPromise(provision(driver, steps, 'fnv1a32:abc'))).toBe(true);
		await Effect.runPromise(
			markProvisioned(driver, 'fnv1a32:abc', {
				xid: 0,
				sequence: 0
			})
		);
		expect(await Effect.runPromise(provision(driver, steps, 'fnv1a32:abc'))).toBe(false);

		// A changed schema rebuilds rather than migrating: the replica is a reconstructible cache.
		await database.query("insert into people (id, name) values ($1, 'Ada')", [rid('p1')]);
		expect(await Effect.runPromise(provision(driver, steps, 'fnv1a32:changed'))).toBe(true);
		expect(await database.query('select count(*)::int as count from people')).toMatchObject({
			rows: [{ count: 0 }]
		});
	});

	it('remembers how far it streamed, so the next session resumes', async () => {
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		databases.push(database);
		const driver = adaptPGlite(database);
		const steps = await provisioningStatements(testWorkspace());
		await Effect.runPromise(provision(driver, steps, 'fnv1a32:abc'));
		await Effect.runPromise(
			markProvisioned(driver, 'fnv1a32:abc', {
				xid: 0,
				sequence: 0
			})
		);
		expect((await Effect.runPromise(readReplicaState(driver)))?.cursor).toEqual({
			xid: 0,
			sequence: 0
		});
		await Effect.runPromise(writeReplicaCursor(driver, { xid: 42, sequence: 7 }));
		expect(await Effect.runPromise(readReplicaState(driver))).toEqual({
			fingerprint: 'fnv1a32:abc',
			cursor: { xid: 42, sequence: 7 }
		});
	});

	it('names the step that failed rather than building a half-provisioned database', async () => {
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		databases.push(database);
		const driver = adaptPGlite(database);
		await expect(
			Effect.runPromise(
				provision(driver, [
					{ id: 'lineage:20260101_baseline:0', sql: 'create table valid (x int)' },
					{ id: 'lineage:20260101_baseline:1', sql: 'this is not sql' },
					{ id: 'lineage:20260101_baseline:2', sql: 'create table never_reached (x int)' }
				])
			)
		).rejects.toThrow(/lineage:20260101_baseline:1/);
		// Stopped rather than continued: the steps are dependency-ordered, so what follows a failure
		// would be built against a shape that does not exist.
		const tables = await database.query<{ table_name: string }>(
			"select table_name from information_schema.tables where table_name = 'never_reached'"
		);
		expect(tables.rows).toEqual([]);
	});
});
