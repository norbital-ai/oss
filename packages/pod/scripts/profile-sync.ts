/**
 * Sync-engine load profiler.
 *
 * Answers one question with numbers instead of argument: when a workspace page loads, where does
 * the time go, and how much of it is paid again on a refresh that should have been free?
 *
 * It drives the real `PodSyncClient` and `SubscriptionRegistry` against a file-backed PGlite — the
 * same WASM Postgres the browser runs, persisted the way IndexedDB persists it — so a second run
 * over the same directory is a genuine warm reload rather than a simulation of one. Only the
 * network is stubbed, at a latency you pass in, because that is the one part a laptop cannot
 * reproduce honestly.
 *
 * Usage:
 *   pnpm --filter @norbital-ai/pod exec tsx scripts/profile-sync.ts [--rtt=60] [--keep]
 */
import { rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { PodSyncClient, type PgliteLike } from '../src/ui/sync/pod-sync-client.js';
import { SubscriptionRegistry } from '../src/ui/sync/subscription-registry.js';
import type { ShapeResponse, SyncFetch } from '../src/ui/sync/types.js';

// ── the workload ───────────────────────────────────────────────────────────────
//
// Column lists and row counts are taken from the real `norbital_hr` seed
// (apps/core/seed/norbital_hr/generated). roster_entries is the interesting one: at 20,728 rows it
// sits just under the 25,000 residency cap, so the engine commits to pulling all of it.

type CollectionSpec = { name: string; rows: number; columns: string[] };

const SYSTEM_COLUMNS = [
	'norbital_id',
	'norbital_row_version',
	'norbital_created_at',
	'norbital_updated_at'
];

const HR_WORKLOAD: CollectionSpec[] = [
	{ name: 'companies', rows: 2, columns: ['name', 'registration_number', 'address'] },
	{ name: 'company_holidays', rows: 37, columns: ['company_id', 'holiday_date', 'name'] },
	{
		name: 'shift_definitions',
		rows: 13,
		columns: ['code', 'start_time', 'end_time', 'break_minutes']
	},
	{ name: 'leave_types', rows: 20, columns: ['code', 'name', 'entitlement_days', 'is_paid'] },
	{ name: 'pay_components', rows: 61, columns: ['code', 'name', 'kind', 'taxable', 'formula'] },
	{
		name: 'employees',
		rows: 324,
		columns: [
			'name',
			'date_of_birth',
			'gender',
			'marital_status',
			'spouse_status',
			'nationality',
			'identity_number',
			'dependents_count',
			'email',
			'phone',
			'address',
			'user_id'
		]
	},
	{
		name: 'employments',
		rows: 318,
		columns: ['employee_id', 'company_id', 'start_date', 'end_date', 'status', 'job_title']
	},
	{
		name: 'employment_terms',
		rows: 320,
		columns: ['employment_id', 'effective_from', 'basic_salary', 'currency', 'pay_frequency']
	},
	{
		name: 'employment_statutory_facts',
		rows: 1666,
		columns: ['employment_id', 'fact_code', 'fact_value', 'effective_from']
	},
	{
		name: 'leave_requests',
		rows: 1316,
		columns: [
			'employment_id',
			'leave_type_id',
			'start_date',
			'end_date',
			'days',
			'status',
			'reason'
		]
	},
	{
		name: 'leave_ledger',
		rows: 2178,
		columns: ['employment_id', 'leave_type_id', 'entry_date', 'delta_days', 'reason']
	},
	{
		name: 'component_entries',
		rows: 595,
		columns: ['employment_id', 'pay_component_id', 'period', 'amount', 'currency']
	},
	{
		name: 'repayment_agreements',
		rows: 0,
		columns: ['employment_id', 'principal', 'instalments', 'status']
	},
	{
		name: 'roster_entries',
		rows: 20_728,
		columns: ['employment_id', 'work_date', 'shift_definition_id', 'assignment_code', 'designation']
	}
];

/** The collections a typical HR landing page touches on first paint. */
const FIRST_PAINT = ['employees', 'employments', 'leave_requests', 'roster_entries'];

const PAGE_SIZE = 5000; // must match SubscriptionRegistry
const TABLE_PAGE = 50; // rows a CollectionTable asks for

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

// ── stubbed transport ──────────────────────────────────────────────────────────

type NetworkStats = { shapeCalls: number; rowsShipped: number; networkMs: number };

function makeFetch(rttMs: number, stats: NetworkStats): SyncFetch {
	const byName = new Map(HR_WORKLOAD.map((spec) => [spec.name, spec]));
	return async (pathname, init) => {
		if (pathname.startsWith('sync/stream')) {
			// Never resolves into diffs; the profiler is about load, not liveness.
			return new Response(new ReadableStream(), {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		}
		const started = performance.now();
		await sleep(rttMs);
		if (pathname.startsWith('sync/shape')) {
			const body = JSON.parse(String(init.body ?? '{}')) as {
				collection: string;
				cursor: string | null;
			};
			const spec = byName.get(body.collection);
			const offset = body.cursor ? Number(body.cursor) : 0;
			const total = spec?.rows ?? 0;
			const rows = spec
				? Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - offset)) }, (_v, i) =>
						makeRow(spec, offset + i)
					)
				: [];
			const next = offset + rows.length;
			stats.shapeCalls += 1;
			stats.rowsShipped += rows.length;
			stats.networkMs += performance.now() - started;
			const payload: ShapeResponse = {
				rows,
				nextCursor: next < total ? String(next) : null,
				watermark: '1'
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}
		stats.networkMs += performance.now() - started;
		return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── measurement ────────────────────────────────────────────────────────────────

type Phase = { label: string; ms: number; detail?: string };

async function timed<T>(
	phases: Phase[],
	label: string,
	fn: () => Promise<T>,
	detail?: string
): Promise<T> {
	const started = performance.now();
	const value = await fn();
	phases.push({ label, ms: performance.now() - started, detail });
	return value;
}

async function runLoad(input: {
	dataDir: string;
	schemaSql: string;
	rttMs: number;
	serverQueryMs: number;
	/** `before` = the shipped behaviour: a separate schema fetch, and reads that do not wait. */
	variant: 'before' | 'after';
}): Promise<{ phases: Phase[]; stats: NetworkStats; totalMs: number }> {
	const phases: Phase[] = [];
	const stats: NetworkStats = { shapeCalls: 0, rowsShipped: 0, networkMs: 0 };
	const wallStart = performance.now();

	// GET /_pod/bootstrap. Both variants pay this; the app cannot render without it.
	await timed(phases, 'fetch /_pod/bootstrap (shell)', () => sleep(input.rttMs));

	if (input.variant === 'before') {
		// A second serialized round trip, only so the replica can learn its own name. Nothing can
		// open the local database until it lands.
		await timed(phases, 'fetch /_runtime/sync/schema', () => sleep(input.rttMs));
	}

	const db = await timed(phases, 'PGlite open (IndexedDB / disk)', async () => {
		const pg = new PGlite(input.dataDir);
		await pg.waitReady;
		await pg.exec(
			`CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ SELECT gen_random_uuid() $$ LANGUAGE sql;`
		);
		return pg as unknown as PgliteLike;
	});

	const client = new PodSyncClient({
		db,
		schemaSql: input.schemaSql,
		replicaEpoch: 'epoch-1',
		fetch: makeFetch(input.rttMs, stats)
	});

	await timed(phases, 'client.bootstrap() (DDL + reconcile + cursor)', () => client.bootstrap());

	const registry = new SubscriptionRegistry(client);
	const restoredWarm = await timed(phases, 'registry.restore() (_pod_sync_state)', async () => {
		await registry.restore();
		return FIRST_PAINT.every((name) => registry.has(name));
	});

	// Every collection the landing page touches must be registered before a row can be read
	// locally. register() resolves on the first page; the rest streams in behind it. On a warm
	// replica restore() has already answered this, so it costs nothing.
	await timed(
		phases,
		'first-paint register() (resolves on page 1)',
		() => Promise.all(FIRST_PAINT.map((name) => registry.register(name))).then(() => undefined),
		FIRST_PAINT.join(', ')
	);

	await timed(phases, 'first CollectionTable read (local SQL)', async () => {
		await client.queryLocal(
			`SELECT * FROM "employees" ORDER BY "norbital_id" ASC LIMIT ${TABLE_PAGE}`
		);
	});

	// `before`: the read path peeks at whether sync is ready, and it never is — opening PGlite takes
	// longer than fetching the shell. So the rows the user sees come from the server on every load,
	// warm replica or not. That round trip is the 3–5s the workspace feels like.
	//
	// `after`: the warm mark decides. A warm device waits for the replica (everything above, ~120ms
	// and no network). A cold device does not wait — there is nothing to wait for — so it takes the
	// server answer while the replica opens behind it.
	let readyMs: number;
	if (input.variant === 'before') {
		await timed(
			phases,
			'*** reads go to the server anyway ***',
			() => sleep(input.rttMs + input.serverQueryMs),
			restoredWarm
				? 'the replica held every row; the peek happened too early to know that'
				: 'cold replica, so the server answer is the only one available'
		);
		readyMs = performance.now() - wallStart;
	} else if (restoredWarm) {
		readyMs = performance.now() - wallStart;
	} else {
		// Cold. Only the shell fetch and the server read are on the critical path; every replica
		// phase above happens concurrently with them, so it is charged at whichever is slower.
		const shellMs = phases[0]!.ms;
		const serverReadMs = input.rttMs + input.serverQueryMs;
		// `·` marks a phase that runs concurrently with the server read rather than in front of it.
		for (const phase of phases.slice(1)) phase.label = `· ${phase.label}`;
		phases.push({
			label: '*** server answers while the replica opens behind it ***',
			ms: serverReadMs,
			detail: 'nothing cached yet, so the server genuinely is the fast path'
		});
		readyMs = shellMs + serverReadMs;
	}

	// Everything above is what the user waits for. The catch-up keeps running afterwards, competing
	// for the same connection — `--drain` waits for it, which is worth knowing but costs far more
	// than the measurement it produces: polling count(*) against a table being bulk-loaded in WASM
	// Postgres is a growing full scan, hundreds of times over, serialized against the inserts.
	if (process.argv.includes('--drain')) {
		await timed(
			phases,
			'background catch-up drains (all pages)',
			async () => {
				// Poll the bookkeeping table, which `recordSyncState` writes once a collection is fully
				// caught up. Polling count(*) on the collections themselves is what made this take
				// minutes: a growing full scan of a 20k-row table in WASM Postgres, hundreds of times,
				// serialized against the very inserts it was waiting for.
				for (;;) {
					const state = await client.loadSyncState();
					if (FIRST_PAINT.every((name) => state.has(name))) return;
					await sleep(50);
				}
			},
			'not on the critical path, but on the wire'
		);
	}

	await client.stopStream();
	await db.close?.();

	return { phases, stats, totalMs: readyMs };
}

function renderTable(title: string, phases: Phase[], stats: NetworkStats, readyMs: number): void {
	console.log(`\n${'═'.repeat(86)}`);
	console.log(`  ${title}`);
	console.log('═'.repeat(86));
	const width = Math.max(...phases.map((phase) => phase.label.length));
	let cumulative = 0;
	for (const phase of phases) {
		// `·` and `background` phases run alongside the critical path, not in front of it, so they
		// must not accumulate into the running total.
		const isBackground = phase.label.startsWith('background') || phase.label.startsWith('·');
		if (!isBackground) cumulative += phase.ms;
		const bar = '█'.repeat(Math.min(40, Math.round(phase.ms / 25)));
		console.log(
			`  ${phase.label.padEnd(width)}  ${phase.ms.toFixed(0).padStart(6)}ms ` +
				`${isBackground ? '     ' : `${cumulative.toFixed(0).padStart(6)}ms`} ${bar}`
		);
		if (phase.detail) console.log(`  ${' '.repeat(width)}    └─ ${phase.detail}`);
	}
	console.log('─'.repeat(86));
	console.log(`  TIME TO FIRST ROWS ON SCREEN: ${readyMs.toFixed(0)}ms`);
	console.log(
		`  network: ${stats.shapeCalls} shape round-trips, ${stats.rowsShipped.toLocaleString()} rows, ${stats.networkMs.toFixed(0)}ms on the wire`
	);
}

async function main(): Promise<void> {
	const numeric = (flag: string, fallback: number): number => {
		const arg = process.argv.find((entry) => entry.startsWith(`--${flag}=`));
		return arg ? Number(arg.split('=')[1]) : fallback;
	};
	const rttMs = numeric('rtt', 60);
	const serverQueryMs = numeric('server-query', 250);
	const keep = process.argv.includes('--keep');

	const root = path.join(os.tmpdir(), 'norbital-sync-profile');
	const schemaSql = buildSchemaSql();
	const totalRows = HR_WORKLOAD.reduce((sum, spec) => sum + spec.rows, 0);
	console.log(
		`\nworkload: norbital_hr — ${HR_WORKLOAD.length} collections, ${totalRows.toLocaleString()} rows` +
			`\nfirst paint touches: ${FIRST_PAINT.join(', ')}` +
			`\n\nMEASURED here: PGlite open, DDL, reconcile, restore, catch-up paging, local SQL.` +
			`\nPARAMETERS (a laptop cannot reproduce these honestly):` +
			`\n  --rtt=${rttMs}            one browser → Core → microVM hop` +
			`\n  --server-query=${serverQueryMs}  Core context + guest + Neon for one findMany`
	);

	const results: Record<string, { cold: number; warm: number; warmStats: NetworkStats }> = {};

	for (const variant of ['before', 'after'] as const) {
		if (existsSync(root)) await rm(root, { recursive: true, force: true });
		await mkdir(root, { recursive: true });
		const dataDir = path.join(root, 'replica');

		const cold = await runLoad({ dataDir, schemaSql, rttMs, serverQueryMs, variant });
		renderTable(
			`${variant.toUpperCase()} — COLD LOAD (first ever visit, empty replica)`,
			cold.phases,
			cold.stats,
			cold.totalMs
		);

		const warm = await runLoad({ dataDir, schemaSql, rttMs, serverQueryMs, variant });
		renderTable(
			`${variant.toUpperCase()} — WARM RELOAD (same replica on disk, user pressed refresh)`,
			warm.phases,
			warm.stats,
			warm.totalMs
		);

		results[variant] = { cold: cold.totalMs, warm: warm.totalMs, warmStats: warm.stats };
	}

	const before = results.before!;
	const after = results.after!;
	console.log(`\n${'═'.repeat(86)}`);
	console.log('  VERDICT');
	console.log('═'.repeat(86));
	console.log(`                    cold        warm (the one that matters)`);
	console.log(
		`  before        ${before.cold.toFixed(0).padStart(6)}ms      ${before.warm.toFixed(0).padStart(6)}ms`
	);
	console.log(
		`  after         ${after.cold.toFixed(0).padStart(6)}ms      ${after.warm.toFixed(0).padStart(6)}ms   ` +
			`(${(before.warm / Math.max(1, after.warm)).toFixed(1)}× faster)`
	);
	console.log(
		`\n  warm reload network: ${after.warmStats.shapeCalls} shape round-trips, ${after.warmStats.rowsShipped} rows`
	);
	console.log(`  budget 500ms — warm is ${after.warm > 500 ? 'OVER' : 'UNDER'}\n`);

	if (!keep) await rm(root, { recursive: true, force: true });
}

await main();
