import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import type { TScopeRequestor } from '$lib/shared/scope.js';

/**
 * What a terminal approval transition leaves behind — in the database *and* in the change feed.
 *
 * `approval_service` is the second authorized writer of collection tables (collection_ops is the
 * first): resolving a request rolls a rejected create away, restores a rejected update, resurrects
 * a rejected delete, or clears the stamp of an approved one. Those are ordinary record changes as
 * far as the rest of the system is concerned, so each has to appear in `sync_outbox` — the change
 * feed is the *only* way a synced client learns a row changed. A rollback that skips the feed is
 * invisible: the server row is gone and every client still lists it, forever.
 *
 * These tests drive the real `withdrawApprovalRequest` / `processAction` against the shipped DDL,
 * and assert both halves — the row's final state and the feed row that announces it.
 */

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '88888888-8888-4888-8888-888888888888';

/** The workspace the service resolves through, rebound to this suite's pinned connection. */
const state = vi.hoisted(() => ({ workspace: null as unknown }));

vi.mock('$lib/server/bootstrap/workspace_store.js', () => ({
	getWorkspace: () => state.workspace
}));

const { withdrawApprovalRequest, processAction } =
	await import('$lib/server/collection/access_control/approval_service.server.js');
const { readSyncOutboxBatch, outboxCursorForSeq } =
	await import('$lib/server/collection/sync/outbox-tailer.server.js');

const requestor = { norbital_id: USER_ID } as unknown as TScopeRequestor;

function contextOn(client: PoolClient): ProvisionedContext {
	const query = (input: unknown, params?: unknown[]) =>
		client.query(input as string, params as unknown[]);
	const tenantDb = {
		query,
		transaction: async <T>(fn: (tx: { query: typeof query }) => Promise<T>): Promise<T> => {
			await query('BEGIN');
			try {
				const result = await fn({ query });
				await query('COMMIT');
				return result;
			} catch (cause) {
				await query('ROLLBACK').catch(() => undefined);
				throw cause;
			}
		}
	} as unknown as TenantDbClient;
	return {
		tenantDb,
		manifestCtx: { getRelationshipsForCollection: () => [] },
		// The approving user's teams — all `processAction` reads off the workspace.
		baseScope: { requestor: { norbital_id: USER_ID, team_members: [{ norbital_id: TEAM_ID }] } }
	} as unknown as ProvisionedContext;
}

type OutboxRow = { collection: string; record_id: string; action: string };
type HistoryRow = { status: string; approval: string | null; row_version: number };

describe('Approval terminal transitions (real Postgres triggers)', () => {
	let pg: PgHarness;
	let pool: Pool;
	let client: PoolClient;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		client = await pool.connect();
		state.workspace = contextOn(client);
		await pool.query(
			`INSERT INTO "user" (norbital_id, email, name) VALUES ($1::uuid, 'requestor@test', 'Requestor')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[USER_ID]
		);
	}, 180_000);

	afterAll(async () => {
		client?.release();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		await client.query('ROLLBACK').catch(() => undefined);
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await client.query('DELETE FROM _approval_lock');
		await client.query('DELETE FROM requestor');
		await client.query('DELETE FROM approval_request');
		await client.query('DELETE FROM orders');
		await client.query('DELETE FROM orders_history');
		await client.query('DELETE FROM sync_outbox');
		await client.query('COMMIT');
	});

	/** Statements a write that goes through collection_ops issues: the row plus its feed entry. */
	async function viaOps(run: (tx: PoolClient) => Promise<void>): Promise<void> {
		const tx = await pool.connect();
		try {
			await tx.query('BEGIN');
			await tx.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
			await run(tx);
			await tx.query('COMMIT');
		} catch (cause) {
			await tx.query('ROLLBACK').catch(() => undefined);
			throw cause;
		} finally {
			tx.release();
		}
	}

	async function feed(tx: PoolClient, action: string, id: string): Promise<void> {
		await tx.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version)
			 SELECT 'orders', norbital_id, $2, norbital_row_version FROM orders WHERE norbital_id = $1::uuid`,
			[id, action]
		);
	}

	/**
	 * Open a gated request over one record, exactly as collection_ops does: the record is already
	 * written and stamped, and inserting the request materializes its lock.
	 */
	async function openRequest(
		approvalId: string,
		recordId: string,
		lockType: 'record_mutation' | 'record_delete'
	): Promise<void> {
		await viaOps(async (tx) => {
			await tx.query(
				`INSERT INTO approval_request (
				   norbital_id, organization_id, label, approval_config_id, collection_name,
				   status, approval_step_nodes, locked_record_refs
				 ) VALUES ($1::uuid, $2::uuid, 'Order', $3::uuid, 'orders', 'ONGOING', $4::jsonb, $5::jsonb)`,
				[
					approvalId,
					ORG_ID,
					CONFIG_ID,
					JSON.stringify([
						[
							{
								id: 'step-1',
								name: 'Manager',
								description: null,
								teams_that_can_approve: [TEAM_ID],
								status: 'PENDING',
								history: []
							}
						]
					]),
					JSON.stringify([{ collection_name: 'orders', record_id: recordId, lock_type: lockType }])
				]
			);
			await tx.query(
				`INSERT INTO requestor (approval_request_id, user_id) VALUES ($1::uuid, $2::uuid)`,
				[approvalId, USER_ID]
			);
		});
	}

	async function liveOrder(id: string): Promise<HistoryRow | undefined> {
		const { rows } = await pool.query<HistoryRow>(
			`SELECT status, norbital_approval_id AS approval, norbital_row_version AS row_version
			   FROM orders WHERE norbital_id = $1::uuid`,
			[id]
		);
		return rows[0];
	}

	async function orderHistory(id: string): Promise<HistoryRow[]> {
		const { rows } = await pool.query<HistoryRow>(
			`SELECT status, norbital_approval_id AS approval, norbital_row_version AS row_version
			   FROM orders_history WHERE norbital_id = $1::uuid ORDER BY norbital_row_version`,
			[id]
		);
		return rows;
	}

	/**
	 * What the transition itself appended to the change feed. Measured as a delta from the writes
	 * that set the case up, because "the feed already mentions this record" is exactly the state
	 * that let the missing announcement go unnoticed.
	 */
	async function feedSince(watermark: number): Promise<OutboxRow[]> {
		const { rows } = await pool.query<OutboxRow>(
			`SELECT collection, record_id, action FROM sync_outbox WHERE seq > $1 ORDER BY seq`,
			[watermark]
		);
		return rows;
	}

	async function feedWatermark(): Promise<number> {
		const { rows } = await pool.query<{ seq: string | null }>(
			`SELECT MAX(seq)::text AS seq FROM sync_outbox`
		);
		return Number(rows[0]?.seq ?? 0);
	}

	it('withdrawing a gated create removes the row and announces the removal', async () => {
		const approvalId = '44444444-4444-4444-8444-444444444444';
		let id = '';
		// A gated create: one INSERT, already stamped with the pending request (collection_ops.create).
		await viaOps(async (tx) => {
			const { rows } = await tx.query<{ norbital_id: string }>(
				`INSERT INTO orders (status, norbital_approval_id) VALUES ('provisional', $1::uuid)
				 RETURNING norbital_id`,
				[approvalId]
			);
			id = rows[0].norbital_id;
			await feed(tx, 'create', id);
		});
		await openRequest(approvalId, id, 'record_mutation');

		// The evidence for the rollback branch that runs: a create has no pre-approval version, so
		// history is empty, no baseline matches, and the row is dropped rather than restored.
		expect(await orderHistory(id)).toEqual([]);
		const watermark = await feedWatermark();

		await withdrawApprovalRequest(approvalId, requestor);

		expect(await liveOrder(id)).toBeUndefined();
		// Two records changed, so the feed carries two rows: the request's own status transition
		// (a record the Approval tab reads) and the rollback of the record it held.
		expect(await feedSince(watermark)).toEqual([
			{ collection: 'approval_request', record_id: approvalId, action: 'update' },
			{ collection: 'orders', record_id: id, action: 'delete' }
		]);

		// Written is not the same as deliverable. The tailer only hands out rows whose transaction
		// has dropped below the snapshot horizon, so a row written on a connection outside the
		// mutation's transaction would be durable and permanently skipped. Read it back the way
		// the SSE stream does, from the cursor the stream held before the withdrawal.
		const batch = await readSyncOutboxBatch(
			state.workspace as ProvisionedContext,
			await outboxCursorForSeq(state.workspace as ProvisionedContext, String(watermark))
		);
		expect(batch.rows).toEqual([
			expect.objectContaining({
				collection: 'approval_request',
				recordId: approvalId,
				action: 'update'
			}),
			expect.objectContaining({ collection: 'orders', recordId: id, action: 'delete' })
		]);
	});

	it('withdrawing a gated update restores the prior values and announces the change', async () => {
		const approvalId = '55555555-5555-4555-8555-555555555555';
		let id = '';
		await viaOps(async (tx) => {
			const { rows } = await tx.query<{ norbital_id: string }>(
				`INSERT INTO orders (status) VALUES ('pending') RETURNING norbital_id`
			);
			id = rows[0].norbital_id;
			await feed(tx, 'create', id);
		});
		await viaOps(async (tx) => {
			await tx.query(
				`UPDATE orders SET status = 'shipped', norbital_approval_id = $2::uuid
				  WHERE norbital_id = $1::uuid`,
				[id, approvalId]
			);
			await feed(tx, 'update', id);
		});
		await openRequest(approvalId, id, 'record_mutation');

		// Here a pre-approval version does exist — the unstamped row the update archived.
		expect(await orderHistory(id)).toEqual([{ status: 'pending', approval: null, row_version: 1 }]);
		const watermark = await feedWatermark();

		await withdrawApprovalRequest(approvalId, requestor);

		expect(await liveOrder(id)).toMatchObject({ status: 'pending', approval: null });
		expect(await feedSince(watermark)).toEqual([
			{ collection: 'approval_request', record_id: approvalId, action: 'update' },
			{ collection: 'orders', record_id: id, action: 'update' }
		]);
	});

	it('withdrawing a gated delete re-inserts the row and announces it as present again', async () => {
		const approvalId = '66666666-6666-4666-8666-666666666666';
		let id = '';
		await viaOps(async (tx) => {
			const { rows } = await tx.query<{ norbital_id: string }>(
				`INSERT INTO orders (status) VALUES ('confirmed') RETURNING norbital_id`
			);
			id = rows[0].norbital_id;
			await feed(tx, 'create', id);
		});
		await viaOps(async (tx) => {
			await tx.query(
				`UPDATE orders SET norbital_approval_id = $2::uuid WHERE norbital_id = $1::uuid`,
				[id, approvalId]
			);
			await feed(tx, 'update', id);
			await tx.query(`DELETE FROM orders WHERE norbital_id = $1::uuid`, [id]);
			await tx.query(
				`INSERT INTO sync_outbox (collection, record_id, action) VALUES ('orders', $1::uuid, 'delete')`,
				[id]
			);
		});
		await openRequest(approvalId, id, 'record_delete');
		const watermark = await feedWatermark();

		await withdrawApprovalRequest(approvalId, requestor);

		expect(await liveOrder(id)).toMatchObject({ status: 'confirmed', approval: null });
		expect(await feedSince(watermark)).toEqual([
			{ collection: 'approval_request', record_id: approvalId, action: 'update' },
			{ collection: 'orders', record_id: id, action: 'create' }
		]);
	});

	it('approving clears the stamp and announces the record as changed', async () => {
		const approvalId = '77777777-7777-4777-8777-777777777777';
		let id = '';
		await viaOps(async (tx) => {
			const { rows } = await tx.query<{ norbital_id: string }>(
				`INSERT INTO orders (status, norbital_approval_id) VALUES ('provisional', $1::uuid)
				 RETURNING norbital_id`,
				[approvalId]
			);
			id = rows[0].norbital_id;
			await feed(tx, 'create', id);
		});
		await openRequest(approvalId, id, 'record_mutation');
		const watermark = await feedWatermark();

		await processAction(
			'APPROVED',
			{ norbital_id: approvalId } as unknown as Parameters<typeof processAction>[1],
			{ supercede_teams: [] } as unknown as Parameters<typeof processAction>[2],
			requestor,
			false
		);

		// An approved record keeps its values and loses its stamp — a change like any other, and
		// one a client must be told about or it keeps showing the record as pending forever.
		expect(await liveOrder(id)).toMatchObject({ status: 'provisional', approval: null });
		expect(await feedSince(watermark)).toEqual([
			{ collection: 'approval_request', record_id: approvalId, action: 'update' },
			{ collection: 'orders', record_id: id, action: 'update' }
		]);
	});
});
