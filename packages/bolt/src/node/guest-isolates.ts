/// <reference types="node" />
// Guest isolates for same-graph hosts (`GuestIsolatesPort`): made, bounded and metered here, never by the engine. A
// program's isolates are prepared ahead (prelude and module evaluated) into a warm pool that one V8 code cache per
// program compiles; every native call is one slice under the host's CPU slot, billed to its session. Preparation is
// billed to the session that takes the isolate.
import { createHash, randomUUID } from 'node:crypto';
import ivm from 'isolated-vm';
import { Effect, Exit, FiberSet, RcMap, Result, Schema, Scope, Semaphore } from 'effect';
import {
	LIMITS,
	type GuestIsolatesPort,
	type GuestSessionOptions,
	type GuestTaken
} from '../engine/contracts.ts';
import type { GuestProgram } from '../engine/guest/runner.ts';
import type { HostFailure } from '../protocol/host-api.ts';

export type GuestIsolatesOptions = {
	/**
	 * The CPU budget: a number is each session's, preparation included (default `LIMITS.guestCpuMs`); a function answers
	 * what is left of the unit's budget when a slice starts (a kernel: its unit's 2 s). Past it the session ends `cpuBudget`.
	 */
	readonly cpuMs?: number | (() => number) | undefined;
	/** A CPU slot for one native slice; calling the answer frees it once the slice settled. */
	readonly slot?: (() => Promise<() => void>) | undefined;
	/** Every slice's isolate CPU, by session. */
	readonly meter?: ((session: string, nanos: bigint) => void) | undefined;
	/** The prepared-isolate pool, read live: idle heap ceiling, depth per program, idle eviction (fixed at creation). */
	readonly warm?:
		{ readonly maxMiB: number; readonly depth: number; readonly idleMs: number } | undefined;
	/** Makes one native isolate under its heap cap (default `new ivm.Isolate`). */
	readonly isolate?: ((memoryMiB: number) => ivm.Isolate) | undefined;
};
export type GuestIsolateCounts = {
	readonly live: number;
	readonly warm: number;
	readonly warmBytes: number;
	readonly preparing: number;
	readonly hits: number;
	readonly misses: number;
	readonly evicted: number;
	readonly failed: number;
};
export type NodeGuestIsolates = GuestIsolatesPort & {
	readonly counts: () => GuestIsolateCounts;
	/** A session's live heap (0 once it ended), for the host's memory watermark. */
	readonly heapBytes: (session: string) => number;
};

/** The prelude's `$3`: a `?bytes` import's bytes by sha256, or undefined (the guest then throws naming the sha). */
export const assetHook =
	(assets: GuestProgram['assets']) =>
	(sha: unknown): Uint8Array | undefined =>
		assets !== undefined && typeof sha === 'string' && Object.hasOwn(assets, sha)
			? assets[sha]
			: undefined;

const DIGESTS: { readonly [name: string]: string } = {
	'SHA-1': 'sha1',
	'SHA-256': 'sha256',
	'SHA-384': 'sha384',
	'SHA-512': 'sha512'
};

/** `crypto.subtle.digest`'s host half. */
export function digest(name: unknown, bytes: unknown): Uint8Array {
	// hook:check — `bolt check` installs the same prelude
	const algorithm = DIGESTS[String(name).toUpperCase()];
	if (algorithm === undefined || !(bytes instanceof Uint8Array))
		throw new Error(`digest supports ${Object.keys(DIGESTS).join(', ')}`);
	return new Uint8Array(createHash(algorithm).update(bytes).digest());
}

/** The invocation's entropy: SHA-256 blocks of its seed, so a replay with the same seed draws the same values. */
export function randomStream(seed: string): (n: unknown) => Uint8Array {
	let counter = 0;
	let pool = Buffer.alloc(0);
	return (n) => {
		if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65_536)
			throw new Error('random takes 0 to 65536 bytes');
		const blocks = [pool];
		for (let have = pool.length; have < n; have += 32)
			blocks.push(createHash('sha256').update(seed).update(String(counter++)).digest());
		pool = Buffer.concat(blocks);
		const out = new Uint8Array(pool.subarray(0, n));
		pool = pool.subarray(n);
		return out;
	};
}

const WARM = { maxMiB: 512, depth: 2, idleMs: 60_000 } as const;
/** Console lines one turn carries; the rest are counted. */
const LINES = 200;
type Fault = HostFailure | Error;
const failure = (code: 'cpuBudget' | 'memory', message: string): HostFailure => ({
	_tag: 'HostFailure',
	code,
	phase: 'guest',
	message
});
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

type Key = {
	readonly source: string;
	readonly prelude: string;
	readonly memoryMiB: number;
	readonly assets?: GuestProgram['assets'];
};
/** What a slice needs of its isolate: its CPU since creation (the last reading once disposed), and its disposal. */
type Native = { readonly cpu: () => bigint; readonly drop: () => void; readonly memoryMiB: number };
type Prepared = Native & {
	readonly isolate: ivm.Isolate;
	readonly start: ivm.Reference;
	readonly take: ivm.Reference<() => GuestTaken>;
	readonly give: ivm.Reference;
	/** `$1`, rebound to the session's seed when the isolate is taken. */
	readonly bind: { random: (n: unknown) => Uint8Array };
	/** `$0`'s lines since the last turn. */
	readonly said: { readonly lines: [string, string][]; dropped: number };
};
type Warm = Prepared & { readonly bytes: number };
type ModuleCache = {
	readonly data: ivm.ExternalCopy<ArrayBuffer>;
	readonly bytes: number;
	users: number;
	state: 'retained' | 'retired' | 'released';
};
type NativeCompilation = { readonly drop: () => void; readonly settled: Promise<void> };
type CompileModule = (isolate: ivm.Isolate, native: Native) => Effect.Effect<ivm.Module, Fault>;
type Pool = { readonly take: Effect.Effect<Prepared, Fault>; readonly refill: Effect.Effect<void> };

const CacheOutput = Schema.Struct({
	cachedData: Schema.instanceOf(ivm.ExternalCopy<unknown>)
});
const CacheRejection = Schema.Struct({ cachedDataRejected: Schema.Boolean });
const CacheBuffer = Schema.instanceOf(ArrayBuffer).check(
	Schema.makeFilter<ArrayBuffer>(
		(buffer) => buffer.byteLength > 0 || 'the native module cache is empty'
	)
);
/** Decode the native field and its payload before constructing a typed, host-owned cache handle. */
const moduleCache = (module: ivm.Module) => {
	const { cachedData } = Schema.decodeUnknownSync(CacheOutput)(module);
	const copied = Result.try({
		try: () => Schema.decodeUnknownSync(CacheBuffer)(cachedData.copy()),
		catch: (cause) => cause
	});
	cachedData.release();
	if (Result.isFailure(copied)) throw copied.failure;
	const bytes = copied.success.byteLength;
	return { data: new ivm.ExternalCopy(copied.success, { transferOut: true }), bytes };
};

/** The host's guest isolates, alive until the scope closes: every isolate is disposed with it. */
export const guestIsolates = Effect.fn('node.guestIsolates')(function* (
	options: GuestIsolatesOptions
) {
	const warm = options.warm ?? WARM,
		nanos = (ms: number) => BigInt(Math.max(0, Math.floor(ms * 1e6)));
	const active = new Set<() => void>();
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			for (const drop of active) drop();
		})
	);
	const counts = {
		live: 0,
		warm: 0,
		// Retained cache bytes stay charged while native compilers still hold their backing store.
		warmBytes: 0,
		preparing: 0,
		hits: 0,
		misses: 0,
		evicted: 0,
		failed: 0
	};
	const fault =
		(memoryMiB: number) =>
		(error: unknown): Fault =>
			/memory limit/.test(messageOf(error))
				? failure('memory', `the invocation used its ${memoryMiB} MiB of guest memory`)
				: error instanceof Error
					? error
					: new Error(messageOf(error));
	const {
		slot,
		meter,
		cpuMs = LIMITS.guestCpuMs,
		isolate: makeIsolate = (memoryLimit: number) => new ivm.Isolate({ memoryLimit })
	} = options;
	const over = failure(
		'cpuBudget',
		`the invocation used its ${typeof cpuMs === 'number' ? cpuMs : LIMITS.guestCpuMs} ms of guest CPU`
	);
	/**
	 * One native call under a CPU slot, bounded on the isolate's CPU by what is left of the budget: the watchdog disposes
	 * an isolate past it. Interruption disposes the isolate; the slot is freed only once the native call actually settled.
	 */
	const slice = <A>(native: Native, work: () => PromiseLike<A>): Effect.Effect<A, Fault> =>
		Effect.scoped(
			Effect.gen(function* () {
				if (slot !== undefined)
					yield* Effect.acquireRelease(
						Effect.suspend(() => {
							const granted = slot();
							// a slot granted after its waiter left is freed at once
							return Effect.tryPromise({ try: () => granted, catch: fault(native.memoryMiB) }).pipe(
								Effect.onInterrupt(() =>
									Effect.sync(() => {
										granted.then(
											(free) => free(),
											() => undefined
										);
									})
								)
							);
						}),
						(free) => Effect.sync(free),
						{ interruptible: true }
					);
				const limit = typeof cpuMs === 'number' ? nanos(cpuMs) : native.cpu() + nanos(cpuMs());
				let pending: Promise<A> | undefined;
				const call = Effect.tryPromise({
					try: () => (pending = Promise.resolve(work())),
					catch: fault(native.memoryMiB)
				}).pipe(
					Effect.onInterrupt(() => Effect.sync(native.drop)),
					Effect.ensuring(
						Effect.suspend(() => {
							const settled = pending;
							return settled === undefined
								? Effect.void
								: Effect.promise(() =>
										settled.then(
											() => undefined,
											() => undefined
										)
									);
						})
					)
				);
				const watchdog = Effect.gen(function* () {
					for (;;) {
						const left = limit - native.cpu();
						if (left <= 0n) {
							native.drop();
							return yield* Effect.fail(over);
						}
						yield* Effect.sleep(Math.max(1, Math.ceil(Number(left) / 1e6)));
					}
				});
				return yield* Effect.raceFirst(call, watchdog).pipe(
					Effect.tap(() => (native.cpu() >= limit ? Effect.fail(over) : Effect.void))
				);
			})
		);
	const prepare = (key: Key, compileModule: CompileModule): Effect.Effect<Prepared, Fault> =>
		Effect.gen(function* () {
			// Native snapshots contain machine code; tenant programs are evaluated only as source.
			const isolate = yield* Effect.try({
				try: () => makeIsolate(key.memoryMiB),
				catch: fault(key.memoryMiB)
			});
			const cpuStart = isolate.cpuTime;
			let measured = 0n;
			const cpu = () => (isolate.isDisposed ? measured : (measured = isolate.cpuTime - cpuStart));
			counts.live++;
			let owned = true;
			const drop = () => {
				if (!owned) return;
				owned = false;
				active.delete(drop);
				counts.live--;
				if (!isolate.isDisposed) {
					cpu();
					isolate.dispose();
				}
			};
			active.add(drop);
			const native: Native = { cpu, drop, memoryMiB: key.memoryMiB };
			const said: Prepared['said'] = { lines: [], dropped: 0 };
			const bind = {
				random: randomStream(`prepare:${createHash('sha256').update(key.source).digest('hex')}`)
			};
			return yield* Effect.gen(function* () {
				const context = yield* slice(native, () => isolate.createContext());
				const hooks = yield* slice(native, () =>
					context.evalClosure(
						key.prelude,
						[
							(level: unknown, line: unknown) => {
								if (said.lines.length < LINES) said.lines.push([String(level), String(line)]);
								else said.dropped++;
							},
							(n: unknown) => bind.random(n),
							digest,
							assetHook(key.assets)
						],
						{ filename: 'bolt:prelude', result: { reference: true } }
					)
				);
				const start = yield* slice(native, () => hooks.get('start', { reference: true }));
				const take = yield* slice(native, () => hooks.get('take', { reference: true }));
				const give = yield* slice(native, () => hooks.get('give', { reference: true }));
				if (start === undefined || take === undefined || give === undefined)
					return yield* Effect.fail(new Error('the prelude did not return its hooks'));
				const module = yield* compileModule(isolate, native);
				yield* slice(native, () =>
					module.instantiate(context, (specifier) => {
						throw new Error(`guest.mjs is one module; it imports '${specifier}'`);
					})
				);
				yield* slice(native, () => module.evaluate());
				yield* slice(native, () => context.global.set('__boltGuest', module.namespace.derefInto()));
				return { ...native, isolate, start, take, give, bind, said } satisfies Prepared;
			}).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? Effect.sync(drop) : Effect.void)));
		});
	const pools = new Set<{ evict(): boolean }>();
	const map = yield* RcMap.make({
		idleTimeToLive: warm.idleMs,
		lookup: (key: Key) =>
			Effect.gen(function* () {
				const poolScope = yield* Scope.Scope,
					// Pool cleanup drops compilers before closing or awaiting individual background jobs.
					jobScope = yield* Scope.fork(poolScope),
					jobs = yield* FiberSet.make<void, never>(),
					cacheGate = yield* Semaphore.make(1),
					ready: Warm[] = [];
				const compiling = new Set<NativeCompilation>();
				let pending = 0,
					open = true,
					broken = false;
				let cache: ModuleCache | undefined;
				const caching = () => warm.depth > 0 && warm.maxMiB > 0;
				const retireCache = (entry: ModuleCache) => {
					if (cache === entry) cache = undefined;
					if (entry.state === 'released') return;
					entry.state = 'retired';
					if (entry.users !== 0) return;
					entry.data.release();
					entry.state = 'released';
					counts.warmBytes -= entry.bytes;
				};
				const evict = () => {
					const item = ready.shift();
					if (item === undefined) {
						if (cache === undefined || cache.users !== 0) return false;
						retireCache(cache);
						return true;
					}
					counts.warm--;
					counts.warmBytes -= item.bytes;
					counts.evicted++;
					item.drop();
					return true;
				};
				const pool = { evict };
				const underLimit = () => {
					for (const other of pools) {
						while (counts.warmBytes > warm.maxMiB * 2 ** 20 && other.evict()) {}
					}
				};
				/** The compile is one slice; the cache handles it pins are owned through native settlement. */
				const compileNative: CompileModule = (isolate, native) =>
					Effect.suspend(() => {
						if (!open || poolScope.state._tag === 'Closed') return Effect.interrupt;
						return slice(native, () => {
							if (!caching() && cache !== undefined) retireCache(cache);
							const used = caching() ? cache : undefined;
							const produce = caching() && used === undefined;
							if (used !== undefined) used.users++;
							const unpin = () => {
								if (used !== undefined) {
									used.users--;
									if (used.state === 'retired') retireCache(used);
								}
								underLimit();
							};
							const started = Result.try({
								try: () =>
									isolate.compileModule(key.source, {
										filename: 'guest.mjs',
										...(used === undefined
											? produce
												? { produceCachedData: true }
												: {}
											: { cachedData: used.data })
									}),
								catch: (cause) => cause
							});
							if (Result.isFailure(started)) {
								unpin();
								return Promise.reject(started.failure);
							}
							const result = started.success.then((module) => {
								if (
									used !== undefined &&
									Schema.decodeUnknownSync(CacheRejection)(module).cachedDataRejected
								)
									retireCache(used);
								if (produce) {
									const produced = moduleCache(module);
									if (
										!open ||
										poolScope.state._tag === 'Closed' ||
										!caching() ||
										cache !== undefined ||
										produced.bytes > warm.maxMiB * 2 ** 20
									) {
										produced.data.release();
									} else {
										cache = { ...produced, users: 0, state: 'retained' };
										counts.warmBytes += produced.bytes;
										pools.delete(pool);
										pools.add(pool);
										underLimit();
									}
								}
								return module;
							});
							const finish = () => {
								unpin();
								compiling.delete(compilation);
							};
							const compilation: NativeCompilation = {
								drop: native.drop,
								settled: result.then(finish, finish)
							};
							compiling.add(compilation);
							return compilation.settled.then(() => result);
						});
					});
				const compileModule: CompileModule = (isolate, native) =>
					Effect.suspend(() =>
						!caching() || cache !== undefined
							? compileNative(isolate, native)
							: cacheGate.withPermit(compileNative(isolate, native))
					);
				yield* Effect.addFinalizer(() =>
					Effect.gen(function* () {
						open = false;
						const pendingCompiles = Array.from(compiling);
						for (const compilation of pendingCompiles) compilation.drop();
						while (evict()) {}
						yield* Effect.forEach(
							pendingCompiles,
							(compilation) => Effect.promise(() => compilation.settled),
							{ concurrency: 'unbounded', discard: true }
						);
						while (evict()) {}
						pools.delete(pool);
					})
				);
				const refill = Effect.gen(function* () {
					while (open && !broken && ready.length + pending < warm.depth) {
						pending++;
						counts.preparing++;
						const job = Effect.scoped(
							Effect.gen(function* () {
								let transferred = false;
								const item = yield* Effect.acquireRelease(
									prepare(key, compileModule),
									(item) =>
										Effect.sync(() => {
											if (!transferred) item.drop();
										}),
									{ interruptible: true }
								);
								// Only retained isolates need a heap measurement for the warm-pool memory cap.
								const heap = yield* slice(item, () => item.isolate.getHeapStatistics());
								if (!open || ready.length >= warm.depth) return;
								const bytes = heap.total_heap_size + heap.externally_allocated_size;
								ready.push({ ...item, bytes });
								transferred = true;
								counts.warm++;
								counts.warmBytes += bytes;
								pools.delete(pool);
								pools.add(pool);
								underLimit();
							})
						).pipe(
							Effect.tapError(() =>
								Effect.sync(() => {
									broken = true;
									counts.failed++;
								})
							),
							Effect.tapCause(Effect.logWarning),
							Effect.ignore,
							Effect.ensuring(
								Effect.sync(() => {
									pending--;
									counts.preparing--;
								})
							)
						);
						const fiber = yield* Effect.forkIn(job, jobScope, { startImmediately: false });
						yield* FiberSet.add(jobs, fiber);
					}
				});
				return {
					refill,
					take: Effect.gen(function* () {
						const item = ready.pop();
						pools.delete(pool);
						pools.add(pool);
						if (item !== undefined) {
							counts.hits++;
							counts.warm--;
							counts.warmBytes -= item.bytes;
							return item;
						}
						counts.misses++;
						const fresh = yield* prepare(key, compileModule);
						broken = false;
						return fresh;
					})
				} satisfies Pool;
			})
	});
	const sessions = new Map<string, { readonly item: Prepared; readonly scope: Scope.Closeable }>();
	const end = (id: string) =>
		Effect.suspend(() => {
			const session = sessions.get(id);
			if (session === undefined) return Effect.void;
			sessions.delete(id);
			session.item.drop();
			return Scope.close(session.scope, Exit.void);
		});
	const open = (program: GuestProgram, session: GuestSessionOptions) =>
		Effect.gen(function* () {
			const scope = yield* Scope.make();
			const id = randomUUID();
			return yield* Effect.gen(function* () {
				// RcMap hashes every key property; ignored tenant fields must never enter that key.
				const pool = yield* RcMap.get(map, {
					source: program.source,
					prelude: session.prelude,
					memoryMiB: session.memoryMiB,
					...(program.assets === undefined ? {} : { assets: program.assets })
				}).pipe(Scope.provide(scope));
				const refill = session.once === true ? Effect.void : pool.refill;
				const item = yield* pool.take.pipe(Effect.tapError(() => refill));
				sessions.set(id, { item, scope });
				item.bind.random = randomStream(session.seed);
				meter?.(id, item.cpu());
				// Refill the borrowed slot while its session runs, rather than waiting for another one.
				yield* refill;
				return id;
			}).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit)
						? Effect.andThen(end(id), Scope.close(scope, Exit.void))
						: Effect.void
				)
			);
		});
	/** One turn: the slice, then what `$0` said since the last turn; a failed turn ends its session. */
	const turn = (id: string, work: (item: Prepared) => () => PromiseLike<GuestTaken>) =>
		Effect.gen(function* () {
			const session = sessions.get(id);
			if (session === undefined)
				return yield* Effect.fail(new Error('the guest session is closed'));
			const item = session.item,
				before = item.cpu();
			const taken = yield* slice(item, work(item)).pipe(
				Effect.ensuring(Effect.sync(() => meter?.(id, item.cpu() - before)))
			);
			const lines = item.said.lines.splice(0),
				dropped = item.said.dropped;
			item.said.dropped = 0;
			return { taken, lines, dropped };
		}).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? end(id) : Effect.void)));
	const take = (item: Prepared) => item.take.apply(undefined, [], { result: { copy: true } });
	const run = yield* FiberSet.makeRuntimePromise();
	return {
		counts: () => ({ ...counts }),
		heapBytes: (id) => {
			const isolate = sessions.get(id)?.item.isolate;
			if (isolate === undefined || isolate.isDisposed) return 0;
			const heap = isolate.getHeapStatisticsSync();
			return heap.total_heap_size + heap.externally_allocated_size;
		},
		open: (program, session, signal) => run(open(program, session), { signal }),
		start: (id, start, signal) =>
			run(
				turn(
					id,
					(item) => () =>
						item.start
							.apply(
								undefined,
								[start.kind, [...start.path], start.input, start.ctx, start.invocation],
								{ arguments: { copy: true } }
							)
							.then(() => take(item))
				),
				{ signal }
			),
		take: (id, signal) =>
			run(
				turn(id, (item) => () => take(item)),
				{ signal }
			),
		give: (id, answers, signal) =>
			run(
				turn(
					id,
					(item) => () =>
						item.give
							.apply(
								undefined,
								[[...answers.ids], [...answers.texts], answers.bins.map((bins) => [...bins])],
								{ arguments: { copy: true } }
							)
							.then(() => take(item))
				),
				{ signal }
			),
		close: (id) => run(end(id))
	} satisfies NodeGuestIsolates;
});
