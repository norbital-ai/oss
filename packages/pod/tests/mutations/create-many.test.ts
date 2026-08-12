import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { customType, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';

/**
 * Parameter-aware create batching against the real tenant DDL.
 *
 * The important boundary is the root insert's 5,000-row memory cap. Crossing it must preserve
 * caller order across root, sync and audit chunks without turning any of those writes back into a
 * per-record loop. The failure cases deliberately happen after an earlier statement has succeeded,
 * proving that every chunk and hook remains inside the one authoritative transaction.
 */

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ROOT_CHUNK_BOUNDARY = 5_000;
const tstzrange = customType<{ data: string }>({ dataType: () => 'tstzrange' });

const orders = pgTable('orders', {
	norbital_id: uuid('norbital_id').primaryKey().defaultRandom(),
	norbital_created_at: timestamp('norbital_created_at', { withTimezone: true }).defaultNow(),
	norbital_updated_at: timestamp('norbital_updated_at', { withTimezone: true }).defaultNow(),
	norbital_sys_period: tstzrange('norbital_sys_period'),
	norbital_row_version: integer('norbital_row_version'),
	norbital_approval_id: uuid('norbital_approval_id'),
	status: text('status')
});

type CreateHookEvent = {
	readonly input?: Record<string, unknown>;
	readonly record?: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
	beforeHook: undefined as undefined | ((event: CreateHookEvent) => unknown),
	afterHook: undefined as undefined | ((event: CreateHookEvent) => unknown)
}));

vi.mock('$lib/server/collection/workspace-collections.js', () => ({
	getWorkspaceCollection: () => ({ create: {} }),
	allowsMutation: () => true,
	collectionHooks: (_behavior: unknown, action: string) =>
		action === 'create'
			? {
					...(state.beforeHook ? { before: state.beforeHook } : {}),
					...(state.afterHook ? { after: state.afterHook } : {})
				}
			: undefined
}));

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => ({
		collections: {},
		relationships: {},
		registered: { inputSchemas: {}, integrationBindings: {} }
	})
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

const { createWorkspaceContext, withRequestWorkspaceCtx } =
	await import('$lib/server/bootstrap/workspace_store.js');
const { createMany } = await import('$lib/server/collection/collection_ops.server.js');

let statements: string[] = [];

function statementText(input: unknown): string {
	if (typeof input === 'string') return input;
	const text = (input as { text?: string }).text;
	return typeof text === 'string' ? text : '';
}

function contextOn(client: PoolClient): ProvisionedContext {
	const query = (input: unknown, params?: unknown[]) => {
		statements.push(statementText(input));
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
		manifestCtx: {
			nodeId: 'test-node',
			manifest: { integrations: {} },
			getCollection: () => ({}),
			getRelationshipsForCollection: () => []
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

function recordId(index: number): string {
	return `30000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
}

function batch(count: number): {
	readonly ids: string[];
	readonly inputs: { status: string }[];
} {
	return {
		ids: Array.from({ length: count }, (_, index) => recordId(index)),
		inputs: Array.from({ length: count }, (_, index) => ({ status: `row-${index}` }))
	};
}

function matching(pattern: RegExp): string[] {
	return statements.filter((statement) => pattern.test(statement));
}

describe('Batched collection create (real Postgres)', () => {
	let pg: PgHarness;
	let pool: Pool;
	let client: PoolClient;
	let ctx: ProvisionedContext;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		client = await pool.connect();
		ctx = contextOn(client);
	}, 180_000);

	afterAll(async () => {
		client?.release();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		state.beforeHook = undefined;
		state.afterHook = undefined;
		await client.query('ROLLBACK').catch(() => undefined);
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await client.query('DELETE FROM orders');
		await client.query('DELETE FROM orders_history');
		await client.query('DELETE FROM sync_outbox');
		// The shipped append-only trigger rejects DELETE; fixture teardown may still truncate.
		await client.query('TRUNCATE audit_event');
		await client.query('COMMIT');
		statements = [];
	});

	it('crosses the 5,000-row root boundary with exact rows, order, and bounded statements', async () => {
		const { ids, inputs } = batch(ROOT_CHUNK_BOUNDARY + 1);
		const before: string[] = [];
		const after: string[] = [];
		state.beforeHook = ({ input }) => {
			before.push(String(input?.status));
		};
		state.afterHook = ({ record }) => {
			after.push(String(record?.status));
		};

		const created = await withRequestWorkspaceCtx(ctx, () =>
			createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
		);

		expect(created.map((record) => record.norbital_id)).toEqual(ids);
		expect(created.map((record) => record.status)).toEqual(inputs.map(({ status }) => status));
		expect(before).toEqual(inputs.map(({ status }) => status));
		expect(after).toEqual(inputs.map(({ status }) => status));

		const live = await pool.query<{ norbital_id: string; status: string }>(
			`SELECT norbital_id, status FROM orders ORDER BY norbital_id`
		);
		expect(live.rows.map((record) => record.norbital_id)).toEqual(ids);
		expect(live.rows.map((record) => record.status)).toEqual(inputs.map(({ status }) => status));

		const sync = await pool.query<{ record_id: string }>(
			`SELECT record_id FROM sync_outbox ORDER BY seq`
		);
		expect(sync.rows.map((record) => record.record_id)).toEqual(ids);
		const audit = await pool.query<{ record_id: string }>(
			`SELECT record_id FROM audit_event ORDER BY ctid`
		);
		expect(audit.rows.map((record) => record.record_id)).toEqual(ids);

		expect(matching(/^insert into "orders"/i)).toHaveLength(2);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(1);
		expect(matching(/^insert into "audit_event"/i)).toHaveLength(2);
		// BEGIN + set_config + two roots + sync + two audits + COMMIT.
		expect(statements).toHaveLength(8);
	}, 180_000);

	it('rolls back root rows and sync when a late after hook throws', async () => {
		const { ids, inputs } = batch(6);
		state.afterHook = ({ record }) => {
			if (record?.status === 'row-5') throw new Error('late hook failure');
		};

		await expect(
			withRequestWorkspaceCtx(ctx, () =>
				createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
			)
		).rejects.toThrow('late hook failure');

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rolls back root rows and sync when the audit insert fails', async () => {
		await client.query(`
			CREATE FUNCTION test_reject_create_audit() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'injected audit failure';
			END;
			$$ LANGUAGE plpgsql
		`);
		await client.query(`
			CREATE TRIGGER test_reject_create_audit
			BEFORE INSERT ON audit_event
			FOR EACH STATEMENT EXECUTE FUNCTION test_reject_create_audit()
		`);
		const { ids, inputs } = batch(6);

		try {
			const failure = await withRequestWorkspaceCtx(ctx, () =>
				createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
			).then(
				() => null,
				(cause: unknown) => cause
			);
			expect(String((failure as { cause?: unknown })?.cause ?? failure)).toContain(
				'injected audit failure'
			);
		} finally {
			await client.query('DROP TRIGGER IF EXISTS test_reject_create_audit ON audit_event');
			await client.query('DROP FUNCTION IF EXISTS test_reject_create_audit()');
		}

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rolls back the first root chunk when a constraint rejects the second', async () => {
		await client.query(
			'ALTER TABLE orders ADD CONSTRAINT test_orders_status_unique UNIQUE (status)'
		);
		const { ids, inputs } = batch(ROOT_CHUNK_BOUNDARY + 1);
		inputs[ROOT_CHUNK_BOUNDARY] = { status: 'row-0' };

		try {
			await expect(
				withRequestWorkspaceCtx(ctx, () =>
					createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
				)
			).rejects.toThrow(/status/i);
		} finally {
			await client.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS test_orders_status_unique');
		}

		expect(matching(/^insert into "orders"/i)).toHaveLength(2);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(0);
		expect(matching(/^insert into "audit_event"/i)).toHaveLength(0);
		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	}, 180_000);
});
