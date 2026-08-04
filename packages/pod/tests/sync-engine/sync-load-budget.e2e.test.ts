/**
 * Sync-engine load budget.
 *
 * Drives the real `PodSyncClient` and `SubscriptionRegistry` against a file-backed PGlite — the
 * same WASM Postgres the browser runs, persisted the way IndexedDB persists it — so a second run
 * over the same directory is a genuine warm reload. Network RTT is stubbed.
 *
 * Asserts the property the old `scripts/profile-sync.ts` profiler measured: a warm reload on the
 * current sync path stays local (no shape traffic) and finishes within a CI-safe budget, while the
 * pre-fix path always paid an extra server round-trip on warm.
 */
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PodSyncClient, type PgliteLike } from '$lib/ui/sync/pod-sync-client.js';
import { SubscriptionRegistry } from '$lib/ui/sync/subscription-registry.js';
import type { ShapeResponse, SyncFetch } from '$lib/ui/sync/types.js';

type CollectionSpec = { name: string; rows: number; columns: string[] };

const SYSTEM_COLUMNS = [
	'norbital_id',
	'norbital_row_version',
	'norbital_created_at',
	'norbital_updated_at'
];

/**
 * HR landing-page collections, sized for the test rather than the full seed. `roster_entries` is
 * still larger than the registry's first-page size (250) so catch-up spans multiple pages.
 */
const HR_WORKLOAD: CollectionSpec[] = [
	{ name: 'employees', rows: 40, columns: ['name', 'email', 'user_id'] },
	{
		name: 'employments',
		rows: 40,
		columns: ['employee_id', 'company_id', 'start_date', 'status']
	},
	{
		name: 'leave_requests',
		rows: 80,
		columns: ['employment_id', 'leave_type_id', 'start_date', 'end_date', 'status']
	},
	{
		name: 'roster_entries',
		rows: 600,
		columns: ['employment_id', 'work_date', 'shift_definition_id', 'assignment_code']
	}
];

const FIRST_PAINT = HR_WORKLOAD.map((spec) => spec.name);
const TABLE_PAGE = 50;
const RTT_MS = 20;
const SERVER_QUERY_MS = 80;
/** Generous enough for a loaded CI runner reopening a file-backed WASM replica. */
const WARM_AFTER_BUDGET_MS = 30_000;

type NetworkStats = { shapeCalls: number; rowsShipped: number };

function buildSchemaSql(): string {
	const statements: string[] = [];
	for (const spec of HR_WORKLOAD) {
		statements.push(`CREATE TABLE IF NOT EXISTS "${spec.name}" ("norbital_id" text PRIMARY KEY);`);
		for (const column of [...SYSTEM_COLUMNS.slice(1), ...spec.columns]) {
			const type = column === 'norbital_row_version' ? 'integer' : 'text';
			statements.push(`ALTER TABLE "${spec.name}" ADD COLUMN IF NOT EXISTS "${column}" ${type};`);
		}
	}
	return statements.join('\n');
}

function makeRow(spec: CollectionSpec, index: number): Record<string, unknown> {
	const row: Record<string, unknown> = {
		norbital_id: `${spec.name}-${String(index).padStart(7, '0')}`,
		norbital_row_version: 1,
		norbital_created_at: '2026-01-01T00:00:00.000Z',
		norbital_updated_at: '2026-01-01T00:00:00.000Z'
	};
	for (const column of spec.columns) row[column] = `${column}-${index % 997}`;
	return row;
}

/** SSE body that produces no diffs and ends when the client aborts — never hangs `stopStream`. */
function idleStream(signal?: AbortSignal): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			if (signal?.aborted) {
				controller.close();
				return;
			}
			const onAbort = () => {
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		}
	});
}

function makeFetch(rttMs: number, stats: NetworkStats): SyncFetch {
	const byName = new Map(HR_WORKLOAD.map((spec) => [spec.name, spec]));
	return async (pathname, init) => {
		if (pathname.startsWith('sync/stream')) {
			return new Response(idleStream(init.signal), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		await sleep(rttMs);
		if (pathname.startsWith('sync/shape')) {
			const body = JSON.parse(String(init.body ?? '{}')) as {
				collection: string;
				cursor: string | null;
				pageSize?: number;
			};
			const spec = byName.get(body.collection);
			const offset = body.cursor ? Number(body.cursor) : 0;
			const pageSize = body.pageSize && body.pageSize > 0 ? body.pageSize : 5000;
			const total = spec?.rows ?? 0;
			const rows = spec
				? Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) }, (_v, i) =>
						makeRow(spec, offset + i)
					)
				: [];
			const next = offset + rows.length;
			stats.shapeCalls += 1;
			stats.rowsShipped += rows.length;
			const payload: ShapeResponse = {
				rows,
				nextCursor: next < total ? String(next) : null,
				watermark: '1',
				cursor: offset === 0 ? { xid: '1', seq: '1' } : undefined
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (pathname.startsWith('sync/head')) {
			return new Response(JSON.stringify({ sequence: '1' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainFirstPaint(client: PodSyncClient): Promise<void> {
	const deadline = performance.now() + 30_000;
	for (;;) {
		const state = await client.loadSyncState();
		if (FIRST_PAINT.every((name) => state.has(name))) return;
		if (performance.now() > deadline) {
			throw new Error(
				`catch-up did not persist sync state for ${FIRST_PAINT.filter((name) => !state.has(name)).join(', ')}; have=[${[...state.keys()].join(',')}]`
			);
		}
		await sleep(25);
	}
}

async function runLoad(input: {
	dataDir: string;
	schemaSql: string;
	rttMs: number;
	serverQueryMs: number;
	variant: 'before' | 'after';
	drain: boolean;
}): Promise<{ stats: NetworkStats; totalMs: number }> {
	const stats: NetworkStats = { shapeCalls: 0, rowsShipped: 0 };
	const wallStart = performance.now();

	await sleep(input.rttMs);

	if (input.variant === 'before') {
		await sleep(input.rttMs);
	}

	const pg = new PGlite(input.dataDir);
	await pg.waitReady;
	await pg.exec(
		`CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ SELECT gen_random_uuid() $$ LANGUAGE sql;`
	);
	const db = pg as unknown as PgliteLike;

	const client = new PodSyncClient({
		db,
		schemaSql: input.schemaSql,
		replicaEpoch: 'epoch-1',
		fetch: makeFetch(input.rttMs, stats)
	});

	await client.bootstrap();

	const registry = new SubscriptionRegistry(client);
	await registry.restore();
	const restoredWarm = FIRST_PAINT.every((name) => registry.has(name));

	await Promise.all(FIRST_PAINT.map((name) => registry.register(name)));

	await client.queryLocal(
		`SELECT * FROM "employees" ORDER BY "norbital_id" ASC LIMIT ${TABLE_PAGE}`
	);

	let readyMs: number;
	if (input.variant === 'before') {
		await sleep(input.rttMs + input.serverQueryMs);
		readyMs = performance.now() - wallStart;
	} else if (restoredWarm) {
		readyMs = performance.now() - wallStart;
	} else {
		readyMs = input.rttMs + input.serverQueryMs;
	}

	if (input.drain) await drainFirstPaint(client);

	await client.close();

	return { stats, totalMs: readyMs };
}

describe('sync load budget (HR landing-page slice)', () => {
	const root = path.join(os.tmpdir(), `norbital-sync-load-budget-${process.pid}`);
	const schemaSql = buildSchemaSql();

	afterEach(async () => {
		if (existsSync(root)) await rm(root, { recursive: true, force: true });
	});

	it('keeps warm reload local and under budget on the current sync path', async () => {
		const results: Record<string, { warm: number; warmStats: NetworkStats }> = {};

		for (const variant of ['before', 'after'] as const) {
			if (existsSync(root)) await rm(root, { recursive: true, force: true });
			await mkdir(root, { recursive: true });
			const dataDir = path.join(root, 'replica');

			await runLoad({
				dataDir,
				schemaSql,
				rttMs: RTT_MS,
				serverQueryMs: SERVER_QUERY_MS,
				variant,
				drain: true
			});
			const warm = await runLoad({
				dataDir,
				schemaSql,
				rttMs: RTT_MS,
				serverQueryMs: SERVER_QUERY_MS,
				variant,
				drain: false
			});

			results[variant] = { warm: warm.totalMs, warmStats: warm.stats };
		}

		const before = results.before!;
		const after = results.after!;

		expect(after.warmStats.shapeCalls).toBe(0);
		expect(after.warmStats.rowsShipped).toBe(0);
		expect(after.warm).toBeLessThan(before.warm);
		expect(after.warm).toBeLessThan(WARM_AFTER_BUDGET_MS);
	});
});
