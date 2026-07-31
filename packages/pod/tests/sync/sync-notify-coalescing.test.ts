import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client, Pool } from 'pg';
import { startPostgres, dockerAvailable, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';

/**
 * How many times one write wakes the change feed.
 *
 * The notification is a wake-up, not a message: every listener that receives it runs the same
 * catch-up query from its own cursor, and one pass drains everything the statement committed. So
 * the cost of a second notification for the same statement is not a duplicate read — it is a
 * duplicate read multiplied by every open stream on the tenant database.
 *
 * A row-level trigger made that ratio the row count. A bulk import of a few thousand rows is one
 * statement and one commit, and it was announcing itself a few thousand times.
 */

const hasDocker = dockerAvailable();

describe.skipIf(!hasDocker)('change-feed notifications are coalesced per statement', () => {
	let pg: PgHarness;
	let pool: Pool;
	let listener: Client;
	let received: string[] = [];

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		listener = new Client({ connectionString: pg.connectionString });
		await listener.connect();
		listener.on('notification', (message) => {
			if (message.channel === 'norbital_sync') received.push(message.payload ?? '');
		});
		await listener.query('LISTEN norbital_sync');
	}, 180_000);

	afterAll(async () => {
		await listener?.end().catch(() => undefined);
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	beforeEach(async () => {
		await pool.query('DELETE FROM sync_outbox');
		received = [];
	});

	/** Notifications arrive after COMMIT and out of band; give the socket a moment to deliver. */
	async function settle(): Promise<void> {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			await listener.query('SELECT 1');
		}
	}

	async function appendOutbox(rowCount: number): Promise<number> {
		const { rows } = await pool.query<{ max: string }>(
			`INSERT INTO sync_outbox (collection, record_id, action)
			 SELECT 'orders', gen_random_uuid(), 'create' FROM generate_series(1, $1)
			 RETURNING seq`,
			[rowCount]
		);
		return Math.max(...rows.map((row) => Number((row as unknown as { seq: string }).seq)));
	}

	it('announces a bulk insert once, carrying the highest seq it wrote', async () => {
		const highest = await appendOutbox(500);
		await settle();

		expect(received).toEqual([String(highest)]);
	});

	it('still announces every statement in a multi-statement transaction', async () => {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO sync_outbox (collection, record_id, action)
				 SELECT 'orders', gen_random_uuid(), 'create' FROM generate_series(1, 3)`
			);
			await client.query(
				`INSERT INTO sync_outbox (collection, record_id, action)
				 VALUES ('orders', gen_random_uuid(), 'update')`
			);
			await client.query('COMMIT');
		} finally {
			client.release();
		}
		await settle();

		// Two statements, two wake-ups — and nothing delivered before COMMIT, because a listener
		// that woke early would read rows no other session can see yet.
		expect(received).toHaveLength(2);
		const { rows } = await pool.query<{ seq: string }>(
			`SELECT MAX(seq)::text AS seq FROM sync_outbox`
		);
		expect(received.at(-1)).toBe(rows[0].seq);
	});

	it('says nothing when a statement appends no rows', async () => {
		await pool.query(
			`INSERT INTO sync_outbox (collection, record_id, action)
			 SELECT 'orders', gen_random_uuid(), 'create' WHERE false`
		);
		await settle();

		expect(received).toEqual([]);
	});
});
