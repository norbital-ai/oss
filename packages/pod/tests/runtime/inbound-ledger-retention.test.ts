import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { dockerAvailable, startPostgres, type PgHarness } from '../support/pg-harness.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';

/**
 * The inbound ledger's retention, against a real Postgres.
 *
 * `integration_inbound_event` is written once per accepted delivery and read only to reject a
 * redelivery, so without a sweep it is the one table that grows purely with tenant age. What has to
 * hold is both halves: old receipts go, and the floor keeps enough recent ones that a quiet tenant
 * whose every receipt is old still has a duplicate defence rather than an empty table.
 */

const hasDocker = dockerAvailable();

/** The columns the sweep reads, exactly as `workspace-schema.ts` declares them. */
const DDL = `
	CREATE TABLE integration_inbound_event (
		norbital_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at timestamptz DEFAULT now(),
		integration_name text NOT NULL,
		binding_name text NOT NULL,
		binding_key text NOT NULL,
		event_id text NOT NULL,
		receipt_key text NOT NULL UNIQUE,
		status text NOT NULL DEFAULT 'received',
		imported integer,
		error text,
		completed_at timestamptz
	);
`;

describe.skipIf(!hasDocker)('inbound ledger retention', () => {
	let harness: PgHarness;
	let pool: Pool;
	let ctx: Pick<ProvisionedContext, 'tenantDb'>;
	let pruneInboundEvents: typeof import('$lib/server/integrations/tenant-inbound.server.js')['pruneInboundEvents'];

	beforeAll(async () => {
		harness = await startPostgres();
		pool = new Pool({ connectionString: harness.connectionString, max: 4 });
		await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
		ctx = {
			tenantDb: {
				query: (input: unknown, params?: unknown[]) => {
					const text = typeof input === 'string' ? input : (input as { text: string }).text;
					const values =
						params ?? (typeof input === 'string' ? [] : ((input as { values?: unknown[] }).values ?? []));
					return pool.query(text, values) as never;
				}
			}
		};
		({ pruneInboundEvents } = await import(
			'$lib/server/integrations/tenant-inbound.server.js'
		));
	}, 180_000);

	afterAll(async () => {
		await pool?.end().catch(() => undefined);
		harness?.stop();
	});

	beforeEach(async () => {
		await pool.query('DROP TABLE IF EXISTS integration_inbound_event');
		await pool.query(DDL);
	});

	/** `count` receipts, all dated `ageDays` ago, named so the survivors can be identified. */
	async function seed(prefix: string, count: number, ageDays: number): Promise<void> {
		await pool.query(
			`INSERT INTO integration_inbound_event
			      (integration_name, binding_name, binding_key, event_id, receipt_key, norbital_created_at)
			 SELECT 'field_reports', 'rfis.receive.rfi', 'field_reports:rfis.receive.rfi',
			        $1 || i, $1 || i, now() - ($2 || ' days')::interval - (i || ' seconds')::interval
			   FROM generate_series(1, $3) AS i`,
			[prefix, String(ageDays), count]
		);
	}

	async function eventIds(): Promise<string[]> {
		const result = await pool.query<{ event_id: string }>(
			'SELECT event_id FROM integration_inbound_event ORDER BY norbital_created_at'
		);
		return result.rows.map((row) => row.event_id);
	}

	it('drops receipts past the retention window and keeps everything inside it', async () => {
		// The floor is 1000, so a table has to be past it before age can decide anything at all.
		await seed('old', 1002, 45);
		await seed('recent', 2, 1);
		expect(await eventIds()).toHaveLength(1004);

		const { deleted } = await pruneInboundEvents(ctx, { force: true });

		// Two: the excess over the floor, taken from the old ones. If the window were not read, the
		// four oldest *rows* would have gone and the two recent receipts would be among them.
		expect(deleted).toBe(2);
		const survivors = await eventIds();
		expect(survivors).toHaveLength(1002);
		expect(survivors).toContain('recent1');
		expect(survivors).toContain('recent2');
	});

	it('leaves a table with nothing old enough completely alone', async () => {
		// Well past the floor, so only the age test can be what spares these.
		await seed('recent', 1005, 2);
		const { deleted } = await pruneInboundEvents(ctx, { force: true });
		expect(deleted).toBe(0);
		expect(await eventIds()).toHaveLength(1005);
	});

	it('is idempotent: a second sweep of the same table removes nothing more', async () => {
		await seed('old', 1003, 60);
		expect((await pruneInboundEvents(ctx, { force: true })).deleted).toBe(3);
		expect((await pruneInboundEvents(ctx, { force: true })).deleted).toBe(0);
		expect(await eventIds()).toHaveLength(1000);
	});

	/**
	 * Retention is expressed as age *and* a floor, because a tenant that went quiet for two months has
	 * every receipt outside the window and would otherwise be swept to nothing — losing the duplicate
	 * defence for whichever provider comes back first.
	 */
	it('never prunes below the floor of most recent receipts, however old they all are', async () => {
		await seed('old', 1005, 90);
		const { deleted } = await pruneInboundEvents(ctx, { force: true });
		expect(deleted).toBe(5);
		expect(await eventIds()).toHaveLength(1000);
		// The five removed are the five oldest, not an arbitrary five: the seed dates each row a second
		// further back, so the survivors are a contiguous newest slice.
		const newest = await pool.query<{ event_id: string }>(
			'SELECT event_id FROM integration_inbound_event ORDER BY norbital_created_at DESC LIMIT 1'
		);
		expect(newest.rows[0]?.event_id).toBe('old1');
	});

	/**
	 * The interval is the reason this can be called from the claim path at all: the sweep runs at most
	 * hourly per process, so a burst of deliveries costs one statement rather than one per delivery.
	 */
	it('does no work unless forced or its interval has elapsed', async () => {
		// The tests above forced a sweep, so the interval has not elapsed and an unforced call is a
		// no-op — rows well past retention stay exactly where they are.
		await seed('old', 1002, 90);
		expect((await pruneInboundEvents(ctx)).deleted).toBe(0);
		expect(await eventIds()).toHaveLength(1002);
		expect((await pruneInboundEvents(ctx, { force: true })).deleted).toBe(2);
	});
});
