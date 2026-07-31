import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema, seedApprovalRequest } from '../support/pod-schema.js';

requireDocker();

const APPROVAL_A = '99999999-9999-4999-8999-999999999999';

/**
 * End-to-end test of the approval-as-a-lock contract at the database level, exercising the real
 * DDL the whole system rests on: _norbital_versioning (archives every write), _approval_lock_gate
 * (blocks writes to a locked record), _ops_guard (writes must be authorized), and the
 * approval_terminal_transition bypass used during resolution. Each block issues the exact statement
 * sequence collection_ops (write-then-lock) and approval_service (restore/re-insert) emit, so a
 * regression in trigger behavior, fire order, or the restore contract fails here. The service-layer
 * SQL that reads history is additionally unit-tested in temporal-versioning.test.ts.
 */

/** Run statements on one connection inside a via_ops transaction; ROLLBACK on error. */
async function inViaOps(
	pool: Pool,
	run: (client: PoolClient) => Promise<void>,
	opts?: { terminalTransition?: boolean }
): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		if (opts?.terminalTransition) {
			await client.query(`SELECT set_config('norbital.approval_terminal_transition', 'on', true)`);
		}
		await run(client);
		await client.query('COMMIT');
	} catch (cause) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

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

async function lock(client: PoolClient, type: string, id: string): Promise<void> {
	await client.query(
		`INSERT INTO _approval_lock (approval_request_id, lock_type, collection_name, record_id)
		 VALUES ($1::uuid, $2, 'orders', $3::uuid)`,
		[APPROVAL_A, type, id]
	);
}

describe('Pod approval lifecycle (real Postgres triggers)', () => {
	let pg: PgHarness;
	let pool: Pool;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 8 });
		await applyPodSchema(pool);
		await seedApprovalRequest(pool, APPROVAL_A);
	}, 120_000);

	afterAll(async () => {
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		await inViaOps(pool, async (client) => {
			await client.query('DELETE FROM _approval_lock');
			await client.query('DELETE FROM orders_history');
			await client.query('DELETE FROM orders');
		});
	});

	it('locks a record under a pending approval and blocks concurrent writes', async () => {
		const id = await insertOrder(pool, 'pending');
		// Gated update: apply the new value, stamp the pending approval, materialize the lock.
		await inViaOps(pool, async (client) => {
			await client.query(
				`UPDATE orders SET status = 'shipped', norbital_approval_id = $2::uuid WHERE norbital_id = $1::uuid`,
				[id, APPROVAL_A]
			);
			await lock(client, 'record_mutation', id);
		});

		// A second, unrelated write to the locked record is rejected by _approval_lock_gate.
		await expect(
			inViaOps(pool, (client) =>
				client
					.query(`UPDATE orders SET status = 'cancelled' WHERE norbital_id = $1::uuid`, [id])
					.then()
			)
		).rejects.toThrow(/pending approval request/);

		// The locked value is unchanged and still stamped.
		const live = await pool.query<{ status: string; approval: string | null }>(
			`SELECT status, norbital_approval_id AS approval FROM orders WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(live.rows[0]).toMatchObject({ status: 'shipped', approval: APPROVAL_A });
	});

	it('restores prior values when a gated update is rejected', async () => {
		const id = await insertOrder(pool, 'pending');
		await inViaOps(pool, async (client) => {
			await client.query(
				`UPDATE orders SET status = 'shipped', norbital_approval_id = $2::uuid WHERE norbital_id = $1::uuid`,
				[id, APPROVAL_A]
			);
			await lock(client, 'record_mutation', id);
		});

		// Reject → restoreRecordBeforeApproval: roll live back to the newest history row NOT stamped
		// by this approval. Runs under the terminal-transition bypass so the lock gate permits it.
		await inViaOps(
			pool,
			async (client) => {
				await client.query(
					`UPDATE orders AS live
					    SET norbital_approval_id = baseline.norbital_approval_id,
					        status = baseline.status
					   FROM (
					          SELECT norbital_approval_id, status
					            FROM orders_history
					           WHERE norbital_id = $1::uuid
					             AND norbital_approval_id IS DISTINCT FROM $2::uuid
					           ORDER BY upper(norbital_sys_period::tstzrange) DESC NULLS LAST, norbital_row_version DESC
					           LIMIT 1
					        ) AS baseline
					  WHERE live.norbital_id = $1::uuid`,
					[id, APPROVAL_A]
				);
				await client.query(`DELETE FROM _approval_lock WHERE approval_request_id = $1::uuid`, [
					APPROVAL_A
				]);
			},
			{ terminalTransition: true }
		);

		const live = await pool.query<{ status: string; approval: string | null }>(
			`SELECT status, norbital_approval_id AS approval FROM orders WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(live.rows[0]).toMatchObject({ status: 'pending', approval: null });
	});

	it('re-inserts the record when a gated delete is rejected', async () => {
		const id = await insertOrder(pool, 'confirmed');
		// Gated delete: stamp, delete, lock.
		await inViaOps(pool, async (client) => {
			await client.query(
				`UPDATE orders SET norbital_approval_id = $2::uuid WHERE norbital_id = $1::uuid`,
				[id, APPROVAL_A]
			);
			await client.query(`DELETE FROM orders WHERE norbital_id = $1::uuid`, [id]);
			await lock(client, 'record_delete', id);
		});
		const gone = await pool.query(`SELECT 1 FROM orders WHERE norbital_id = $1::uuid`, [id]);
		expect(gone.rowCount).toBe(0);

		// Reject → restoreRecordBeforeApproval (record_delete): re-insert the newest history version
		// with a fresh period, then clear the stamp.
		await inViaOps(
			pool,
			async (client) => {
				await client.query(
					`INSERT INTO orders (
					   norbital_id, norbital_created_at, norbital_updated_at,
					   norbital_row_version, norbital_approval_id, status, norbital_sys_period
					 )
					 SELECT norbital_id, norbital_created_at, norbital_updated_at,
					        norbital_row_version, norbital_approval_id, status,
					        tstzrange(now(), NULL, '[)')::text
					   FROM orders_history
					  WHERE norbital_id = $1::uuid
					  ORDER BY upper(norbital_sys_period::tstzrange) DESC NULLS LAST, norbital_row_version DESC
					  LIMIT 1
					 ON CONFLICT (norbital_id) DO NOTHING`,
					[id]
				);
				await client.query(
					`UPDATE orders SET norbital_approval_id = NULL WHERE norbital_id = $1::uuid`,
					[id]
				);
				await client.query(`DELETE FROM _approval_lock WHERE approval_request_id = $1::uuid`, [
					APPROVAL_A
				]);
			},
			{ terminalTransition: true }
		);

		const live = await pool.query<{ status: string; approval: string | null }>(
			`SELECT status, norbital_approval_id AS approval FROM orders WHERE norbital_id = $1::uuid`,
			[id]
		);
		expect(live.rowCount).toBe(1);
		expect(live.rows[0]).toMatchObject({ status: 'confirmed', approval: null });
	});
});
