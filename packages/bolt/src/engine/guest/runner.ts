/// <reference types="node" />
// The isolate runner (A10, §5.8, rules 6, 12, 71, 72): one fresh isolate per invocation, shared by every host (P18);
// the isolate is prepared (prelude + evaluated bundle) off the request path and used by exactly one invocation.
// Walls: guest CPU (cumulative isolate thread time, I/O excluded) and 256 MiB per invocation; each crossing's I/O under
// the per-call wall; no invocation wall clock. Crossings, answer bytes and read bytes are counted here.
//
// The C2 guest ABI: `guest.mjs` is one ES module whose default export holds the code roles by name,
// `{ collection, automation, custom_field, integration, pipeline, … }`, each declaration as its role file exports it.
// A body is found by `bodyPath`; reads are lowered to `ReadIR` host-side (`lowerRead`), so the guest spends no CPU on it.
import { INFER_MS } from '../agent/ai.ts';
import { createHash } from 'node:crypto';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import ivm from 'isolated-vm';
import type { Json } from '../../decl/values.ts';
import { BoltError, type Bridge, type CrossAnswer, type CrossCall, type GuestOutcome, type GuestPort, type Invocation, type InvocationKind,
	LIMITS, type ReadIR } from '../contracts.ts';
import { PRELUDE } from './prelude.ts';
import type { EventLog } from './telemetry.ts';

/** `assets`: the bytes of each `?bytes` import by sha256 (§5.8), read synchronously by the isolate. */
/** An invocation's crossings and database statements; a statement is one `read`, `act`, `schedule`, `notify` or `send` call. */
export type Tally = { crossings: number; statements: number };
const STATEMENTS: ReadonlySet<string> = new Set(['read', 'act', 'schedule', 'notify', 'send']);
/** `snapshot`: `guest.snapshot`, the prelude and the evaluated bundle as a V8 heap for this host (compiler/artifact/snapshot.ts). */
export type GuestProgram = { source: string; sourceMap?: string; assets?: Readonly<Record<string, Uint8Array>>; snapshot?: Uint8Array };
export type GuestOptions = {
	/** The query compiler's lowering of a guest read (`read`, `get`, …, `db.read`, `db.after`); a throw refuses that call. */
	lowerRead(member: string, args: readonly Json[]): ReadIR;
	/** The invocation's telemetry; sliced between crossings (§5.12). */
	events?: EventLog;
	/** Guest `console` lines; default: stdout, labelled with the invocation. */
	console?(level: string, line: string, invocation: Invocation): void;
	/** Per-crossing I/O wall; at most `LIMITS.callMs.database` (60 s, X-28). */
	callWallMs?: number;
	/**
	 * hook:metering — each invocation's guest CPU, reported once it settles (the host bills it), with its crossings (calls
	 * out of the isolate, journal hits refunded) and the database statements those calls asked for (the dispatch log line).
	 */
	cpu?(invocation: Invocation, cpuMs: number, counts: Tally): void;
	/** hook:drains — the generation scope (rule 71a): its abort disposes every running isolate and ends its crossing at once. */
	signal?: AbortSignal;
};

/** Where a body lives in the guest's default export. `mapping` and `tool` targets are that path, dotted. */
export function bodyPath(kind: InvocationKind, target: string): string[] {
	const dot = target.indexOf('.');
	const collection = target.slice(0, dot), member = target.slice(dot + 1);
	switch (kind) {
		case 'projection': return ['collection', target, 'bodies', 'project'];
		case 'transform': return ['collection', target, 'bodies', 'transform'];
		case 'query': return ['collection', collection, 'bodies', 'queries', member];
		case 'action': return ['collection', collection, 'bodies', 'actions', member];
		case 'similarity': return ['collection', collection, 'bodies', 'similarity', member, 'probe'];
		case 'rerank': return ['collection', collection, 'bodies', 'similarity', member, 'rerank']; // hook:reads
		case 'automation': return ['automation', target, 'body'];
		case 'validation': return ['custom_field', target, 'check'];
		default: return target.split('.');
	}
}

const object = (v: Json | undefined): { readonly [key: string]: Json } => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as { readonly [key: string]: Json } : {};

/** A guest `ctx` member call as the contract's `CrossCall`. */
export function lower(member: string, args: readonly Json[], bins: readonly Uint8Array[], lowerRead: GuestOptions['lowerRead']): CrossCall {
	if(member==='db.prepareCreate'){
		const options=object(args[2]);
		if(typeof args[0]!=='string'||args[1]===undefined||!Array.isArray(options.path)||options.path.some(part=>typeof part!=='string'&&typeof part!=='number'))throw new BoltError('invalidInput','guest','prepareCreate requires an actual collection, native values and owned create path');
		return {op:'prepareCreate',collection:args[0],values:args[1],path:options.path as (string|number)[]};
	}
	const dot = member.indexOf('.');
	const head = dot < 0 ? member : member.slice(0, dot), method = dot < 0 ? '' : member.slice(dot + 1);
	switch (head) {
		case 'read': case 'get': case 'aggregate': case 'similar': case 'history': case 'query': case 'db':
			return { op: 'read', read: lowerRead(member, args), params: {} };
		case 'act': {
			const o = object(args[2]);
			const options = { ...(typeof o.key === 'string' ? { key: o.key } : {}), ...(typeof o.once === 'string' ? { once: o.once } : {}),
				...(o.onConflict === 'update' || o.onConflict === 'keep' ? { onConflict: o.onConflict as 'update' | 'keep' } : {}) }; // hook:ctx-types (rule 28)
			return { op: 'act', callable: String(args[0]), input: args[1] ?? null, ...(Object.keys(options).length > 0 ? { options } : {}) };
		}
		case 'schedule': {
			const o = object(args[2]);
			return { op: 'schedule', automation: String(args[0]), input: args[1] ?? null,
				...(o.at !== undefined ? { at: o.at as string } : {}), ...(typeof o.key === 'string' ? { key: o.key } : {}) };
		}
		case 'notify': return { op: 'notify', notices: args[0] ?? null };
		case 'send': return { op: 'send', channel: String(args[0]), message: args[1] ?? null };
		case 'progress': return { op: 'progress', progress: args[0] ?? null }; // hook:runtime
		case 'http': case 'web': case 'files': case 'ai': case 'geo': case 'convert':
			return { op: 'facility', facility: head, method, args, ...(bins.length > 0 ? { bins } : {}) };
	}
	throw new Error(`the guest called an unknown ctx member '${member}'`);
}

const messageOf = (e: unknown): string => e instanceof Error ? e.message : String(e);
const fail = (code: string, message: string) => ({ ok: false, error: { kind: 'bolt', code, message } }) as const;

/** One crossing's I/O under the per-call wall: a timeout, a throw or a malformed answer is each call's typed failure. */
async function crossWithin(bridge: Bridge, calls: readonly CrossCall[], wallMs: number, scope?: AbortSignal): Promise<readonly CrossAnswer[]> {
	if (calls.length === 0) return [];
	const signal = scope === undefined ? AbortSignal.timeout(wallMs) : AbortSignal.any([AbortSignal.timeout(wallMs), scope]); // hook:drains
	const wall = new Promise<'timeout'>((resolve) => signal.addEventListener('abort', () => resolve('timeout'), { once: true }));
	let got: readonly CrossAnswer[] | 'timeout';
	try {
		got = await Promise.race([Promise.resolve().then(() => bridge.cross(calls, signal)), wall]);
	} catch (e) {
		return calls.map(() => fail('bridge', messageOf(e)));
	}
	if (got === 'timeout') return calls.map(() => ({ ok: false, error: { kind: 'timeout', message: `no answer within ${wallMs} ms` } }));
	if (!Array.isArray(got) || got.length !== calls.length) return calls.map(() => fail('badAnswer', 'the host answered a different number of calls'));
	return got;
}

/** The prelude's `$3`: a `?bytes` import's bytes by sha256, or undefined (the guest then throws naming the sha). */
export const assetHook = (assets: GuestProgram['assets']) => (sha: unknown): Uint8Array | undefined =>
	assets !== undefined && typeof sha === 'string' && Object.hasOwn(assets, sha) ? assets[sha] : undefined;

const DIGESTS: { readonly [name: string]: string } = { 'SHA-1': 'sha1', 'SHA-256': 'sha256', 'SHA-384': 'sha384', 'SHA-512': 'sha512' };

/** `crypto.subtle.digest`'s host half. */
export function digest(name: unknown, bytes: unknown): Uint8Array { // hook:check — `bolt check` installs the same prelude
	const algorithm = DIGESTS[String(name).toUpperCase()];
	if (algorithm === undefined || !(bytes instanceof Uint8Array)) throw new Error(`digest supports ${Object.keys(DIGESTS).join(', ')}`);
	return new Uint8Array(createHash(algorithm).update(bytes).digest());
}

/** The invocation's entropy: SHA-256 blocks of its seed, so a replay with the same seed draws the same values. */
export function randomStream(seed: string): (n: unknown) => Uint8Array {
	let counter = 0;
	let pool = Buffer.alloc(0);
	return (n) => {
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65_536) throw new Error('random takes 0 to 65536 bytes');
		const blocks = [pool];
		for (let have = pool.length; have < n; have += 32) blocks.push(createHash('sha256').update(seed).update(String(counter++)).digest());
		pool = Buffer.concat(blocks);
		const out = new Uint8Array(pool.subarray(0, n));
		pool = pool.subarray(n);
		return out;
	};
}

type Final = ['ok', string] | ['refused', string, string | null] | ['error', string, string, string] | ['missing', string];
type Taken = [Final | null, readonly (readonly [member: string, json: string, site: string, id: number])[], readonly (readonly Uint8Array[])[], ranTimer: boolean];

export function guestRunner(program: GuestProgram, options: GuestOptions): GuestPort {
	const map = program.sourceMap === undefined ? undefined : new TraceMap(program.sourceMap);
	/** A stack frame as `file:line`, through the source map when there is one. */
	const where = (frame: string): string => {
		const m = /([^\s()]+):(\d+):(\d+)\)?$/.exec(frame);
		if (m === null) return frame;
		const [, file = '', line = '0', column = '1'] = m;
		if (map !== undefined && file === 'guest.mjs') {
			const o = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
			if (o.source !== null) return `${o.source}:${o.line}`;
		}
		return `${file}:${line}`;
	};
	const key = `${createHash('sha256').update(program.source).digest('hex')}:${process.versions.v8}`;
	const warm = warmPool(program, key, options.signal);
	return { invoke: async (invocation, bridge) => {
		const tally: Tally = { crossings: 0, statements: 0 };
		const outcome = await run(warm, program, key, where, options, invocation, bridge, tally);
		try { options.cpu?.(invocation, outcome.cpuMs, tally); } catch { /* metering never fails an invocation */ } // hook:metering
		return outcome;
	} };
}

// ── prepared isolates (memory ivm-prepared-context-pipeline) ──
// Evaluating `guest.mjs` is the fixed cost of every invocation (hr-payroll: ≈28 ms compile + ≈55 ms evaluate; a small
// template ≈3 ms); an artifact's `guest.snapshot` skips both (hr-payroll ≈3 ms guest CPU). A prepared isolate is a fresh isolate with the prelude installed and the bundle evaluated, made off the
// request path; one invocation takes it, runs its body and disposes it. It is never returned, reset or shared: a
// prepared isolate has seen no input, no ctx and no other invocation, so taking it is the same as creating it.
// Its guest CPU meter starts at its creation, so an invocation is charged the evaluation as before (2 s wall unchanged).

/** One prepared isolate. `bind` is where the prelude's host hooks point; the taker binds its invocation's before running. */
type Warm = {
	isolate: ivm.Isolate; context: ivm.Context; start: ivm.Reference; take: ivm.Reference; give: ivm.Reference;
	cpuStart: bigint; bytes: number; bind: Bind; early: [level: string, line: string][];
};
type Bind = { say(level: string, line: string): void; random(n: unknown): Uint8Array };
type Unprepared = { failed: unknown; halted?: BoltError; cpuMs: number };

/**
 * The process-wide limits of prepared isolates, set by the host before it serves. `maxMiB` bounds the
 * V8 heap of every idle prepared isolate across all programs; past it the least recently used program's are disposed.
 * `depth` is how many one program keeps ready (0 turns preparing off: every invocation evaluates inline, as before).
 * `idleMs`: a program not invoked for this long drops its prepared isolates.
 */
export const warmLimits = { maxMiB: 512, depth: 2, idleMs: 60_000 };
const counters = { live: 0, warm: 0, warmBytes: 0, preparing: 0, hits: 0, misses: 0, evicted: 0, failed: 0 };
/** Isolate counts for a host's telemetry: `live` isolates (running and prepared), `warm` prepared and idle, and their bytes. */
export const guestIsolates = (): Readonly<typeof counters> => ({ ...counters });

const dropped = new WeakSet<ivm.Isolate>();
/** Every isolate ends here exactly once, whoever disposes it. */
function drop(isolate: ivm.Isolate): void {
	if (dropped.has(isolate)) return;
	dropped.add(isolate);
	counters.live--;
	if (!isolate.isDisposed) isolate.dispose();
}

type Pool = { take(): Warm | undefined; refill(): void; evictOne(): boolean; healthy(): void };
/** Pools in least-recently-invoked order; a use moves a pool to the end. */
const pools = new Set<Pool>();
function underLimit(keep: Pool): void {
	const max = warmLimits.maxMiB * 2 ** 20;
	for (const p of pools) {
		if (counters.warmBytes <= max) return;
		while (counters.warmBytes > max && p.evictOne());
	}
	while (counters.warmBytes > max && keep.evictOne());
}

function warmPool(program: GuestProgram, key: string, signal: AbortSignal | undefined): Pool {
	const ready: Warm[] = [];
	let pending = 0, broken = false, idle: NodeJS.Timeout | undefined;
	const evictOne = (): boolean => {
		const w = ready.shift();
		if (w === undefined) return false;
		counters.warm--; counters.warmBytes -= w.bytes; counters.evicted++;
		drop(w.isolate);
		if (ready.length === 0) pools.delete(pool);
		return true;
	};
	const clear = (): void => { while (evictOne()); };
	const pool: Pool = {
		evictOne,
		take() {
			clearTimeout(idle);
			idle = setTimeout(clear, warmLimits.idleMs);
			idle.unref();
			const w = ready.pop();
			pools.delete(pool);
			if (ready.length > 0) pools.add(pool); // most recently invoked: evicted last
			if (w === undefined) { counters.misses++; return undefined; }
			counters.hits++; counters.warm--; counters.warmBytes -= w.bytes;
			return w;
		},
		refill() {
			while (!broken && signal?.aborted !== true && ready.length + pending < warmLimits.depth) {
				pending++; counters.preparing++;
				void prepare(program, key, signal).then((w) => {
					pending--; counters.preparing--;
					if (!('isolate' in w)) { broken = true; counters.failed++; return; } // the inline path reports it; stop retrying
					if (signal?.aborted === true || ready.length >= warmLimits.depth) { drop(w.isolate); return; }
					ready.push(w);
					counters.warm++; counters.warmBytes += w.bytes;
					pools.delete(pool); pools.add(pool);
					underLimit(pool);
				});
			}
		},
		/** An inline preparation succeeded: background preparation resumes. */
		healthy() { broken = false; },
	};
	// hook:drains — rule 71a (b): prepared isolates belong to the generation and die with it
	signal?.addEventListener('abort', () => { clearTimeout(idle); clear(); }, { once: true });
	return pool;
}

/** A stretch of guest execution under the CPU wall: a timer armed at the budget left, re-armed, never a poll. */
async function cpuWall<T>(cpu: () => number, budget: number, over: () => void, work: () => Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const check = (): void => {
		const left = budget - cpu();
		if (left <= 0) over();
		else timer = setTimeout(check, Math.max(1, left));
	};
	check();
	try {
		return await work();
	} finally {
		clearTimeout(timer);
		if (cpu() >= budget) over();
	}
}

/** The program's snapshot, copied out of the heap once and restored by every isolate. */
const snapshots = new WeakMap<Uint8Array, ivm.ExternalCopy<ArrayBuffer>>();
function snapshotOf(bytes: Uint8Array): ivm.ExternalCopy<ArrayBuffer> {
	let copy = snapshots.get(bytes);
	if (copy === undefined) snapshots.set(bytes, copy = new ivm.ExternalCopy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
	return copy;
}

/**
 * A fresh isolate with the prelude and the evaluated bundle: restored from the program's snapshot when it has one (its
 * hooks bound, nothing evaluated: the snapshot's evaluation called no hook), else evaluated here. Evaluation runs under the CPU wall and the generation scope;
 * its console lines wait in `early` for the invocation that takes it, and its entropy is drawn from the program's own
 * stream (no invocation seed exists yet), so a replay still draws the same values. Never throws.
 */
async function prepare(program: GuestProgram, key: string, signal: AbortSignal | undefined): Promise<Warm | Unprepared> {
	const isolate = new ivm.Isolate({ memoryLimit: LIMITS.guestMemoryMiB, ...(program.snapshot === undefined ? {} : { snapshot: snapshotOf(program.snapshot) }) });
	counters.live++;
	const cpuStart = isolate.cpuTime;
	const cpu = (): number => isolate.isDisposed ? 0 : Number(isolate.cpuTime - cpuStart) / 1e6;
	let halted: BoltError | undefined, cpuMs = 0;
	const stop = (error: BoltError): void => { halted ??= error; cpuMs = cpu() || cpuMs; drop(isolate); };
	const onAbort = () => stop(new BoltError('interrupted', 'guest', 'the invocation was interrupted: its generation is draining (rule 71a)'));
	signal?.addEventListener('abort', onAbort, { once: true });
	if (signal?.aborted === true) onAbort();
	const early: [string, string][] = [];
	const bind: Bind = { say: (level, line) => { if (early.length < 200) early.push([level, line]); }, random: randomStream(`prepare:${key}`) };
	try {
		const context = await isolate.createContext();
		const hooks = await context.evalClosure(program.snapshot === undefined ? PRELUDE : 'return globalThis.__boltBind($0, $1, $2, $3);',
			[(level: unknown, line: unknown) => bind.say(String(level), String(line)), (n: unknown) => bind.random(n), digest, assetHook(program.assets)],
			{ filename: 'bolt:prelude', result: { reference: true } });
		const [start, take, give] = await Promise.all((['start', 'take', 'give'] as const).map((k) => hooks.get(k, { reference: true })));
		if (start === undefined || take === undefined || give === undefined) throw new Error('the prelude did not return its hooks');
		if (program.snapshot === undefined) {
			const module = await isolate.compileModule(program.source, { filename: 'guest.mjs' });
			await module.instantiate(context, (specifier) => {
				throw new Error(`guest.mjs is one module; it imports '${specifier}'`);
			});
			await cpuWall(() => (cpuMs = cpu() || cpuMs), LIMITS.guestCpuMs,
				() => stop(new BoltError('cpuBudget', 'guest', `the invocation used its ${LIMITS.guestCpuMs} ms of guest CPU`)), () => module.evaluate());
			if (halted !== undefined) throw halted;
			await context.global.set('__boltGuest', module.namespace.derefInto());
		}
		const heap = await isolate.getHeapStatistics();
		return { isolate, context, start, take, give, cpuStart, bind, early, bytes: heap.total_heap_size + heap.externally_allocated_size };
	} catch (e) {
		const failed: Unprepared = { failed: e, cpuMs: cpu() || cpuMs, ...(halted === undefined ? {} : { halted }) };
		drop(isolate);
		return failed;
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
}

async function run(pool: Pool, program: GuestProgram, key: string, where: (frame: string) => string, options: GuestOptions, inv: Invocation,
	bridge: Bridge, tally: Tally): Promise<GuestOutcome> {
	const wallMs = Math.min(options.callWallMs ?? LIMITS.callMs.database, LIMITS.callMs.database);
	const budget = inv.budget.cpuMs;
	const interrupted = () => new BoltError('interrupted', 'guest', 'the invocation was interrupted: its generation is draining (rule 71a)'); // hook:drains
	if (options.signal?.aborted === true) return { kind: 'failed', error: interrupted(), cpuMs: 0 };
	const say = options.console ?? ((level: string, line: string) => process.stdout.write(`[guest ${inv.id}] ${level} ${line}\n`));
	let taken = pool.take();
	pool.refill(); // off the request path: the next invocation's isolate evaluates while this one runs
	if (taken === undefined) {
		const w = await prepare(program, key, options.signal);
		if (!('isolate' in w)) {
			if (w.halted !== undefined) return { kind: 'failed', error: w.halted, cpuMs: w.cpuMs };
			const message = messageOf(w.failed);
			if (/memory limit/.test(message)) return { kind: 'failed', error: new BoltError('memory', 'guest', `the invocation used its ${LIMITS.guestMemoryMiB} MiB of guest memory`, w.failed), cpuMs: w.cpuMs };
			return { kind: 'failed', error: new BoltError('internal', 'guest', 'the guest isolate failed', w.failed), cpuMs: w.cpuMs };
		}
		pool.healthy();
		taken = w;
	}
	const { isolate, cpuStart, start, take, give } = taken;
	// the invocation's hooks; the prepared isolate's evaluation lines are this invocation's, as if it had evaluated them
	taken.bind.say = (level, line) => say(level, line, inv);
	taken.bind.random = randomStream(inv.ctx.seed);
	for (const [level, line] of taken.early) say(level, line, inv);
	let cpuMs = 0;
	const cpu = (): number => {
		if (!isolate.isDisposed) cpuMs = Number(isolate.cpuTime - cpuStart) / 1e6;
		return cpuMs;
	};
	let halted: BoltError | undefined;
	const stop = (error: BoltError): void => {
		halted ??= error;
		cpu();
		drop(isolate);
	};
	const onAbort = () => stop(interrupted()); // hook:drains
	options.signal?.addEventListener('abort', onAbort, { once: true });
	if (options.signal?.reason !== undefined) onAbort(); // aborted while it was taken
	const overCpu = () => new BoltError('cpuBudget', 'guest', `the invocation used its ${budget} ms of guest CPU`);
	const slice = async <T>(work: () => Promise<T>): Promise<T> => {
		const result = await cpuWall(cpu, budget, () => stop(overCpu()), work);
		if (halted !== undefined) throw halted;
		return result;
	};
	const failed = (code: string, message: string, cause?: unknown): GuestOutcome =>
		({ kind: 'failed', error: new BoltError(code, 'guest', message, cause), cpuMs: cpu() });

	try {
		const { seed: _seed, ...ctx } = inv.ctx;
		await slice(() => start.apply(undefined, [inv.kind, bodyPath(inv.kind, inv.target), JSON.stringify(inv.input), JSON.stringify(ctx), inv.id],
			{ arguments: { copy: true } }));

		let crossings = 0, readBytes = 0;
		const isCall = (x: CrossCall | CrossAnswer): x is CrossCall => 'op' in x;
		const wallOf = (part: readonly (CrossCall | CrossAnswer)[]): number => {
			const [only] = part;
			if (part.length !== 1 || only === undefined || !isCall(only) || only.op !== 'facility' || only.facility !== 'ai') return wallMs;
			return only.method === 'sys_2.infer' ? INFER_MS : only.method === 'transcribe' || only.method === 'speak' ? LIMITS.callMs.speech : wallMs;
		};
		// batches in flight: each drain's calls cross together, and whichever batch answers first is given back first,
		// so a body's concurrent branches (`Promise.all` over slow AI calls) proceed as each answer lands, not in lockstep
		type Landed = { batch: number; calls: Taken[1]; lowered: (CrossCall | CrossAnswer)[]; sent: readonly CrossAnswer[] };
		const outstanding = new Map<number, Promise<Landed>>();
		let batches = 0;
		for (;;) {
			const [final, calls, bins, ranTimer] = await slice(() => take.apply(undefined, [], { result: { copy: true } })) as Taken;
			if (ranTimer) continue;
			const first = calls[0];
			if (final !== null) {
				if (first !== undefined) return failed('internal', `unawaited: the body returned while a ctx call was pending at ${where(first[2])}`);
				if (outstanding.size > 0) return failed('internal', 'unawaited: the body returned while a ctx call was pending');
				switch (final[0]) {
					case 'ok':
						if (Buffer.byteLength(final[1]) > LIMITS.argsBytes) return failed('tooLarge', `the result is over ${LIMITS.argsBytes} bytes`);
						return { kind: 'ok', output: JSON.parse(final[1]) as Json, cpuMs: cpu() };
					case 'refused':
						return { kind: 'refused', message: final[1], ...(final[2] === null ? {} : { field: final[2] }), cpuMs: cpu() };
					case 'missing':
						return failed('missingBody', `guest.mjs has no ${inv.kind} body at ${final[1]}`);
					case 'error': {
						const at = final[3].split('\n').find((l) => l.includes('guest.mjs'));
						return failed('guestError', final[2], { name: final[1], message: final[2], stack: final[3], ...(at === undefined ? {} : { at: where(at) }) });
					}
				}
			}
			if (first !== undefined) {
				// every call is one crossing; a journal hit is refunded when it lands. ponytail: a batch straddling the budget
				// is refused whole, even when some of its calls would be journal hits
				if (crossings + calls.length > inv.budget.crossings) {
					const over = calls[Math.max(0, inv.budget.crossings - crossings)] ?? first;
					return failed('crossingBudget', `the invocation made more than ${inv.budget.crossings} crossings; the next was at ${where(over[2])}`);
				}
				const big = calls.find((c) => Buffer.byteLength(c[1]) > LIMITS.argsBytes);
				if (big !== undefined) return failed('tooLarge', `a ctx call's arguments are over ${LIMITS.argsBytes} bytes at ${where(big[2])}`);
				await options.events?.slice();
				crossings += calls.length;
				const lowered = calls.map(([member, json], i): CrossCall | CrossAnswer => {
					try {
						return lower(member, JSON.parse(json) as Json[], bins[i] ?? [], options.lowerRead);
					} catch (e) {
						return fail('invalidInput', messageOf(e));
					}
				});
				// a facility call (AI, web, files, http) lands on its own; reads and writes stay one ordered batch
				const alone = (x: CrossCall | CrossAnswer) => isCall(x) && x.op === 'facility';
				const groups = [...lowered.flatMap((x, i) => alone(x) ? [[i]] : []), lowered.flatMap((x, i) => alone(x) ? [] : [i])].filter((g) => g.length > 0);
				for (const g of groups) {
					const batch = batches++, part = g.map((i) => lowered[i]!);
					outstanding.set(batch, crossWithin(bridge, part.filter(isCall), wallOf(part), options.signal) // hook:drains
						.then((sent) => ({ batch, calls: g.map((i) => calls[i]!), lowered: part, sent })));
				}
			}
			// rule 12 (P38): an empty microtask queue, no call outstanding and no result is a deadlock; never retried
			if (outstanding.size === 0) return failed('stalled', 'stalled: the body awaits something no ctx call will settle');
			const landed = await Promise.race(outstanding.values());
			outstanding.delete(landed.batch);
			if (halted !== undefined) return { kind: 'failed', error: halted, cpuMs: cpu() };
			let next = 0;
			const answers = landed.lowered.map((x) => isCall(x) ? landed.sent[next++] ?? fail('badAnswer', 'no answer') : x);
			crossings -= landed.sent.filter((a) => a.journal === true).length;
			tally.crossings = crossings;
			tally.statements += landed.lowered.filter((x) => isCall(x) && STATEMENTS.has(x.op)).length;

			let bytes = 0, biggest = 0, biggestAt = 0;
			const texts = answers.map((a, i) => {
				let text: string | undefined;
				try {
					text = JSON.stringify(a.ok ? { ok: true, value: a.value } : { ok: false, error: a.error });
				} catch (e) {
					text = JSON.stringify(fail('badAnswer', messageOf(e)));
				}
				const size = Buffer.byteLength(text) + (a.ok ? a.bins ?? [] : []).reduce((n, b) => n + b.byteLength, 0);
				bytes += size;
				if (size > biggest) { biggest = size; biggestAt = i; }
				const call = landed.lowered[i];
				if (call !== undefined && isCall(call) && call.op === 'read') readBytes += size;
				if (!a.ok && call !== undefined && isCall(call) && call.op === 'facility' && a.error.kind !== 'bolt')
					options.events?.emit('warn', 'facility.failed', { facility: call.facility, method: call.method, kind: a.error.kind, message: 'message' in a.error ? a.error.message : a.error.reason });
				return text;
			});
			const at = landed.calls[0]![2];
			if (bytes > LIMITS.crossingBytes) {
				const big = landed.lowered[biggestAt]!;
				const what = !isCall(big) ? 'a refused call' : big.op === 'read' ? `ctx.${big.read.kind} of '${big.read.collection}'`
					: big.op === 'act' ? `ctx.act('${big.callable}')` : big.op === 'facility' ? `ctx.${big.facility}.${big.method}` : `ctx.${big.op}`;
				const hint = isCall(big) && big.op === 'read' ? 'page it with `limit` and the returned cursor, or `select` fewer fields' : 'return less from it';
				return failed('tooLarge', `${what} answered ${biggest} bytes (${bytes} this crossing), over the ${LIMITS.crossingBytes / 1024 / 1024} MiB crossing limit at ${where(landed.calls[biggestAt]![2])}; ${hint}`);
			}
			if (readBytes > inv.budget.readBytes) return failed('readBudgetExceeded', `the invocation read over ${inv.budget.readBytes} bytes; the last read was at ${where(at)}`);
			await slice(() => give.apply(undefined, [landed.calls.map((c) => c[3]), texts, answers.map((a) => a.ok ? [...(a.bins ?? [])] : [])], { arguments: { copy: true } }));
		}
	} catch (e) {
		if (halted !== undefined) return { kind: 'failed', error: halted, cpuMs: cpu() };
		if (/memory limit/.test(messageOf(e))) return failed('memory', `the invocation used its ${LIMITS.guestMemoryMiB} MiB of guest memory`, e);
		return failed('internal', 'the guest isolate failed', e);
	} finally {
		options.signal?.removeEventListener('abort', onAbort); // hook:drains
		cpu();
		drop(isolate); // used once: never pooled again, whatever the outcome
	}
}
