import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import type { TScopeRequestor } from '$lib/shared/scope.js';

/**
 * Which snapshot an approval decision is computed from.
 *
 * Locking the request row is not the same as deciding from it. An approver's client hands the
 * server a request it read some time ago; if the server builds the new step nodes and lock set
 * from *that*, the write is a whole-row UPSERT of a stale state and it silently erases whatever
 * landed in between. The status guard does not catch it — on a multi-step flow neither the
 * intervening write nor this one is terminal, so both pass.
 *
 * Both cases below are ordinary sequential writes. They do not need concurrency to fail: a stale
 * snapshot is stale whether it lost a race by a millisecond or by a minute, and the fix — read the
 * row under the lock, decide from that — is what makes the second write see the first.
 */

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '99999999-9999-4999-8999-999999999999';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';
const TEAM_ID = '88888888-8888-4888-8888-888888888888';

const state = vi.hoisted(() => ({ workspace: null as unknown }));

vi.mock('$lib/server/bootstrap/workspace_store.js', () => ({
	getWorkspace: () => state.workspace
}));

const { processAction, loadApprovalRequestRow } =
	await import('$lib/server/collection/access_control/approval_service.server.js');

const requestor = { norbital_id: USER_ID } as unknown as TScopeRequestor;
const anyConfig = { supercede_teams: [] } as unknown as Parameters<typeof processAction>[2];

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
		baseScope: { requestor: { norbital_id: USER_ID, team_members: [{ norbital_id: TEAM_ID }] } }
	} as unknown as ProvisionedContext;
}

type Step = {
	id: string;
	name: string;
	description: null;
	teams_that_can_approve: string[];
	status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';
	history: { action: string; actionBy: string }[];
};

function pendingStep(id: string, name: string): Step {
	return {
		id,
		name,
		description: null,
		teams_that_can_approve: [TEAM_ID],
		status: 'PENDING',
		history: []
	};
}

describe('Approval decisions are computed from the locked row', () => {
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
			`INSERT INTO "user" (norbital_id, email, name)
			 VALUES ($1::uuid, 'requestor@test', 'Requestor'), ($2::uuid, 'other@test', 'Other')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[USER_ID, OTHER_USER_ID]
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

	/** A write the way collection_ops issues it: on its own connection, under the ops guard. */
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

	/** A gated record plus the open request that holds it. */
	async function openRequest(approvalId: string, flow: Step[]): Promise<string> {
		let recordId = '';
		await viaOps(async (tx) => {
			const { rows } = await tx.query<{ norbital_id: string }>(
				`INSERT INTO orders (status, norbital_approval_id) VALUES ('provisional', $1::uuid)
				 RETURNING norbital_id`,
				[approvalId]
			);
			recordId = rows[0].norbital_id;
			await tx.query(
				`INSERT INTO approval_request (
				   norbital_id, organization_id, label, approval_config_id, collection_name,
				   status, approval_step_nodes, locked_record_refs
				 ) VALUES ($1::uuid, $2::uuid, 'Order', $3::uuid, 'orders', 'ONGOING', $4::jsonb, $5::jsonb)`,
				[
					approvalId,
					ORG_ID,
					CONFIG_ID,
					JSON.stringify([flow]),
					JSON.stringify([
						{ collection_name: 'orders', record_id: recordId, lock_type: 'record_mutation' }
					])
				]
			);
			await tx.query(
				`INSERT INTO requestor (approval_request_id, user_id) VALUES ($1::uuid, $2::uuid)`,
				[approvalId, USER_ID]
			);
		});
		return recordId;
	}

	function currentFlow(nodes: unknown): Step[] {
		const stacks = nodes as Step[][];
		return stacks.at(-1) ?? [];
	}

	it('a second approver stamps the step that is pending now, not the one they were shown', async () => {
		const approvalId = '44444444-4444-4444-8444-444444444444';
		await openRequest(approvalId, [
			pendingStep('step-1', 'Manager'),
			pendingStep('step-2', 'Head')
		]);

		// What an approver's browser is holding: both steps pending.
		const stale = await loadApprovalRequestRow(approvalId);
		expect(currentFlow(stale?.approval_step_nodes).map((s) => s.status)).toEqual([
			'PENDING',
			'PENDING'
		]);

		// Someone else approves step 1 first. The request stays ONGOING, so nothing about it is
		// terminal and no status check will refuse what comes next.
		await processAction('APPROVED', stale!, anyConfig, requestor, false);
		const afterFirst = await loadApprovalRequestRow(approvalId);
		expect(afterFirst?.status).toBe('ONGOING');

		// The second approver acts from the snapshot taken before any of that.
		await processAction(
			'APPROVED',
			stale!,
			anyConfig,
			{ norbital_id: OTHER_USER_ID } as unknown as TScopeRequestor,
			false
		);

		const settled = await loadApprovalRequestRow(approvalId);
		const steps = currentFlow(settled?.approval_step_nodes);
		// Step 1 keeps the decision it already had. Rebuilding the flow from the stale snapshot would
		// have re-stamped step 1 with the second approver and left step 2 pending forever — the first
		// approval erased, and the request stuck one step short of resolving.
		expect(steps.map((s) => s.id)).toEqual(['step-1', 'step-2']);
		expect(steps[0].history.map((h) => h.actionBy)).toEqual([USER_ID]);
		expect(steps.map((s) => s.status)).toEqual(['APPROVED', 'APPROVED']);
		expect(settled?.status).toBe('APPROVED');
	});

	it('an approval does not resurrect the flow or the lock set a revision replaced', async () => {
		const approvalId = '55555555-5555-4555-8555-555555555555';
		const originalRecord = await openRequest(approvalId, [pendingStep('step-1', 'Manager')]);

		const stale = await loadApprovalRequestRow(approvalId);

		// The requestor revises the record: `restartApprovalRequestForRevision` appends a fresh flow
		// and recomputes the lock set. Written here directly, because what matters is only that the
		// row moved on while an approver held the old one.
		const revisedRecord = '66666666-6666-4666-8666-666666666666';
		await viaOps(async (tx) => {
			await tx.query(
				`INSERT INTO orders (norbital_id, status, norbital_approval_id)
				 VALUES ($1::uuid, 'revised', $2::uuid)`,
				[revisedRecord, approvalId]
			);
			await tx.query(
				`UPDATE approval_request
				    SET approval_step_nodes = $2::jsonb, locked_record_refs = $3::jsonb
				  WHERE norbital_id = $1::uuid`,
				[
					approvalId,
					JSON.stringify([
						[{ ...pendingStep('step-1', 'Manager'), status: 'REQUEST_FOR_CHANGE' }],
						[pendingStep('step-1-revised', 'Manager')]
					]),
					JSON.stringify([
						{ collection_name: 'orders', record_id: revisedRecord, lock_type: 'record_mutation' }
					])
				]
			);
		});

		await processAction('APPROVED', stale!, anyConfig, requestor, false);

		const settled = await loadApprovalRequestRow(approvalId);
		// The decision landed on the revised flow, and the archived first flow survived. Writing the
		// snapshot back would have approved a record nobody reviewed under a flow that was already
		// closed.
		expect((settled?.approval_step_nodes as Step[][]).length).toBe(2);
		expect(currentFlow(settled?.approval_step_nodes).map((s) => s.id)).toEqual(['step-1-revised']);

		// And it released the record the revision actually locked. The original was never in the
		// current lock set, so it keeps its stamp; the revised one loses it.
		const stamps = await pool.query<{ id: string; approval: string | null }>(
			`SELECT norbital_id AS id, norbital_approval_id AS approval FROM orders
			  WHERE norbital_id = ANY($1::uuid[])`,
			[[originalRecord, revisedRecord]]
		);
		const byId = new Map(stamps.rows.map((r) => [r.id, r.approval]));
		expect(byId.get(revisedRecord)).toBeNull();
		expect(byId.get(originalRecord)).toBe(approvalId);
	});
});
