import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client, Pool } from 'pg';
import { startPostgres, dockerAvailable, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';
import {
	readSyncOutboxBatch,
	OUTBOX_CURSOR_START
} from '$lib/server/collection/sync/outbox-tailer.server.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';

const hasDocker = dockerAvailable();
if (!hasDocker) {
	// eslint-disable-next-line no-console
	console.warn('[pod-sync-p0] Docker not available — skipping real-Postgres sync tests.');
}

/** Minimal ProvisionedContext shim: the tailer only ever calls ctx.tenantDb.query. */
function makeCtx(pool: Pool): ProvisionedContext {
	return {
		tenantDb: {
			query: (text: string, params?: unknown[]) => pool.query(text, params as unknown[])
		}
	} as unknown as ProvisionedContext;
}

/** Insert one order through the authoritative path (a via_ops transaction) and return its id. */
async function insertOrderViaOps(pool: Pool, status: string): Promise<string> {
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		const res = await client.query<{ norbital_id: string }>(
			`INSERT INTO orders (status) VALUES ($1) RETURNING norbital_id`,
			[status]
		);
		await client.query('COMMIT');
		return res.rows[0]!.norbital_id;
	} finally {
		client.release();
	}
}

describe.skipIf(!hasDocker)('Pod Sync P0 (real Postgres)', () => {
	let harness: PgHarness;
	let pool: Pool;

	beforeAll(async () => {
		harness = await startPostgres();
		const setup = new Client({ connectionString: harness.connectionString });
		await setup.connect();
		await applyPodSchema(setup);
		await setup.end();
		pool = new Pool({ connectionString: harness.connectionString, max: 8 });
	});

	afterAll(async () => {
		await pool?.end().catch(() => {});
		harness?.stop();
	});

	beforeEach(async () => {
		await pool.query('TRUNCATE orders');
		await pool.query('TRUNCATE sync_outbox RESTART IDENTITY');
	});

	describe('_ops_guard', () => {
		it('rejects a direct INSERT that bypasses collection_ops', async () => {
			await expect(
				pool.query(`INSERT INTO orders (status) VALUES ('bypass')`)
			).rejects.toMatchObject({ code: 'N0OPS' });
		});

		it('rejects direct UPDATE and DELETE that bypass collection_ops', async () => {
			const id = await insertOrderViaOps(pool, 'seed');
			await expect(
				pool.query(`UPDATE orders SET status = 'x' WHERE norbital_id = $1`, [id])
			).rejects.toMatchObject({ code: 'N0OPS' });
			await expect(
				pool.query(`DELETE FROM orders WHERE norbital_id = $1`, [id])
			).rejects.toMatchObject({ code: 'N0OPS' });
		});

		it('allows writes inside a via_ops transaction', async () => {
			const id = await insertOrderViaOps(pool, 'ok');
			const row = await pool.query(`SELECT status FROM orders WHERE norbital_id = $1`, [id]);
			expect(row.rows[0]?.status).toBe('ok');
		});
	});

	describe('atomic co-commit', () => {
		it('co-commits data, version bump, and outbox in one transaction', async () => {
			const client = await pool.connect();
			let id: string;
			try {
				await client.query('BEGIN');
				await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
				const ins = await client.query<{ norbital_id: string; norbital_row_version: number }>(
					`INSERT INTO orders (status) VALUES ('open') RETURNING norbital_id, norbital_row_version`
				);
				id = ins.rows[0]!.norbital_id;
				await client.query(
					`INSERT INTO sync_outbox (collection, record_id, action, row_version) VALUES ('orders', $1, 'create', $2)`,
					[id, ins.rows[0]!.norbital_row_version]
				);
				const upd = await client.query<{ norbital_row_version: number }>(
					`UPDATE orders SET status = 'closed', norbital_row_version = norbital_row_version + 1
					 WHERE norbital_id = $1 RETURNING norbital_row_version`,
					[id]
				);
				await client.query(
					`INSERT INTO sync_outbox (collection, record_id, action, row_version) VALUES ('orders', $1, 'update', $2)`,
					[id, upd.rows[0]!.norbital_row_version]
				);
				await client.query('COMMIT');
			} finally {
				client.release();
			}

			const version = await pool.query<{ norbital_row_version: number }>(
				`SELECT norbital_row_version FROM orders WHERE norbital_id = $1`,
				[id]
			);
			expect(version.rows[0]?.norbital_row_version).toBe(2);

			const outbox = await pool.query<{ action: string; row_version: number }>(
				`SELECT action, row_version FROM sync_outbox WHERE record_id = $1 ORDER BY seq`,
				[id]
			);
			expect(outbox.rows.map((r) => r.action)).toEqual(['create', 'update']);
			expect(outbox.rows[1]?.row_version).toBe(2);
		});

		it('leaves zero trace (no data, no outbox) when the transaction rolls back', async () => {
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
				const ins = await client.query<{ norbital_id: string }>(
					`INSERT INTO orders (status) VALUES ('ghost') RETURNING norbital_id`
				);
				await client.query(
					`INSERT INTO sync_outbox (collection, record_id, action) VALUES ('orders', $1, 'create')`,
					[ins.rows[0]!.norbital_id]
				);
				await client.query('ROLLBACK');
			} finally {
				client.release();
			}

			const orders = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM orders`);
			const outbox = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM sync_outbox`);
			expect(orders.rows[0]?.c).toBe(0);
			expect(outbox.rows[0]?.c).toBe(0);
		});
	});

	describe('safe-watermark tailer', () => {
		it('reads committed rows exactly once and advances past them', async () => {
			await insertOrderViaOps(pool, 'a');
			await insertOrderViaOps(pool, 'b');
			await pool.query(
				`INSERT INTO sync_outbox (collection, record_id, action)
				 SELECT 'orders', norbital_id, 'create' FROM orders`
			);

			const first = await readSyncOutboxBatch(makeCtx(pool), OUTBOX_CURSOR_START);
			expect(first.rows).toHaveLength(2);
			const second = await readSyncOutboxBatch(makeCtx(pool), first.cursor);
			expect(second.rows).toHaveLength(0);
		});

		it('respects the batch limit and resumes without gaps or repeats', async () => {
			for (const s of ['a', 'b', 'c', 'd', 'e']) {
				const id = await insertOrderViaOps(pool, s);
				await pool.query(
					`INSERT INTO sync_outbox (collection, record_id, action) VALUES ('orders', $1, 'create')`,
					[id]
				);
			}
			const seen: string[] = [];
			let cursor = OUTBOX_CURSOR_START;
			for (let i = 0; i < 10; i++) {
				const batch = await readSyncOutboxBatch(makeCtx(pool), cursor, 2);
				if (batch.rows.length === 0) break;
				seen.push(...batch.rows.map((r) => r.seq));
				cursor = batch.cursor;
			}
			expect(seen).toEqual(['1', '2', '3', '4', '5']);
		});

		/**
		 * Past nine rows, string order and numeric order stop agreeing — and the feed's cursor is
		 * only sound while its ORDER BY and its predicate mean the same thing. Sorted as text the
		 * feed reads 1, 10, 11, … 2, 20 …, so a page ends on a numerically large `seq` and the
		 * cursor then excludes every smaller row that page skipped: those changes are never
		 * delivered to any client, on any collection, forever. One write burst of a few hundred
		 * rows is all it takes, which is why a five-row fixture never saw it.
		 */
		it('delivers a burst larger than one decade in seq order, losing nothing', async () => {
			const id = await insertOrderViaOps(pool, 'burst');
			await pool.query(
				`INSERT INTO sync_outbox (collection, record_id, action)
				 SELECT 'orders', $1::uuid, 'update' FROM generate_series(1, 25)`,
				[id]
			);

			const seen: string[] = [];
			let cursor = OUTBOX_CURSOR_START;
			for (let page = 0; page < 30; page++) {
				const batch = await readSyncOutboxBatch(makeCtx(pool), cursor, 5);
				if (batch.rows.length === 0) break;
				seen.push(...batch.rows.map((row) => row.seq));
				cursor = batch.cursor;
			}

			expect(seen).toEqual(Array.from({ length: 25 }, (_v, index) => String(index + 1)));
		});

		// The decisive concurrency test the design doc flags: `seq` order is NOT commit order.
		// A committed row (small seq, large xid) must be HELD behind an older still-in-flight
		// transaction, then emitted in (xid, seq) order — never skipped by a seq-only cursor.
		it('holds a committed small-seq row behind an older in-flight transaction', async () => {
			const a = await pool.connect();
			const b = await pool.connect();
			try {
				// A opens first → gets the smaller xid.
				await a.query('BEGIN');
				await a.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
				const aOrder = await a.query<{ norbital_id: string }>(
					`INSERT INTO orders (status) VALUES ('a') RETURNING norbital_id`
				);

				// B opens second → larger xid — but writes its outbox row (seq 1) and commits FIRST.
				await b.query('BEGIN');
				await b.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
				const bOrder = await b.query<{ norbital_id: string }>(
					`INSERT INTO orders (status) VALUES ('b') RETURNING norbital_id`
				);
				await b.query(
					`INSERT INTO sync_outbox (collection, record_id, action) VALUES ('B', $1, 'create')`,
					[bOrder.rows[0]!.norbital_id]
				);
				await b.query('COMMIT');

				// A is still in flight, so its xid is the snapshot xmin. B's row (larger xid) is above
				// the horizon and must be held — a seq-only cursor would have wrongly emitted it.
				const held = await readSyncOutboxBatch(makeCtx(pool), OUTBOX_CURSOR_START);
				expect(held.rows).toHaveLength(0);
				expect(held.cursor).toEqual(OUTBOX_CURSOR_START);

				// A writes its outbox row (seq 2) and commits.
				await a.query(
					`INSERT INTO sync_outbox (collection, record_id, action) VALUES ('A', $1, 'create')`,
					[aOrder.rows[0]!.norbital_id]
				);
				await a.query('COMMIT');

				// Both safe now: emitted in xid order (A then B) even though A's seq (2) > B's (1).
				const flushed = await readSyncOutboxBatch(makeCtx(pool), OUTBOX_CURSOR_START);
				expect(flushed.rows.map((r) => r.collection)).toEqual(['A', 'B']);
				expect(flushed.rows.map((r) => r.seq)).toEqual(['2', '1']);

				// Exactly once: nothing re-emitted after advancing the cursor.
				const after = await readSyncOutboxBatch(makeCtx(pool), flushed.cursor);
				expect(after.rows).toHaveLength(0);
			} finally {
				a.release();
				b.release();
			}
		});
	});
});
