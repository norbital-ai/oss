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
			await client.query('DELETE FROM orders_history');
			await client.query('DELETE FROM orders');
		});
	});

	it('archives the prior version and bumps the live row on a plain UPDATE', async () => {
		const id = await insertOrder(pool, 'pending');
		// A bare UPDATE — no manual period/version/capture. The _norbital_versioning trigger does it all.
		await inViaOps(pool, (client) =>
			client.query(`UPDATE orders SET status = 'shipped' WHERE norbital_id = $1::uuid`, [id]).then()
		);

		const history = await pool.query<{ status: string; version: number; closed: boolean }>(
			`SELECT status,
			        norbital_row_version AS version,
			        upper(norbital_sys_period::tstzrange) IS NOT NULL AS closed
			   FROM orders_history WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(history.rows).toHaveLength(1);
		expect(history.rows[0]).toMatchObject({ status: 'pending', version: 1, closed: true });

		const live = await pool.query<{ status: string; version: number; open: boolean }>(
			`SELECT status,
			        norbital_row_version AS version,
			        upper(norbital_sys_period::tstzrange) IS NULL AS open
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
			`SELECT status, isempty(norbital_sys_period::tstzrange) AS empty
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
			`SELECT status FROM orders_history WHERE norbital_id = $1::uuid ORDER BY norbital_row_version`,
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
			  ORDER BY upper(norbital_sys_period::tstzrange) DESC NULLS LAST, norbital_row_version DESC
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
			  ORDER BY upper(norbital_sys_period::tstzrange) DESC NULLS LAST, norbital_row_version DESC
			  LIMIT 1`,
			[id]
		);
		expect(source.rows[0]?.status).toBe('confirmed');
	});

	it('rebuilds every history table from the current collection shape after migration', async () => {
		await pool.query(`
			CREATE TABLE migration_probe (
				norbital_id UUID NOT NULL DEFAULT gen_random_uuid(),
				current_value INTEGER NOT NULL DEFAULT 7
			);
			CREATE TABLE migration_probe_history (
				norbital_id UUID,
				legacy_value TEXT
			);
			INSERT INTO migration_probe_history (legacy_value) VALUES ('obsolete');
		`);

		try {
			await pool.query(SCHEMA_POST_DDL_SQL);
			const { rows } = await pool.query<{
				table_name: string;
				column_name: string;
				data_type: string;
				is_nullable: string;
				column_default: string | null;
			}>(`
				SELECT table_name, column_name, data_type, is_nullable, column_default
				FROM information_schema.columns
				WHERE table_schema = 'public'
				  AND table_name IN ('migration_probe', 'migration_probe_history')
				ORDER BY table_name, ordinal_position
			`);

			expect(rows.filter((row) => row.table_name === 'migration_probe_history')).toEqual(
				rows
					.filter((row) => row.table_name === 'migration_probe')
					.map((row) => ({ ...row, table_name: 'migration_probe_history' }))
			);
			expect(await pool.query('SELECT 1 FROM migration_probe_history')).toMatchObject({
				rowCount: 0
			});
		} finally {
			await pool.query('DROP TABLE IF EXISTS migration_probe_history, migration_probe');
		}
	});
});
