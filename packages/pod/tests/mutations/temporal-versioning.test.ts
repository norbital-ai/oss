import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';
import { loadRecordHistorySnapshots } from '$lib/server/collection/record_history.server.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import { SCHEMA_POST_DDL_SQL } from '$lib/vite/schema-functions-sql.js';

requireDocker();

/** A minimal ProvisionedContext whose tenantDb routes every query to one pg runner. */
function ctxOn(runner: Pool | PoolClient): ProvisionedContext {
	const tenantDb = {
		query: (sql: string, params?: readonly unknown[]) => runner.query(sql, params as unknown[])
	} as unknown as TenantDbClient;
	return { tenantDb } as unknown as ProvisionedContext;
}

/** Run a set of statements on one connection inside a via_ops transaction (as collection_ops does). */
async function inViaOps(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await run(client);
		await client.query('COMMIT');
	} finally {
		client.release();
	}
}

/** Insert one order through the authoritative path and return its id (the trigger opens its period). */
async function insertOrder(pool: Pool, status: string): Promise<string> {
	let id = '';
	await inViaOps(pool, async (client) => {
		const { rows } = await client.query<{ norbital_id: string }>(
			`INSERT INTO orders (status) VALUES ($1) RETURNING norbital_id`,
			[status]
		);
		id = rows[0].norbital_id;
	});
	return id;
}

describe('Pod temporal versioning (trigger, real Postgres)', () => {
	let pg: PgHarness;
	let pool: Pool;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 8 });
		await applyPodSchema(pool);
	}, 120_000);

	afterAll(async () => {
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		await inViaOps(pool, async (client) => {
			await client.query('DELETE FROM orders');
			await client.query('DELETE FROM orders_history');
		});
	});

	it('archives the prior version and bumps the live row on a plain UPDATE', async () => {
		const id = await insertOrder(pool, 'pending');
		// A bare UPDATE — temporal_tables archives the row and Pod advances its sync version.
		await inViaOps(pool, (client) =>
			client.query(`UPDATE orders SET status = 'shipped' WHERE norbital_id = $1::uuid`, [id]).then()
		);

		const history = await pool.query<{ status: string; version: number; closed: boolean }>(
			`SELECT status,
			        norbital_row_version AS version,
			        upper(norbital_sys_period) IS NOT NULL AS closed
			   FROM orders_history
			  WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(history.rows).toHaveLength(1);
		expect(history.rows[0]).toMatchObject({ status: 'pending', version: 1, closed: true });

		const live = await pool.query<{ status: string; version: number; open: boolean }>(
			`SELECT status,
			        norbital_row_version AS version,
			        upper(norbital_sys_period) IS NULL AS open
			   FROM orders WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(live.rows[0]).toMatchObject({ status: 'shipped', version: 2, open: true });
	});

	it('closes a row version after an older transaction observes a newer committed write', async () => {
		const id = await insertOrder(pool, 'pending');
		const older = await pool.connect();
		try {
			await older.query('BEGIN');
			await older.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
			await older.query('SELECT now()');
			await pool.query('SELECT pg_sleep(0.01)');
			await inViaOps(pool, (client) =>
				client
					.query(`UPDATE orders SET status = 'approved' WHERE norbital_id = $1::uuid`, [id])
					.then()
			);

			await older.query(`UPDATE orders SET status = 'shipped' WHERE norbital_id = $1::uuid`, [id]);
			await older.query('COMMIT');
		} catch (cause) {
			await older.query('ROLLBACK').catch(() => undefined);
			throw cause;
		} finally {
			older.release();
		}

		const history = await pool.query<{ status: string; empty: boolean }>(
			`SELECT status, isempty(norbital_sys_period) AS empty
			   FROM orders_history
			  WHERE norbital_id = $1::uuid
			  ORDER BY norbital_row_version`,
			[id]
		);
		expect(history.rows).toEqual([
			{ status: 'pending', empty: false },
			{ status: 'approved', empty: false }
		]);
	});

	it('exposes the full timeline through findHistory, newest version first', async () => {
		const id = await insertOrder(pool, 'draft');
		await inViaOps(pool, (client) =>
			client.query(`UPDATE orders SET status = 'pending' WHERE norbital_id = $1::uuid`, [id]).then()
		);
		await inViaOps(pool, (client) =>
			client.query(`UPDATE orders SET status = 'shipped' WHERE norbital_id = $1::uuid`, [id]).then()
		);

		const snapshots = await loadRecordHistorySnapshots(ctxOn(pool).tenantDb, {
			collection: 'orders',
			record_id: id,
			limit: 10
		} as Parameters<typeof loadRecordHistorySnapshots>[1]);

		expect(snapshots.map((s) => s.version)).toEqual([3, 2, 1]);
		expect(snapshots.map((s) => (s.values as { status: string }).status)).toEqual([
			'shipped',
			'pending',
			'draft'
		]);
		// Only the current (live) version has an open period.
		expect(snapshots[0].validTo).toBeNull();
		expect(snapshots[1].validTo).not.toBeNull();
		expect(snapshots[2].validTo).not.toBeNull();
	});

	it('preserves the deleted row as its final version', async () => {
		const id = await insertOrder(pool, 'pending');
		await inViaOps(pool, (client) =>
			client.query(`UPDATE orders SET status = 'shipped' WHERE norbital_id = $1::uuid`, [id]).then()
		);
		await inViaOps(pool, (client) =>
			client.query(`DELETE FROM orders WHERE norbital_id = $1::uuid`, [id]).then()
		);

		const live = await pool.query(`SELECT 1 FROM orders WHERE norbital_id = $1::uuid`, [id]);
		expect(live.rowCount).toBe(0);

		const history = await pool.query<{ status: string }>(
			`SELECT status
			   FROM orders_history
			  WHERE norbital_id = $1::uuid
			  ORDER BY norbital_row_version`,
			[id]
		);
		// Both the pre-update (v1) and the final pre-delete (v2) states are retained.
		expect(history.rows.map((r) => r.status)).toEqual(['pending', 'shipped']);
	});

	it('supplies the approval-rollback baseline for a rejected update', async () => {
		const id = await insertOrder(pool, 'pending');
		const approvalId = '99999999-9999-4999-8999-999999999999';
		// A gated update applies immediately and stamps the pending approval; the trigger archives
		// the prior (unstamped) version.
		await inViaOps(pool, (client) =>
			client
				.query(
					`UPDATE orders SET status = 'shipped', norbital_approval_id = $2::uuid
				  WHERE norbital_id = $1::uuid`,
					[id, approvalId]
				)
				.then()
		);

		// restoreRecordBeforeApproval reads the newest history row NOT stamped by this approval.
		const baseline = await pool.query<{ status: string }>(
			`SELECT status
			   FROM orders_history
			  WHERE norbital_id = $1::uuid
			    AND norbital_approval_id IS DISTINCT FROM $2::uuid
			  ORDER BY norbital_row_version DESC
			  LIMIT 1`,
			[id, approvalId]
		);
		expect(baseline.rows[0]?.status).toBe('pending');
	});

	it('supplies the re-insert source for a rejected delete', async () => {
		const id = await insertOrder(pool, 'confirmed');
		await inViaOps(pool, (client) =>
			client.query(`DELETE FROM orders WHERE norbital_id = $1::uuid`, [id]).then()
		);

		// restoreRecordBeforeApproval (record_delete) resurrects the newest history version.
		const source = await pool.query<{ status: string }>(
			`SELECT status
			   FROM orders_history
			  WHERE norbital_id = $1::uuid
			  ORDER BY norbital_row_version DESC
			  LIMIT 1`,
			[id]
		);
		expect(source.rows[0]?.status).toBe('confirmed');
	});

	it('preserves history when the idempotent post-DDL schema is reapplied', async () => {
		const id = await insertOrder(pool, 'before-migration');
		await inViaOps(pool, (client) =>
			client
				.query(`UPDATE orders SET status = 'after-migration' WHERE norbital_id = $1::uuid`, [id])
				.then()
		);

		await pool.query(SCHEMA_POST_DDL_SQL);

		const history = await pool.query<{ status: string }>(
			`SELECT status
			   FROM orders_history
			  WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(history.rows).toEqual([{ status: 'before-migration' }]);
	});

	it('keeps historical rows natively queryable after mirrored schema evolution', async () => {
		const id = await insertOrder(pool, 'before-schema-change');
		await inViaOps(pool, (client) =>
			client
				.query(`UPDATE orders SET status = 'after-schema-change' WHERE norbital_id = $1::uuid`, [
					id
				])
				.then()
		);

		try {
			await pool.query(
				`ALTER TABLE orders ADD COLUMN reference text NOT NULL DEFAULT 'unassigned'`
			);
			await expect(pool.query(SCHEMA_POST_DDL_SQL)).rejects.toThrow(
				/temporal history schema mismatch for orders/
			);
			await pool.query(
				`ALTER TABLE orders_history ADD COLUMN reference text NOT NULL DEFAULT 'unassigned'`
			);
			await pool.query(SCHEMA_POST_DDL_SQL);

			const history = await pool.query<{ status: string; reference: string }>(
				`SELECT status, reference
				   FROM orders_history
				  WHERE norbital_id = $1::uuid`,
				[id]
			);
			expect(history.rows).toEqual([{ status: 'before-schema-change', reference: 'unassigned' }]);
		} finally {
			await pool.query('ALTER TABLE orders_history DROP COLUMN IF EXISTS reference');
			await pool.query('ALTER TABLE orders DROP COLUMN IF EXISTS reference');
		}
	});

	it('preserves array types and declared dimensions in native history rows', async () => {
		try {
			await pool.query(`
				CREATE TABLE array_records (
					norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
					norbital_created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
					norbital_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
					norbital_sys_period TSTZRANGE NOT NULL
						DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'),
					norbital_row_version INTEGER NOT NULL DEFAULT 1,
					norbital_approval_id UUID,
					tags TEXT[] NOT NULL,
					matrix INTEGER[][]
				)
			`);
			await pool.query(
				`SELECT _norbital_create_history_table('array_records'::regclass, 'array_records_history')`
			);
			await pool.query(SCHEMA_POST_DDL_SQL);

			const dimensions = await pool.query<{
				table_name: string;
				column_name: string;
				attndims: number;
			}>(
				`SELECT relation.relname AS table_name,
				        attribute.attname AS column_name,
				        attribute.attndims
				   FROM pg_class relation
				   JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
				  WHERE relation.relname IN ('array_records', 'array_records_history')
				    AND attribute.attname IN ('tags', 'matrix')
				  ORDER BY relation.relname, attribute.attname`
			);
			expect(dimensions.rows).toEqual([
				{ table_name: 'array_records', column_name: 'matrix', attndims: 2 },
				{ table_name: 'array_records', column_name: 'tags', attndims: 1 },
				{ table_name: 'array_records_history', column_name: 'matrix', attndims: 2 },
				{ table_name: 'array_records_history', column_name: 'tags', attndims: 1 }
			]);

			let id = '';
			await inViaOps(pool, async (client) => {
				const inserted = await client.query<{ norbital_id: string }>(
					`INSERT INTO array_records (tags, matrix)
					 VALUES (ARRAY['draft'], ARRAY[[1, 2], [3, 4]])
					 RETURNING norbital_id`
				);
				id = inserted.rows[0].norbital_id;
			});
			await inViaOps(pool, async (client) => {
				await client.query(
					`UPDATE array_records SET tags = ARRAY['published'] WHERE norbital_id = $1::uuid`,
					[id]
				);
			});

			const history = await pool.query<{ tags: string[]; matrix: number[][] }>(
				`SELECT tags, matrix FROM array_records_history WHERE norbital_id = $1::uuid`,
				[id]
			);
			expect(history.rows).toEqual([
				{
					tags: ['draft'],
					matrix: [
						[1, 2],
						[3, 4]
					]
				}
			]);
		} finally {
			await pool.query('DROP TABLE IF EXISTS array_records_history, array_records CASCADE');
		}
	});

	it('keeps audit_event append-only instead of treating it as temporal row history', async () => {
		const excludedHistory = await pool.query<{ audit: boolean; transcript: boolean }>(
			`SELECT to_regclass('public.audit_event_history') IS NULL AS audit,
			        to_regclass('public.agent_run_step_history') IS NULL AS transcript`
		);
		expect(excludedHistory.rows[0]).toEqual({ audit: true, transcript: true });

		const inserted = await pool.query<{ norbital_id: string }>(
			`INSERT INTO audit_event (event_type, collection_name, details)
			 VALUES ('mutation', 'orders', '{"action":"create"}'::jsonb)
			 RETURNING norbital_id`
		);
		const id = inserted.rows[0].norbital_id;

		await expect(
			pool.query(
				`UPDATE audit_event SET details = '{"action":"rewrite"}'::jsonb
				  WHERE norbital_id = $1::uuid`,
				[id]
			)
		).rejects.toThrow(/audit_event is insert-only/);
		await expect(
			pool.query(`DELETE FROM audit_event WHERE norbital_id = $1::uuid`, [id])
		).rejects.toThrow(/audit_event is insert-only/);
	});
});
