import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema, seedApprovalRequest } from '../support/pod-schema.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';

/**
 * The batched delete, against the real DDL it has to keep satisfying.
 *
 * `deleteMany` replaced a per-record loop that cost a SELECT, a DELETE, a change-feed INSERT and
 * an audit INSERT per record — on a remote database that is minutes for a payroll rebuild's few
 * hundred rows. What must not change is everything the database does per row: `_ops_guard`,
 * `_approval_lock_gate` and `_norbital_versioning` are FOR EACH ROW triggers, so these tests run
 * the shipped SQL (see support/pod-schema.ts) and assert both halves — that the statement count
 * no longer scales with the batch, and that history, the change feed, the approval lock, hook
 * order and atomicity are exactly what a record-at-a-time loop produced.
 */

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** Mirrors the `orders` table in support/pod-schema.ts. */
const orders = pgTable('orders', {
	norbital_id: uuid('norbital_id').primaryKey().defaultRandom(),
	norbital_created_at: timestamp('norbital_created_at', { withTimezone: true }).defaultNow(),
	norbital_updated_at: timestamp('norbital_updated_at', { withTimezone: true }).defaultNow(),
	norbital_sys_period: text('norbital_sys_period'),
	norbital_row_version: integer('norbital_row_version'),
	norbital_approval_id: uuid('norbital_approval_id'),
	status: text('status')
});

type HookCalls = { readonly before: string[]; readonly after: string[] };

/** Test-controlled collection behavior + hook bundle, swapped per test. */
const state = vi.hoisted(() => ({
	deleteAllowed: true,
	beforeHook: undefined as undefined | ((event: { existing: Record<string, unknown> }) => unknown),
	afterHook: undefined as undefined | ((event: { record: Record<string, unknown> }) => unknown),
	auditFailure: false,
	auditBatches: [] as { entityId: string }[][]
}));

vi.mock('$lib/server/collection/workspace-collections.js', () => ({
	getWorkspaceCollection: () => ({ delete: {} }),
	allowsMutation: () => state.deleteAllowed,
	collectionHooks: (_behavior: unknown, action: string) =>
		action === 'delete'
			? {
					...(state.beforeHook ? { before: state.beforeHook } : {}),
					...(state.afterHook ? { after: state.afterHook } : {})
				}
			: undefined
}));

vi.mock('$lib/server/collection/hook-api-context.server.js', async () => {
	const { AsyncLocalStorage } = await import('node:async_hooks');
	return {
		beforeApiStorage: new AsyncLocalStorage(),
		getBeforeApi: async () => ({}),
		getHookApi: async () => ({}),
		getElevatedAfterApi: async () => ({}),
		getElevatedAfterHookApi: async () => ({})
	};
});

vi.mock('$lib/server/audit/audit_event.server.js', () => ({
	buildAuditEventPayload: () => ({}),
	sendAuditEvent: async () => undefined,
	sendAuditEvents: async (events: { params: { entityId: string } }[]) => {
		if (state.auditFailure) throw new Error('injected audit failure');
		state.auditBatches.push(events.map((event) => ({ entityId: event.params.entityId })));
	}
}));

const { createWorkspaceContext } = await import('$lib/server/bootstrap/workspace_store.js');
const { deleteMany, deleteRecord } =
	await import('$lib/server/collection/collection_ops.server.js');

/** Every statement the connection saw, so a round-trip count is an assertion, not a guess. */
let statements: string[] = [];

function statementText(input: unknown): string {
	if (typeof input === 'string') return input;
	const text = (input as { text?: string }).text;
	return typeof text === 'string' ? text : '';
}

/**
 * A ProvisionedContext pinned to one connection — the shape collection_ops relies on, where the
 * drizzle mutation db and the transaction GUC share a single session.
 */
function contextOn(client: PoolClient): ProvisionedContext {
	const query = (input: unknown, params?: unknown[]) => {
		statements.push(statementText(input));
		// pg accepts both a bare SQL string and drizzle's query-config object.
		return client.query(input as string, params as unknown[]);
	};
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

	return createWorkspaceContext({
		provision: 'provisioned',
		// Only getCollection (metadata) and manifest.integrations are reached by the delete path.
		manifestCtx: {
			nodeId: 'test-node',
			manifest: { integrations: {} },
			getCollection: () => ({})
		} as unknown as Parameters<typeof createWorkspaceContext>[0]['manifestCtx'],
		organization: { norbital_id: ORG_ID, name: 'Test Org' },
		baseScope: {
			requestor: { norbital_id: USER_ID, role: 'admin' },
			organization: { norbital_id: ORG_ID, name: 'Test Org' }
		} as unknown as Parameters<typeof createWorkspaceContext>[0]['baseScope'],
		tenantDb,
		tableRegistry: { orders }
	});
}

describe('Batched collection delete (real Postgres triggers)', () => {
	let pg: PgHarness;
	let pool: Pool;
	let client: PoolClient;
	let ctx: ProvisionedContext;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		// The suite fabricates locks under this request id; the lock's foreign key needs it to exist.
		await seedApprovalRequest(pool, '99999999-9999-4999-8999-999999999999');
		client = await pool.connect();
		ctx = contextOn(client);
	}, 180_000);

	afterAll(async () => {
		client?.release();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		state.deleteAllowed = true;
		state.beforeHook = undefined;
		state.afterHook = undefined;
		state.auditFailure = false;
		state.auditBatches = [];
		// A failed assertion can leave the pinned connection mid-transaction; start clean.
		await client.query('ROLLBACK').catch(() => undefined);
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		// Locks first: while one stands, _approval_lock_gate rejects the delete it guards.
		// Ledger last: clearing `orders` archives whatever is left into it.
		await client.query('DELETE FROM _approval_lock');
		await client.query('DELETE FROM orders');
		await client.query(`DELETE FROM record_history WHERE collection_name = 'orders'`);
		await client.query('DELETE FROM sync_outbox');
		await client.query('COMMIT');
		statements = [];
	});

	/** Seed rows through the authoritative path (via_ops), returning ids in insertion order. */
	async function seed(count: number): Promise<string[]> {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		const ids: string[] = [];
		for (let index = 0; index < count; index++) {
			const { rows } = await client.query<{ norbital_id: string }>(
				`INSERT INTO orders (status) VALUES ($1) RETURNING norbital_id`,
				[`row-${index}`]
			);
			ids.push(rows[0].norbital_id);
		}
		await client.query('COMMIT');
		statements = [];
		return ids;
	}

	function matching(pattern: RegExp): string[] {
		return statements.filter((statement) => pattern.test(statement));
	}

	it('removes exactly the requested rows in a constant number of round trips', async () => {
		const ids = await seed(50);
		const keep = ids.slice(40);

		await deleteMany(ctx, 'orders', ids.slice(0, 40), { isElevated: true });

		const live = await pool.query<{ norbital_id: string }>(`SELECT norbital_id FROM orders`);
		expect(live.rows.map((row) => row.norbital_id).sort()).toEqual([...keep].sort());

		// One SELECT, one DELETE, one change-feed INSERT — whatever the batch size.
		expect(matching(/^select .*from "orders"/is)).toHaveLength(1);
		expect(matching(/^delete from "orders"/i)).toHaveLength(1);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(1);
		// BEGIN + set_config + the three above + COMMIT, plus the audit INSERT (stubbed here).
		// The record-at-a-time loop paid all six of those per record, not per batch.
		expect(statements).toHaveLength(6);
	});

	it('archives every deleted row to history, and only those rows', async () => {
		const ids = await seed(6);
		await deleteMany(ctx, 'orders', ids.slice(0, 4), { isElevated: true });

		const history = await pool.query<{ norbital_id: string; status: string }>(
			`SELECT record_id AS norbital_id, values->>'status' AS status
			   FROM record_history
			  WHERE collection_name = 'orders'
			  ORDER BY values->>'status'`
		);
		expect(history.rows.map((row) => row.status)).toEqual(['row-0', 'row-1', 'row-2', 'row-3']);
		// Every archived version is closed at the delete.
		const open = await pool.query(
			`SELECT 1 FROM record_history
			  WHERE collection_name = 'orders' AND valid_to IS NULL`
		);
		expect(open.rowCount).toBe(0);
	});

	it('emits one change-feed row per record, in caller order', async () => {
		const ids = await seed(5);
		const ordered = [ids[3], ids[0], ids[4], ids[1], ids[2]];
		await deleteMany(ctx, 'orders', ordered, { isElevated: true });

		const feed = await pool.query<{ record_id: string; action: string; collection: string }>(
			`SELECT record_id, action, collection FROM sync_outbox ORDER BY seq`
		);
		expect(feed.rows.map((row) => row.record_id)).toEqual(ordered);
		expect(feed.rows.every((row) => row.action === 'delete' && row.collection === 'orders')).toBe(
			true
		);
	});

	it('runs the delete hooks once per record, in caller order', async () => {
		const ids = await seed(4);
		const calls: HookCalls = { before: [], after: [] };
		state.beforeHook = ({ existing }) => {
			calls.before.push(String(existing.status));
		};
		state.afterHook = ({ record }) => {
			calls.after.push(String(record.status));
		};

		await deleteMany(ctx, 'orders', [ids[2], ids[0], ids[3]], { isElevated: true });

		expect(calls.before).toEqual(['row-2', 'row-0', 'row-3']);
		expect(calls.after).toEqual(['row-2', 'row-0', 'row-3']);
	});

	it('writes the audit trail as one batch, one event per record, in caller order', async () => {
		const ids = await seed(3);
		await deleteMany(ctx, 'orders', [ids[1], ids[2]], { isElevated: true });

		expect(state.auditBatches).toHaveLength(1);
		expect(state.auditBatches[0].map((event) => event.entityId)).toEqual([ids[1], ids[2]]);
	});

	it('rolls the whole batch back when a before hook throws', async () => {
		const ids = await seed(5);
		state.beforeHook = ({ existing }) => {
			if (existing.status === 'row-3') throw new Error('hook says no');
		};

		await expect(deleteMany(ctx, 'orders', ids, { isElevated: true })).rejects.toThrow(
			'hook says no'
		);

		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(5);
		const feed = await pool.query(`SELECT 1 FROM sync_outbox`);
		expect(feed.rowCount).toBe(0);
		expect(state.auditBatches).toHaveLength(0);
	});

	it('rolls back records, history, and sync when the audit sink fails', async () => {
		const ids = await seed(3);
		state.auditFailure = true;

		await expect(deleteMany(ctx, 'orders', ids, { isElevated: true })).rejects.toThrow(
			'injected audit failure'
		);

		expect(await pool.query(`SELECT 1 FROM orders`)).toMatchObject({ rowCount: 3 });
		expect(
			await pool.query(`SELECT 1 FROM record_history WHERE collection_name = 'orders'`)
		).toMatchObject({ rowCount: 0 });
		expect(await pool.query(`SELECT 1 FROM sync_outbox`)).toMatchObject({ rowCount: 0 });
	});

	it('fails the whole batch when one id is missing, before touching any row', async () => {
		const ids = await seed(3);
		await expect(
			deleteMany(ctx, 'orders', [ids[0], '33333333-3333-4333-8333-333333333333'], {
				isElevated: true
			})
		).rejects.toThrow(/not found/);

		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(3);
	});

	it('is still stopped by the per-row approval lock gate, and takes nothing with it', async () => {
		const ids = await seed(4);
		// A lock the batch cannot see in its own SELECT — only the FOR EACH ROW trigger can.
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await client.query(
			`INSERT INTO _approval_lock (approval_request_id, lock_type, collection_name, record_id)
			 VALUES ($1::uuid, 'record_delete', 'orders', $2::uuid)`,
			['99999999-9999-4999-8999-999999999999', ids[2]]
		);
		await client.query('COMMIT');

		const failure = await deleteMany(ctx, 'orders', ids, { isElevated: true }).then(
			() => null,
			(cause: unknown) => cause
		);
		// The driver wraps the raised error; the trigger's own message is the cause.
		expect(String((failure as { cause?: unknown })?.cause ?? failure)).toMatch(
			/has pending approval request/
		);

		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(4);
		const feed = await pool.query(`SELECT 1 FROM sync_outbox`);
		expect(feed.rowCount).toBe(0);
	});

	it('refuses a record already stamped with a pending approval', async () => {
		const ids = await seed(2);
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await client.query(
			`UPDATE orders SET norbital_approval_id = $1::uuid WHERE norbital_id = $2::uuid`,
			['99999999-9999-4999-8999-999999999999', ids[1]]
		);
		await client.query('COMMIT');

		await expect(deleteMany(ctx, 'orders', ids, { isElevated: true })).rejects.toThrow(
			/pending approval request is active/
		);
		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(2);
	});

	it('rejects the collection when delete is not an allowed mutation', async () => {
		const ids = await seed(1);
		state.deleteAllowed = false;
		await expect(deleteMany(ctx, 'orders', ids)).rejects.toThrow(/does not allow delete/);
		// Elevated callers (after hooks, automations) still pass.
		await deleteMany(ctx, 'orders', ids, { isElevated: true });
		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(0);
	});

	it('deletes a single record through the same path', async () => {
		const ids = await seed(2);
		await deleteRecord(ctx, 'orders', ids[0], { isElevated: true });

		const live = await pool.query<{ norbital_id: string }>(`SELECT norbital_id FROM orders`);
		expect(live.rows.map((row) => row.norbital_id)).toEqual([ids[1]]);
		const feed = await pool.query<{ record_id: string }>(`SELECT record_id FROM sync_outbox`);
		expect(feed.rows.map((row) => row.record_id)).toEqual([ids[0]]);
		const history = await pool.query(
			`SELECT 1 FROM record_history
			  WHERE collection_name = 'orders' AND record_id = $1::uuid`,
			[ids[0]]
		);
		expect(history.rowCount).toBe(1);
	});

	it('splits a batch past the statement ceiling into chunks, not into round trips per record', async () => {
		// Past DELETE_CHUNK / OUTBOX_CHUNK (1,000), so the chunking is actually exercised.
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		const seeded = await client.query<{ norbital_id: string }>(
			`INSERT INTO orders (status) SELECT 'row-' || g FROM generate_series(1, 1100) g
			 RETURNING norbital_id`
		);
		await client.query('COMMIT');
		statements = [];
		const ids = seeded.rows.map((row) => row.norbital_id);

		await deleteMany(ctx, 'orders', ids, { isElevated: true });

		const live = await pool.query(`SELECT 1 FROM orders`);
		expect(live.rowCount).toBe(0);
		const history = await pool.query(
			`SELECT 1 FROM record_history WHERE collection_name = 'orders'`
		);
		expect(history.rowCount).toBe(1100);
		const feed = await pool.query<{ record_id: string }>(
			`SELECT record_id FROM sync_outbox ORDER BY seq`
		);
		expect(feed.rows.map((row) => row.record_id)).toEqual(ids);
		// Two chunks of each statement for 1,100 records — not 1,100 of anything.
		expect(matching(/^select .*from "orders"/is)).toHaveLength(2);
		expect(matching(/^delete from "orders"/i)).toHaveLength(2);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(2);
	});
});
