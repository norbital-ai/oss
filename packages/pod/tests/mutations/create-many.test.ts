import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
	boolean,
	date,
	integer,
	jsonb,
	numeric,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uuid
} from 'drizzle-orm/pg-core';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { createHostTenantDb } from '../support/host-tenant-db.js';
import { applyPodSchema, seedTestUser } from '../support/pod-schema.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { namedJsonbColumn, norbitalTable } from '$lib/authoring/schema/table.js';
import { attachColumnCustom } from '$lib/authoring/schema/columns.js';

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
const orderState = pgEnum('test_order_state', ['OPEN', 'CLOSED']);

/** Same collection `applyPodSchema` materializes, plus the extra columns this suite ALTERs on. */
const orders = norbitalTable(
	'orders',
	{
		status: text(),
		work_date: date(),
		occurred_at: timestamp({ withTimezone: true }),
		optional_at: timestamp({ withTimezone: true }),
		enabled: boolean().default(true),
		quantity: integer().default(7),
		metadata: jsonb(),
		state: orderState()
	},
	{ history: true }
);

const unsupportedNumericOrders = pgTable('unsupported_numeric_orders', {
	norbital_id: uuid('norbital_id'),
	amount: numeric('amount')
});

const unsupportedCustomOrders = pgTable('unsupported_custom_orders', {
	norbital_id: uuid('norbital_id'),
	custom_value: namedJsonbColumn('workspace-specific')
});
attachColumnCustom(unsupportedCustomOrders.custom_value, {
	kind: 'workspace-specific',
	definitionBacked: true
});

type CreateHookEvent = {
	readonly input?: Record<string, unknown>;
	readonly record?: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
	beforeHook: undefined as undefined | ((event: CreateHookEvent) => unknown),
	afterHook: undefined as undefined | ((event: CreateHookEvent) => unknown),
	beforeBatchHook: undefined as
		undefined | ((event: { inputs: readonly Record<string, unknown>[] }) => unknown),
	afterBatchHook: undefined as
		undefined | ((event: { records: readonly Record<string, unknown>[] }) => unknown)
}));

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => ({
		collections: {},
		relationships: {},
		registered: { inputSchemas: {}, integrationBindings: {} }
	}),
	getWorkspaceCollection: () => ({ create: {} }),
	allowsMutation: () => true,
	collectionHooks: (_behavior: unknown, action: string) =>
		action === 'create'
			? {
					...(state.beforeHook ? { before: state.beforeHook } : {}),
					...(state.afterHook ? { after: state.afterHook } : {}),
					...(state.beforeBatchHook ? { beforeBatch: state.beforeBatchHook } : {}),
					...(state.afterBatchHook ? { afterBatch: state.afterBatchHook } : {})
				}
			: undefined
}));

vi.mock('$lib/server/collection/hook-api.server.js', async () => {
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
const { withCollectionTransaction } =
	await import('$lib/server/collection/collection_transaction.server.js');
const { supportsServerCreatedAuditProjection } = await import('$lib/server/audit_event.server.js');
const { runWithAdmit } = await import('$lib/server/admit.js');

const statements: string[] = [];

async function inViaOps(pool: Pool, run: (client: PoolClient) => Promise<void>): Promise<void> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		await run(client);
		await client.query('COMMIT');
	} catch (cause) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

function workspaceContext(tenantDb: ProvisionedContext['tenantDb']): ProvisionedContext {
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
	let host: ReturnType<typeof createHostTenantDb>;
	let ctx: ProvisionedContext;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		await seedTestUser(pool, USER_ID);
		await pool.query(`
			CREATE TYPE test_order_state AS ENUM ('OPEN', 'CLOSED');
			ALTER TABLE orders
				ADD COLUMN work_date DATE,
				ADD COLUMN occurred_at TIMESTAMPTZ,
				ADD COLUMN optional_at TIMESTAMPTZ,
				ADD COLUMN enabled BOOLEAN DEFAULT TRUE,
				ADD COLUMN quantity INTEGER DEFAULT 7,
				ADD COLUMN metadata JSONB,
				ADD COLUMN state test_order_state
		`);
		host = createHostTenantDb(pg.connectionString, { pool, statements });
		ctx = workspaceContext(host.tenantDb);
	}, 180_000);

	afterAll(async () => {
		await host?.close();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		state.beforeHook = undefined;
		state.afterHook = undefined;
		state.beforeBatchHook = undefined;
		state.afterBatchHook = undefined;
		await inViaOps(pool, async (client) => {
			await client.query('DELETE FROM orders');
			await client.query('DELETE FROM orders_history');
			await client.query('DELETE FROM sync_outbox');
			// The shipped append-only trigger rejects DELETE; fixture teardown may still truncate.
			await client.query('TRUNCATE audit_event');
		});
		statements.length = 0;
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

		const { records: created } = await withRequestWorkspaceCtx(ctx, () =>
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
		// BEGIN (via_ops is set inside begin) + two roots + sync + two audits + COMMIT.
		expect(statements).toHaveLength(7);
	}, 180_000);

	it('returns only ids with audit JSON exactly equivalent to the ordinary returned-row path', async () => {
		const normalId = '40000000-0000-4000-8000-000000000001';
		const projectedId = '40000000-0000-4000-8000-000000000002';
		const writtenAt = '2026-08-12T03:04:05.678Z';
		const input = {
			status: 'same-shape',
			work_date: '2026-08-12',
			occurred_at: new Date('2026-08-12T08:09:10.123Z'),
			optional_at: null,
			metadata: { nested: ['value', null], count: 2 },
			state: 'CLOSED'
		};

		const [normal, projected] = await withRequestWorkspaceCtx(ctx, () =>
			withCollectionTransaction(ctx, async () => {
				const ordinary = await createMany(ctx, 'orders', [input], {
					isElevated: true,
					recordIds: [normalId],
					createdAts: [writtenAt],
					updatedAts: [writtenAt]
				});
				const idsOnly = await createMany(ctx, 'orders', [input], {
					isElevated: true,
					returnIdsOnly: true,
					recordIds: [projectedId],
					createdAts: [writtenAt],
					updatedAts: [writtenAt]
				});
				return [ordinary.records, idsOnly.records] as const;
			})
		);

		expect(normal[0]).toMatchObject({ norbital_id: normalId, enabled: true, quantity: 7 });
		expect(projected).toEqual([{ norbital_id: projectedId }]);

		const audits = (
			await pool.query<{ record_id: string; changes_after: Record<string, unknown> }>(`
				SELECT record_id, details->'changes_after' AS changes_after
				FROM audit_event
				ORDER BY ctid
			`)
		).rows;
		expect(audits).toHaveLength(2);
		const ordinaryAudit = audits[0]!.changes_after;
		const projectedAudit = audits[1]!.changes_after;
		expect({ ...projectedAudit, norbital_id: normalId }).toEqual(ordinaryAudit);
		// `tags` is a physical fixture column not declared on this test's Drizzle table. The
		// projected audit must mirror ordinary RETURNING semantics and omit it.
		expect(projectedAudit).not.toHaveProperty('tags');
		expect(projectedAudit).toMatchObject({
			norbital_created_at: writtenAt,
			norbital_updated_at: writtenAt,
			occurred_at: '2026-08-12T08:09:10.123Z',
			optional_at: null,
			work_date: '2026-08-12',
			enabled: true,
			quantity: 7,
			metadata: input.metadata,
			state: 'CLOSED'
		});

		expect(
			(
				await pool.query<{ record_id: string; action: string; row_version: number }>(
					'SELECT record_id, action, row_version FROM sync_outbox ORDER BY seq'
				)
			).rows
		).toEqual([
			{ record_id: normalId, action: 'create', row_version: 1 },
			{ record_id: projectedId, action: 'create', row_version: 1 }
		]);
	});

	it('keeps unsafe driver-normalized SQL types on the ordinary full-row audit path', () => {
		expect(supportsServerCreatedAuditProjection(orders)).toBe(true);
		expect(supportsServerCreatedAuditProjection(unsupportedNumericOrders)).toBe(false);
		expect(supportsServerCreatedAuditProjection(unsupportedCustomOrders)).toBe(false);
	});

	it('keeps sync_outbox but skips audit_event when skipAudit is set', async () => {
		const id = '40000000-0000-4000-8000-000000000099';
		const input = {
			status: 'seed-row',
			work_date: '2026-08-12',
			occurred_at: new Date('2026-08-12T08:09:10.123Z'),
			optional_at: null,
			metadata: { seeded: true },
			state: 'OPEN'
		};

		const { records } = await withRequestWorkspaceCtx(ctx, () =>
			createMany(ctx, 'orders', [input], {
				isElevated: true,
				returnIdsOnly: true,
				recordIds: [id],
				skipAudit: true
			})
		);

		expect(records).toEqual([{ norbital_id: id }]);
		expect(
			(
				await pool.query<{ record_id: string; action: string }>(
					'SELECT record_id, action FROM sync_outbox ORDER BY seq'
				)
			).rows
		).toEqual([{ record_id: id, action: 'create' }]);
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('bounds id-projected root and audit statements above 5,000 rows', async () => {
		const { ids, inputs } = batch(ROOT_CHUNK_BOUNDARY + 1);
		const { records: created } = await withRequestWorkspaceCtx(ctx, () =>
			createMany(ctx, 'orders', inputs, {
				isElevated: true,
				returnIdsOnly: true,
				recordIds: ids
			})
		);

		expect(created).toEqual(ids.map((norbital_id) => ({ norbital_id })));
		expect(matching(/^insert into "orders"/i)).toHaveLength(2);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(1);
		expect(matching(/WITH requested\(audit_id, record_id, ordinal\)/i)).toHaveLength(2);
		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: ids.length });
		expect(
			(
				await pool.query<{ record_id: string; action: string; row_version: number }>(
					'SELECT record_id, action, row_version FROM sync_outbox ORDER BY seq'
				)
			).rows
		).toEqual(ids.map((record_id) => ({ record_id, action: 'create', row_version: 1 })));
		expect(
			(
				await pool.query<{ record_id: string }>(
					'SELECT record_id FROM audit_event ORDER BY record_id'
				)
			).rows.map(({ record_id }) => record_id)
		).toEqual(ids);
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

	it('runs create batch hooks once in caller order and keeps audit and sync atomic', async () => {
		const { ids, inputs } = batch(6);
		const events: string[] = [];
		state.beforeHook = () => {
			throw new Error('single before hook must not run');
		};
		state.afterHook = () => {
			throw new Error('single after hook must not run');
		};
		state.beforeBatchHook = ({ inputs: batchInputs }) => {
			events.push(`before:${batchInputs.map((input) => input.status).join(',')}`);
			return batchInputs.map((input) => ({ status: `${input.status}-prepared` }));
		};
		state.afterBatchHook = ({ records }) => {
			events.push(`after:${records.map((record) => record.status).join(',')}`);
		};

		const { records: created } = await withRequestWorkspaceCtx(ctx, () =>
			createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
		);

		expect(created.map((record) => record.status)).toEqual(
			inputs.map(({ status }) => `${status}-prepared`)
		);
		expect(events).toEqual([
			`before:${inputs.map(({ status }) => status).join(',')}`,
			`after:${inputs.map(({ status }) => `${status}-prepared`).join(',')}`
		]);
		expect(
			(
				await pool.query<{ record_id: string }>('SELECT record_id FROM sync_outbox ORDER BY seq')
			).rows.map((record) => record.record_id)
		).toEqual(ids);
		expect(
			(
				await pool.query<{ record_id: string }>('SELECT record_id FROM audit_event ORDER BY ctid')
			).rows.map((record) => record.record_id)
		).toEqual(ids);
	});

	it('rolls back batch-hook inserts and sync when the batch after hook fails', async () => {
		const { ids, inputs } = batch(6);
		state.beforeBatchHook = ({ inputs: batchInputs }) => batchInputs;
		state.afterBatchHook = () => {
			throw new Error('batch after failure');
		};

		await expect(
			withRequestWorkspaceCtx(ctx, () =>
				createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
			)
		).rejects.toThrow('batch after failure');

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rejects a before batch hook that does not return one result per input', async () => {
		const { ids, inputs } = batch(6);
		state.beforeBatchHook = ({ inputs: batchInputs }) => batchInputs.slice(0, -1);

		await expect(
			withRequestWorkspaceCtx(ctx, () =>
				createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
			)
		).rejects.toThrow('returned 5 records for 6 inputs');

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rolls back root rows and sync when the audit insert fails', async () => {
		await pool.query(`
			CREATE FUNCTION test_reject_create_audit() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'injected audit failure';
			END;
			$$ LANGUAGE plpgsql
		`);
		await pool.query(`
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
			await pool.query('DROP TRIGGER IF EXISTS test_reject_create_audit ON audit_event');
			await pool.query('DROP FUNCTION IF EXISTS test_reject_create_audit()');
		}

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rolls back an id-projected create when its server-side audit insert fails', async () => {
		await pool.query(`
			CREATE FUNCTION test_reject_projected_create_audit() RETURNS trigger AS $$
			BEGIN
				RAISE EXCEPTION 'injected projected audit failure';
			END;
			$$ LANGUAGE plpgsql
		`);
		await pool.query(`
			CREATE TRIGGER test_reject_projected_create_audit
			BEFORE INSERT ON audit_event
			FOR EACH STATEMENT EXECUTE FUNCTION test_reject_projected_create_audit()
		`);

		const { ids, inputs } = batch(6);
		try {
			const failure = await withRequestWorkspaceCtx(ctx, () =>
				createMany(ctx, 'orders', inputs, {
					isElevated: true,
					returnIdsOnly: true,
					recordIds: ids
				})
			).then(
				() => null,
				(cause: unknown) => cause
			);
			expect(String((failure as { cause?: unknown })?.cause ?? failure)).toContain(
				'injected projected audit failure'
			);
		} finally {
			await pool.query(
				'DROP TRIGGER IF EXISTS test_reject_projected_create_audit ON audit_event'
			);
			await pool.query('DROP FUNCTION IF EXISTS test_reject_projected_create_audit()');
		}

		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	});

	it('rolls back the first root chunk when a constraint rejects the second', async () => {
		await pool.query(
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
			await pool.query('ALTER TABLE orders DROP CONSTRAINT IF EXISTS test_orders_status_unique');
		}

		expect(matching(/^insert into "orders"/i)).toHaveLength(2);
		expect(matching(/insert into sync_outbox/i)).toHaveLength(0);
		expect(matching(/^insert into "audit_event"/i)).toHaveLength(0);
		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM sync_outbox')).toMatchObject({ rowCount: 0 });
		expect(await pool.query('SELECT 1 FROM audit_event')).toMatchObject({ rowCount: 0 });
	}, 180_000);

	it('writes the whole remaining batch when no host admitted the call', async () => {
		const { ids, inputs } = batch(8);

		const result = await withRequestWorkspaceCtx(ctx, () =>
			createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
		);

		expect(result.records).toHaveLength(8);
		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 8 });
	});

	it('fails a tight admit instead of yielding a leftover nextOffset', async () => {
		const { ids, inputs } = batch(8);
		let beforeBatchLength = -1;
		state.beforeBatchHook = ({ inputs: batchInputs }) => {
			beforeBatchLength = batchInputs.length;
			return [...batchInputs];
		};

		await expect(
			withRequestWorkspaceCtx(ctx, () =>
				runWithAdmit({ timeoutMs: 1, deadlineAt: Date.now() - 1 }, () =>
					createMany(ctx, 'orders', inputs, { isElevated: true, recordIds: ids })
				)
			)
		).rejects.toThrow(/could not finish the bulk write/);

		expect(beforeBatchLength).toBe(-1);
		expect(await pool.query('SELECT 1 FROM orders')).toMatchObject({ rowCount: 0 });
	});
});
