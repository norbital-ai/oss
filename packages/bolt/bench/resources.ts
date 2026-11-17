// The resource benchmark (RFC v0.0.1 W07, R13): one in-process workspace per fixture size through the test kit (PGlite,
// no host), consumers on its live hub, and a database that counts statements. Per scenario: CPU per operation, wall
// p50/p95, statements, serialized live bytes, heap after a forced GC, live/fiber/handle counts after churn, and the work
// an idle workspace does. `run.ts` runs it against `budget.json`; `tests/resources.integration.test.ts` asserts its
// deterministic counts. CPU and latency budgets are in reference units (the machine's fixed JSON round trip), so one
// budget file serves a laptop and a CI runner.
import { findPackageJSON } from 'node:module';
import os from 'node:os';
import { parseArgs } from 'node:util';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Metric, Schema, Scope, Stream } from 'effect';
import type { Sql } from '@norbital-ai/host-api';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { Live, type LiveShape, type LiveView } from '../src/engine/services.ts';
import { lower_read } from '../src/engine/query/engine.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Authority } from '../src/engine/contracts.ts';
import type { Json } from '../src/decl/values.ts';

/** Orders with one owned line each, and one document configuration row (a ~2 KB template) that previews read beside them. */
export const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'An order',
			record_label: 'record.title',
			fields: {
				title: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'] },
				note: { kind: 'text', optional: true },
				amount: { kind: 'decimal', scale: 2 }
			}
		},
		lines: {
			description: 'An order line',
			record_label: 'record.label',
			fields: { label: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		settings: {
			description: 'Document configuration',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, terms: { kind: 'text' } }
		}
	},
	relationships: { 'lines.order': { to: 'orders', inverse: 'lines', owned: true } },
	exposures: {
		orders: {
			outputs: { default: { orders: { fields: 'all' }, 'orders.lines': { fields: 'all' } } },
			create: {
				columns: { orders: ['title', 'region', 'note', 'amount'], 'orders.lines': ['label', 'amount'] }
			},
			update: {
				columns: { orders: ['title', 'region', 'note', 'amount'], 'orders.lines': ['label', 'amount'] }
			}
		},
		lines: { outputs: { default: { lines: { fields: 'all' } } } },
		settings: {
			outputs: { default: { settings: { fields: 'all' } } },
			create: { columns: { settings: ['name', 'terms'] } },
			update: { columns: { settings: ['name', 'terms'] } }
		}
	},
	integrations: {},
	policies: {
		clerk: {
			description: 'Keeps orders and their document configuration',
			grants: {
				orders: { outputs: { default: {} }, create: {}, update: {} },
				lines: { outputs: { default: {} } },
				settings: { outputs: { default: {} }, create: {}, update: {} }
			}
		}
	},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

/** Fiber starts and ends of everything run under `observed`: the active count is their difference. */
export const fibers = { started: 0, ended: 0 };
export const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.provideService(effect, Metric.FiberRuntimeMetrics, {
		recordFiberStart: () => void fibers.started++,
		recordFiberEnd: () => void fibers.ended++
	});

/** What the workspace sent its database: calls, statements, and (while `trace`) each distinct statement's head. */
export type Sent = { trips: number; statements: number; trace: boolean; readonly heads: Set<string> };
const counting = (inner: TenantDbShape, sent: Sent) => {
	const note = (statements: readonly Sql[]) =>
		Effect.sync(() => {
			sent.trips++;
			sent.statements += statements.length;
			if (sent.trace) for (const s of statements) sent.heads.add(s.text.replace(/\s+/g, ' ').slice(0, 80));
		});
	return TenantDb.typed({
		read: (statements) => Effect.andThen(note(statements), inner.read(statements)),
		write: (statement, lock) => Effect.andThen(note([statement]), inner.write(statement, lock)),
		transaction: (batch) => Effect.andThen(note(batch.statements), inner.transaction(batch))
	});
};

/** Fixed width, so an edit leaves every value (and so every retained answer) the same size. */
const pad = (i: number) => String(i).padStart(6, '0');
const TERMS = 'Payment is due within thirty days of the invoice date. '.repeat(36);
const Written = Schema.Struct({
	records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String, revision: Schema.Number }))
});

/** A workspace of `rows` orders, its live hub, a clerk who reads and edits them, and the database it counts. */
export const workspace = (rows: number) =>
	Effect.gen(function* () {
		const sent: Sent = { trips: 0, statements: 0, trace: false, heads: new Set() };
		const inner = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, db: Layer.succeed(TenantDb, counting(inner, sent)) })
		);
		const t = Context.get(context, TestWorkspace),
			live = Context.get(context, Live);
		const clerk = yield* t.as(t.member(['clerk']));
		/** Each row's revision, as its last write left it: an update names the one it changes. */
		const revisions = new Map<string, number>();
		const write = (input: Readonly<Record<string, Json>>) =>
			Effect.gen(function* () {
				const written = yield* Schema.decodeUnknownEffect(Written)(yield* clerk.act(input));
				for (const row of written.records) revisions.set(row.id, row.revision);
				return written.records;
			});
		const seeded = yield* write({
			'orders.create': Array.from({ length: rows }, (_, i) => ({
				title: `Order ${pad(i)}`,
				region: i % 2 === 0 ? 'north' : 'south',
				amount: '10.00',
				lines: [{ label: `Line ${pad(i)}`, amount: '10.00' }]
			})),
			'settings.create': [{ name: 'Quotation', terms: TERMS }]
		});
		const target = (id: string) => ({ id, revision: revisions.get(id) ?? 0 });
		const ids = seeded.filter((row) => row.model === 'orders').map((row) => row.id),
			first = ids[0],
			settings = seeded.find((row) => row.model === 'settings')?.id;
		if (ids.length !== rows || first === undefined || settings === undefined)
			return yield* Effect.die(`the fixture holds ${ids.length} of ${rows} orders`);
		/** The `i`th order, spread over the fixture. */
		const order = (i: number) => ids[i % rows] ?? first;
		const view = (configured: boolean) =>
			Effect.map(
				lower_read(manifest, 'query', [
					{ orders: { limit: rows, lines: {} }, ...(configured ? { settings: {} } : {}) }
				]),
				(read): LiveView => ({ read })
			);
		return {
			rows,
			t,
			live,
			clerk,
			sent,
			/** The orders page as a page holds it; `configured` adds the configuration root a document preview reads. */
			view,
			query: () => clerk.wire_query({ orders: { limit: rows, lines: {} } }),
			/** One order's title, the same width every time. */
			edit: (i: number) =>
				write({ 'orders.update': [{ target: target(order(i * 7919)), set: { title: `Edit  ${pad(i)}` } }] }),
			/** One act updating 25 orders (every order of a smaller fixture). */
			batch: (i: number) => {
				const n = Math.min(25, rows),
					stride = Math.floor(rows / n);
				return write({
					'orders.update': Array.from({ length: n }, (_, j) => ({
						target: target(order(i + j * stride)),
						set: { note: `Batch ${pad(i)}` }
					}))
				});
			},
			/** The document configuration's template text. */
			configure: (i: number) =>
				write({ 'settings.update': [{ target: target(settings), set: { terms: `${TERMS}${pad(i)}` } }] })
		};
	});
export type Fixture = Effect.Success<ReturnType<typeof workspace>>;

const utf8 = new TextEncoder();
/** The live connection a page holds: every frame's serialized bytes (the SSE payload layer), and the newest commit seen. */
export const consumer = (live: LiveShape, authority: Authority) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make();
		const hello = yield* Deferred.make<string>();
		const waiting = new Set<{ readonly ready: () => boolean; readonly resume: () => void }>();
		const state = { bytes: 0, frames: 0, answers: 0, v: 0, ended: false };
		const wake = () => {
			for (const waiter of waiting)
				if (state.ended || waiter.ready()) {
					waiting.delete(waiter);
					waiter.resume();
				}
		};
		yield* live.connect(authority).pipe(
			Stream.runForEach((frame) =>
				Effect.gen(function* () {
					state.bytes += utf8.encode(JSON.stringify(frame)).byteLength;
					state.frames++;
					if (frame.t === 'answer' || frame.t === 'same') state.answers++;
					if ('v' in frame) state.v = Math.max(state.v, frame.v);
					if (frame.t === 'hello') yield* Deferred.succeed(hello, frame.conn);
					wake();
				})
			),
			Effect.ensuring(
				Effect.sync(() => {
					state.ended = true;
					wake();
				})
			),
			Effect.forkIn(scope)
		);
		const conn = yield* Deferred.await(hello);
		/** Waits for the stream to reach `ready`; a stream that ended first is the live hub closing it, a defect of the run. */
		const until = (ready: () => boolean) =>
			Effect.callback<void>((resume) => {
				const waiter = {
					ready,
					resume: () => resume(state.ended ? Effect.die(`live connection ${conn} ended`) : Effect.void)
				};
				waiting.add(waiter);
				wake();
				return Effect.sync(() => waiting.delete(waiter));
			});
		return {
			conn,
			state,
			until,
			/** Registers a view and waits for its first answer. */
			open: (view: string, read: LiveView) =>
				Effect.gen(function* () {
					const answered = state.answers;
					yield* live.register(conn, view, read);
					yield* until(() => state.answers > answered);
				}),
			close: Scope.close(scope, Exit.void)
		};
	});
export type Consumer = Effect.Success<ReturnType<typeof consumer>>;

/** Every consumer has the frames of the newest commit, background work included. */
export const delivered = (f: Fixture, consumers: readonly Consumer[]) =>
	Effect.gen(function* () {
		yield* f.t.settled();
		const v = yield* f.live.v;
		yield* f.live.settled;
		yield* Effect.forEach(consumers, (c) => c.until(() => c.state.v >= v), { discard: true });
	});
/** `count` consumers holding `read` while `body` runs; closed after it. */
export const holding = <A, E>(
	f: Fixture,
	count: number,
	read: LiveView,
	body: (consumers: readonly Consumer[]) => Effect.Effect<A, E>
) =>
	Effect.gen(function* () {
		const consumers: Consumer[] = [];
		for (let i = 0; i < count; i++) {
			const c = yield* consumer(f.live, f.clerk.authority);
			consumers.push(c);
			yield* c.open('page', read);
		}
		return yield* body(consumers).pipe(
			Effect.ensuring(Effect.forEach(consumers, (c) => c.close, { discard: true }))
		);
	});

const tally = (f: Fixture, consumers: readonly Consumer[]) => ({
	statements: f.sent.statements,
	trips: f.sent.trips,
	bytes: consumers.reduce((sum, c) => sum + c.state.bytes, 0),
	frames: consumers.reduce((sum, c) => sum + c.state.frames, 0)
});
/** One operation as measured around it: wall time to delivery, and what it sent the database and every consumer. */
export type Sample = { readonly ms: number } & ReturnType<typeof tally>;
/** `warmup` operations, then `samples` measured ones, each until delivered; CPU is the process's, per operation. */
export const sampled = <E>(
	f: Fixture,
	consumers: readonly Consumer[],
	op: (i: number) => Effect.Effect<unknown, E>,
	counts: { readonly warmup: number; readonly samples: number }
) =>
	Effect.gen(function* () {
		for (let i = 0; i < counts.warmup; i++) {
			yield* op(i);
			yield* delivered(f, consumers);
		}
		const samples: Sample[] = [];
		const cpu = process.cpuUsage();
		for (let i = counts.warmup; i < counts.warmup + counts.samples; i++) {
			const before = tally(f, consumers),
				start = performance.now();
			yield* op(i);
			yield* delivered(f, consumers);
			const ms = performance.now() - start,
				after = tally(f, consumers);
			samples.push({
				ms,
				statements: after.statements - before.statements,
				trips: after.trips - before.trips,
				bytes: after.bytes - before.bytes,
				frames: after.frames - before.frames
			});
		}
		const used = process.cpuUsage(cpu);
		return { cpu_ms: (used.user + used.system) / 1000 / counts.samples, samples };
	});

/** What lives while nothing is open: retained live answers, active fibers, and the process's active handles. */
export const footprint = (f: Fixture) =>
	Effect.map(f.live.retained, (retained) => ({
		retained,
		fibers: fibers.started - fibers.ended,
		handles: process.getActiveResourcesInfo().length
	}));
/** One open-and-close of a page: connect, register the view, take its answer, drop it, disconnect. */
export const cycle = (f: Fixture, read: LiveView) =>
	Effect.gen(function* () {
		const c = yield* consumer(f.live, f.clerk.authority);
		yield* c.open('churn', read);
		yield* f.live.drop(c.conn, 'churn');
		yield* c.close;
		return c.state;
	});
/**
 * `cycles` page cycles after `warmup`: the cost of each, what stays once they are done (retained live bytes, active fibers
 * and handles, against before them), and the retained heap's growth per cycle over their second half (diagnostic).
 */
export const churn = (f: Fixture, read: LiveView, counts: { readonly warmup: number; readonly cycles: number }) =>
	Effect.gen(function* () {
		for (let i = 0; i < counts.warmup; i++) yield* cycle(f, read);
		const before = yield* footprint(f),
			samples: Sample[] = [];
		let cpu_us = 0,
			half = heap();
		for (let i = 0; i < counts.cycles; i++) {
			if (i === Math.floor(counts.cycles / 2)) half = heap();
			const sent = { statements: f.sent.statements, trips: f.sent.trips },
				cpu = process.cpuUsage(),
				start = performance.now();
			const state = yield* cycle(f, read);
			const used = process.cpuUsage(cpu);
			cpu_us += used.user + used.system;
			samples.push({
				ms: performance.now() - start,
				statements: f.sent.statements - sent.statements,
				trips: f.sent.trips - sent.trips,
				bytes: state.bytes,
				frames: state.frames
			});
		}
		const end = heap(),
			after = yield* footprint(f),
			second = counts.cycles - Math.floor(counts.cycles / 2);
		return {
			cpu_ms: cpu_us / 1000 / Math.max(1, counts.cycles),
			samples,
			retained_after: after.retained - before.retained,
			fibers_after: after.fibers - before.fibers,
			handles_after: after.handles - before.handles,
			heap_growth: Math.round((end.heap_used - half.heap_used) / second),
			external_growth: Math.round((end.external - half.external) / second)
		};
	});

/**
 * An idle workspace with pages open: `wait` (real time, or nothing), then a day of its clock in hours, each settled. Counts
 * what it sent the database and the consumers, the fibers it started, and the heads of the statements it ran.
 */
export const idle = <E>(f: Fixture, consumers: readonly Consumer[], wait: Effect.Effect<void, E>) =>
	Effect.gen(function* () {
		yield* delivered(f, consumers);
		const before = tally(f, consumers),
			started = fibers.started,
			cpu = process.cpuUsage();
		f.sent.heads.clear();
		f.sent.trace = true;
		yield* wait;
		for (let hour = 0; hour < 24; hour++) {
			f.t.clock.advance('1h');
			yield* f.t.settled();
		}
		yield* f.live.settled;
		const used = process.cpuUsage(cpu),
			after = tally(f, consumers);
		f.sent.trace = false;
		return {
			statements: after.statements - before.statements,
			trips: after.trips - before.trips,
			bytes: after.bytes - before.bytes,
			frames: after.frames - before.frames,
			fibers: fibers.started - started,
			cpu_ms: (used.user + used.system) / 1000,
			heads: [...f.sent.heads]
		};
	});

/** Flat metrics per scenario, and the ceilings a budget sets on some of them. */
export type Metrics = Readonly<Record<string, number>>;
const Budget = Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number));
/** Every scenario needs a budget and every budget a scenario: a blank budget is an open gate, not a pass. */
export const judge = (results: Readonly<Record<string, Metrics>>, budget: Readonly<Record<string, Metrics>>) =>
	[...new Set([...Object.keys(results), ...Object.keys(budget)])].flatMap((name) => {
		const result = results[name],
			ceilings = budget[name];
		if (result === undefined) return [`${name}: a budget without a scenario`];
		if (ceilings === undefined) return [`${name}: no budget`];
		return Object.entries(ceilings).flatMap(([metric, ceiling]) => {
			const value = result[metric];
			return value !== undefined && value <= ceiling ? [] : [`${name}.${metric}: ${value} over ${ceiling}`];
		});
	});

const median = (values: readonly number[]) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};
const quantile = (values: readonly number[], q: number) => {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
};
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
/** The heap after a forced full collection (twice: finalizers free more): what is retained, not what is garbage. */
const heap = () => {
	globalThis.gc?.();
	globalThis.gc?.();
	const { heapUsed, external, arrayBuffers } = process.memoryUsage();
	return { heap_used: heapUsed, external, array_buffers: arrayBuffers };
};
/**
 * CPU milliseconds of a fixed JSON round trip (the best of seven): the machine's unit. CPU and latency budgets divide by
 * it, so the same budget judges a laptop and a CI runner; raw milliseconds are reported beside it.
 */
const reference = () => {
	const value = Array.from({ length: 2_000 }, (_, i) => ({
		id: `0199a000-0000-4000-8000-${pad(i).padStart(12, '0')}`,
		title: `Order ${pad(i)}`,
		lines: [{ label: `Line ${pad(i)}`, amount: '10.00' }]
	}));
	let best = Number.POSITIVE_INFINITY;
	for (let round = 0; round < 7; round++) {
		const start = process.cpuUsage();
		for (let i = 0; i < 20; i++) JSON.parse(JSON.stringify(value));
		const used = process.cpuUsage(start);
		best = Math.min(best, (used.user + used.system) / 1000);
	}
	return best;
};
/** A scenario's timed samples as metrics: CPU and p95 also in reference units, counts as their per-operation maximum. */
const summary = (unit: number, measured: { cpu_ms: number; samples: readonly Sample[] }) => {
	const { cpu_ms, samples } = measured,
		ms = samples.map((s) => s.ms),
		most = (key: 'statements' | 'trips' | 'bytes' | 'frames') => Math.max(...samples.map((s) => s[key]));
	const p95_ms = quantile(ms, 0.95);
	return {
		cpu_ms: round(cpu_ms),
		cpu: round(cpu_ms / unit),
		p50_ms: round(quantile(ms, 0.5)),
		p95_ms: round(p95_ms),
		p95: round(p95_ms / unit),
		statements: most('statements'),
		trips: most('trips'),
		live_bytes: most('bytes'),
		frames: most('frames'),
		...heap()
	};
};

export const SIZES = [25, 250, 2_500] as const;
const CONSUMERS = [1, 2, 5] as const;
const COUNTS = { warmup: 5, samples: 30 } as const;
const CYCLES = 60;

/** One run: every scenario at every size, each size in its own workspace; `unit` is this run's reference. */
const suite = (sizes: readonly number[], unit: number) =>
	Effect.gen(function* () {
		const out: Record<string, Metrics> = {};
		/** Each scenario logs as it starts, so a stalled one names itself. */
		const scenario = <E>(name: string, measure: Effect.Effect<Metrics, E>) =>
			Effect.logInfo(name).pipe(
				Effect.andThen(measure),
				Effect.map((metrics) => void (out[name] = metrics))
			);
		for (const rows of sizes)
			yield* Effect.scoped(
				Effect.gen(function* () {
					const f = yield* workspace(rows),
						page = yield* f.view(false),
						preview = yield* f.view(true);
					yield* scenario(`query/${rows}`, Effect.map(sampled(f, [], f.query, COUNTS), (m) => summary(unit, m)));
					for (const n of CONSUMERS)
						yield* scenario(
							`edit/${rows}/c${n}`,
							Effect.map(holding(f, n, page, (cs) => sampled(f, cs, f.edit, COUNTS)), (m) => summary(unit, m))
						);
					yield* scenario(
						`batch/${rows}`,
						Effect.map(holding(f, 1, page, (cs) => sampled(f, cs, f.batch, COUNTS)), (m) => summary(unit, m))
					);
					yield* scenario(
						`config/${rows}`,
						Effect.map(holding(f, 1, preview, (cs) => sampled(f, cs, f.configure, COUNTS)), (m) => summary(unit, m))
					);
					yield* scenario(
						`churn/${rows}`,
						Effect.map(churn(f, page, { warmup: COUNTS.warmup, cycles: CYCLES }), (churned) => ({
							...summary(unit, churned),
							retained_after: churned.retained_after,
							fibers_after: churned.fibers_after,
							handles_after: churned.handles_after,
							heap_growth: churned.heap_growth,
							external_growth: churned.external_growth
						}))
					);
					yield* scenario(
						`idle/${rows}`,
						Effect.gen(function* () {
							const quiet = yield* holding(f, 1, page, (pages) =>
								holding(f, 1, preview, (previews) => idle(f, [...pages, ...previews], Effect.sleep('2 seconds')))
							);
							if (quiet.heads.length > 0) yield* Effect.logWarning(`idle/${rows} ran: ${quiet.heads.join(' | ')}`);
							return {
								statements: quiet.statements,
								trips: quiet.trips,
								live_bytes: quiet.bytes,
								frames: quiet.frames,
								fibers: quiet.fibers,
								cpu_ms: round(quiet.cpu_ms)
							};
						})
					);
				})
			);
		return out;
	});

class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()('BudgetExceeded', {
	failures: Schema.Array(Schema.String)
}) {}
const Version = Schema.Struct({ version: Schema.String });

/**
 * `--runs=N` (default 3) whole runs; each metric is the median of its runs, `noise_*` the spread of the timed ones.
 * `--budget=<file>` judges the medians and fails outside it; `--out=<file>` writes the results; `--label` names the source;
 * `--sizes=25,250` narrows the fixture sizes.
 */
export const main = (argv: readonly string[]) => {
	const { values } = parseArgs({
		args: [...argv],
		options: {
			runs: { type: 'string', default: '3' },
			budget: { type: 'string' },
			out: { type: 'string' },
			label: { type: 'string', default: 'local' },
			sizes: { type: 'string', default: SIZES.join(',') }
		}
	});
	const program = Effect.gen(function* () {
		if (globalThis.gc === undefined) return yield* Effect.die('run with --expose-gc: retained heap needs a forced GC');
		const fs = yield* FileSystem.FileSystem;
		const sizes = values.sizes.split(',').map(Number),
			runs: Record<string, Metrics>[] = [],
			units: number[] = [];
		for (let run = 0; run < Number(values.runs); run++) {
			const unit = reference();
			units.push(unit);
			runs.push(yield* observed(suite(sizes, unit)));
			yield* Effect.logInfo(`run ${run + 1}/${values.runs} done (reference ${round(unit)} ms)`);
		}
		const scenarios: Record<string, Metrics> = {};
		for (const name of Object.keys(runs[0] ?? {})) {
			const all = runs.flatMap((r) => (r[name] === undefined ? [] : [r[name]]));
			const merged: Record<string, number> = {};
			for (const metric of Object.keys(all[0] ?? {})) merged[metric] = median(all.map((m) => m[metric] ?? Number.NaN));
			for (const metric of ['cpu_ms', 'p95_ms'])
				if (merged[metric] !== undefined && all.length > 1) {
					const seen = all.map((m) => m[metric] ?? Number.NaN);
					merged[`noise_${metric.replace('_ms', '')}`] = round(
						(Math.max(...seen) - Math.min(...seen)) / (median(seen) || 1),
						2
					);
				}
			scenarios[name] = merged;
		}
		const effect = findPackageJSON('effect', import.meta.url);
		const result = {
			label: values.label,
			node: process.version,
			effect:
				effect === undefined
					? 'unknown'
					: (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Version))(yield* fs.readFileString(effect)))
							.version,
			machine: `${os.cpus()[0]?.model ?? 'unknown'} x${os.availableParallelism()}, ${round(os.totalmem() / 2 ** 30, 1)} GiB, ${os.platform()} ${os.arch()}`,
			runs: runs.length,
			counts: { ...COUNTS, cycles: CYCLES },
			reference_ms: round(median(units)),
			scenarios
		};
		console.table(
			Object.fromEntries(
				Object.entries(scenarios).map(([name, m]) => [
					name,
					Object.fromEntries(
						['cpu_ms', 'p50_ms', 'p95_ms', 'statements', 'live_bytes', 'frames', 'noise_cpu', 'noise_p95']
							.filter((key) => m[key] !== undefined)
							.map((key) => [key, m[key]])
					)
				])
			)
		);
		if (values.out !== undefined) yield* fs.writeFileString(values.out, `${JSON.stringify(result, null, '\t')}\n`);
		if (values.budget === undefined) return;
		const budget = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Budget))(
			yield* fs.readFileString(values.budget)
		);
		const failures = judge(scenarios, budget);
		if (failures.length > 0) return yield* new BudgetExceeded({ failures });
		yield* Effect.logInfo(`every scenario is within ${values.budget}`);
	});
	NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)));
};
