/// <reference types="node" />
// One generation owns every prepared and running isolate. Native ivm calls are the sole Promise ABI edge.
import { createHash } from 'node:crypto';
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import ivm from 'isolated-vm';
import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Queue,
	RcMap,
	Ref,
	Result,
	Schema,
	Scope,
	Semaphore
} from 'effect';
import type { Json } from '../../decl/values.ts';
import type { CrossAnswer, GuestOutcome, Invocation, InvocationKind } from '../contracts.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError, type Code } from '../../protocol/errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { parseCallable } from '../callables/index.ts';
import { lowerRead as workspaceRead } from '../query/engine.ts';
import { lowerKeyedMember } from '../query/keyed.ts';
import type { ReadIR } from '../../protocol/ir-types.ts';
import {
	Activation,
	Guest,
	GuestLimits,
	Isolates,
	Manifest,
	Telemetry,
	type Bridge,
	type CrossCall,
	type GuestLimitsShape,
	type InvocationEvents
} from '../services.ts';
import { inferMs } from '../agent/ai.ts';
import { PRELUDE } from './prelude.ts';
import { RequestCpu, ensureRequestCpu, withRequestCpu, type CpuSource } from './request-cpu.ts';

type Tally = { crossings: number; statements: number };
export type GuestProgram = {
	source: string;
	sourceMap?: string;
	assets?: Readonly<Record<string, Uint8Array>>;
};
export type GuestOptions = {
	readonly lowerRead?: ((member: string, args: readonly Json[]) => ReadIR) | undefined;
	readonly console?: ((level: string, line: string, invocation: Invocation) => void) | undefined;
	readonly callWallMs?: number | undefined;
	readonly cpu?: ((invocation: Invocation, cpuMs: number, counts: Tally) => void) | undefined;
	/** CPU capacity belongs only to native execution; host crossings run without this lease. */
	readonly compute?: Effect.Effect<void, BoltError, Scope.Scope> | undefined;
	/** Background jobs reserve job capacity; foreground preparation uses its invocation's job grant. */
	readonly warmPreparation?: Effect.Effect<void, BoltError, Scope.Scope> | undefined;
};
export const GuestConfig = Context.Reference<GuestOptions>('bolt/GuestConfig', {
	defaultValue: () => ({})
});
const STATEMENTS = new Set(['read', 'act', 'acts', 'schedule', 'notify', 'send']);
const PAGE_READS = new Set(['read', 'get', 'aggregate', 'similar', 'history', 'query']);
const fault = (error: unknown) =>
	error instanceof BoltError
		? error
		: BoltError.make(
				/memory limit/.test(messageOf(error)) ? 'memory' : 'internal',
				'guest',
				/memory limit/.test(messageOf(error))
					? `the invocation used its ${LIMITS.guestMemoryMiB} MiB of guest memory`
					: 'the guest isolate failed',
				error
			);
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const native = <A>(work: () => PromiseLike<A>) => Effect.tryPromise({ try: work, catch: fault });
const computeEffect = <A, E, R>(
	work: Effect.Effect<A, E, R>,
	source: CpuSource,
	options: GuestOptions
) =>
	ensureRequestCpu(
		Effect.flatMap(RequestCpu, (cpu) => cpu.run(work, source, options.compute ?? Effect.void))
	);
/** Interruption disposes the isolate and awaits native settlement before the CPU lease is refunded. */
const computeNative = <A>(work: () => PromiseLike<A>, source: CpuSource, options: GuestOptions) =>
	computeEffect(
		Effect.suspend(() => {
			let pending: Promise<A> | undefined;
			return native(() => {
				pending = Promise.resolve(work());
				return pending;
			}).pipe(
				Effect.onInterrupt(() => Effect.sync(source.drop)),
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
		}),
		source,
		options
	);
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
const fail = (code: string, message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code, message }
});
const object = (value: Json | undefined): { readonly [key: string]: Json } =>
	Predicate.isObject(value) ? Object.fromEntries(Object.entries<Json>(value)) : {};
const Observed = Schema.Record(
	Schema.String,
	Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
);
const Options = Schema.Struct({
	key: Schema.optionalKey(Schema.String),
	once: Schema.optionalKey(Schema.String),
	observed: Schema.optionalKey(Observed),
	onConflict: Schema.optionalKey(Schema.Literals(['update', 'keep']))
});
const argsOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)));
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((error) => BoltError.make('invalidInput', 'guest', error.message))
	);
const callable = (name: string, manifest: EngineManifest) => {
	const result = parseCallable(name, manifest);
	return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure);
};
const Facilities = [
	'web.read',
	'files.meta',
	'files.get',
	'files.url',
	'files.text',
	'files.table',
	'files.sheet',
	'files.image',
	'files.put',
	'convert.document',
	'ai.sys_1.decide',
	'ai.sys_2.infer',
	'ai.embed',
	'ai.transcribe',
	'ai.speak',
	'geo.search',
	'geo.reverse'
] as const;
const facility = Schema.Literals(Facilities);
const lower = (
	member: string,
	args: readonly Json[],
	bins: readonly Uint8Array[],
	read: NonNullable<GuestOptions['lowerRead']>,
	manifest: EngineManifest
): Effect.Effect<CrossCall, BoltError> =>
	Effect.gen(function* () {
		if (member === 'db.prepareCreate') {
			const [collection, values, options] = yield* decode(
				Schema.Tuple([
					Schema.String,
					Schema.Json,
					Schema.Struct({ path: Schema.Array(Schema.Union([Schema.String, Schema.Number])) })
				]),
				args
			);
			return { _tag: 'prepareCreate', collection, values, path: options.path };
		}
		const head = member.split('.')[0];
		if (
			head === 'read' ||
			head === 'get' ||
			head === 'aggregate' ||
			head === 'similar' ||
			head === 'history' ||
			head === 'query' ||
			head === 'db'
		)
			return {
				_tag: 'read',
				read: yield* Effect.try({
					try: () => read(member, args),
					catch: (error) => BoltError.make('invalidInput', 'guest', messageOf(error))
				}),
				params: {}
			};
		switch (member) {
			case 'act': {
				const name = yield* decode(Schema.String, args[0]);
				const options = yield* decode(Options, args[2] ?? {});
				return {
					_tag: 'act',
					callable: yield* callable(name, manifest),
					input: args[1] ?? null,
					...(Object.keys(options).length === 0 ? {} : { options })
				};
			}
			case 'acts': {
				const acts = yield* decode(
					Schema.Array(Schema.Struct({ callable: Schema.String, input: Schema.Json })),
					args[0]
				);
				return {
					_tag: 'acts',
					acts: yield* Effect.forEach(acts, (act) =>
						Effect.map(callable(act.callable, manifest), (name) => ({
							callable: name,
							input: act.input
						}))
					)
				};
			}
			case 'schedule': {
				const automation = yield* decode(Schema.String, args[0]);
				const options = yield* decode(
					Schema.Struct({
						at: Schema.optionalKey(
							Schema.Union([Schema.String, Schema.Struct({ now: Schema.String })])
						),
						key: Schema.optionalKey(Schema.String)
					}),
					args[2] ?? {}
				);
				return { _tag: 'schedule', automation, input: args[1] ?? null, ...options };
			}
			case 'request':
				return {
					_tag: 'request',
					to: args.length >= 2 ? yield* decode(Schema.String, args[0]) : null,
					operation: args.length >= 2 ? (args[1] ?? null) : (args[0] ?? null)
				};
			case 'notify':
				return { _tag: 'notify', notices: args[0] ?? null };
			case 'send':
				return {
					_tag: 'send',
					to: yield* decode(Schema.String, args[0]),
					message: args[1] ?? null
				};
			case 'progress':
				return { _tag: 'progress', progress: args[0] ?? null };
			default:
				return {
					_tag: yield* decode(facility, member),
					args,
					...(bins.length === 0 ? {} : { bins })
				};
		}
	});

type Keyed = { readonly keyed: readonly (readonly [string, CrossCall | CrossAnswer])[] };
const lowerKeyed = (
	member: string,
	set: Json,
	read: NonNullable<GuestOptions['lowerRead']>,
	scope: number
) =>
	Effect.gen(function* () {
		const records = yield* decode(
			Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)),
			set
		);
		const earlier = new Set<string>();
		const keyed: (readonly [string, CrossCall | CrossAnswer])[] = [];
		for (const [key, spec] of Object.entries(records)) {
			const lowered = Effect.try({
				try: (): CrossCall => {
					const ir = lowerKeyedMember(member, key, spec, read, scope, earlier);
					earlier.add(key);
					return { _tag: 'read', read: ir, params: {} };
				},
				catch: (error) => BoltError.make('invalidInput', 'guest', messageOf(error))
			}).pipe(Effect.catch((error) => Effect.succeed(fail('invalidInput', error.message))));
			keyed.push([key, yield* lowered]);
		}
		return { keyed } satisfies Keyed;
	});
/** Where a body lives in the guest's default export. `pipeline`, `integration` and `tool` targets are that path, dotted. */
function bodyPath(kind: InvocationKind, target: string): string[] {
	const dot = target.indexOf('.');
	const collection = target.slice(0, dot),
		member = target.slice(dot + 1);
	switch (kind) {
		case 'notification':
			return ['collection', collection, 'spec', 'notifications', ...member.split('.'), 'to'];
		case 'projection':
			return ['collection', target, 'bodies', 'project'];
		case 'transform':
			return ['collection', target, 'bodies', 'transform'];
		case 'query':
			return ['collection', collection, 'bodies', 'queries', member];
		case 'action':
			return ['collection', collection, 'bodies', 'actions', member];
		case 'similarity':
			return ['collection', collection, 'bodies', 'similarity', member, 'probe'];
		case 'rerank':
			return ['collection', collection, 'bodies', 'similarity', member, 'rerank']; // hook:reads
		case 'automation':
			return ['automation', target, 'body'];
		case 'page':
			return ['page', target, 'body'];
		case 'validation':
			return ['custom_field', target, 'check'];
		default:
			return target.split('.');
	}
}

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

const Final = Schema.Union([
	Schema.Tuple([Schema.Literal('ok'), Schema.String]),
	Schema.Tuple([Schema.Literal('refused'), Schema.String, Schema.NullOr(Schema.String)]),
	Schema.Tuple([Schema.Literal('missing'), Schema.String]),
	Schema.Tuple([Schema.Literal('error'), Schema.String, Schema.String, Schema.String]),
	Schema.Tuple([
		Schema.Literal('error'),
		Schema.String,
		Schema.String,
		Schema.String,
		Schema.String
	])
]);
const Taken = Schema.Tuple([
	Schema.NullOr(Final),
	Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String, Schema.Number])),
	Schema.Array(Schema.Array(Schema.Uint8Array)),
	Schema.Boolean
]);
type Taken = typeof Taken.Type;
type Prepared = {
	readonly isolate: ivm.Isolate;
	readonly context: ivm.Context;
	readonly start: ivm.Reference;
	readonly take: ivm.Reference;
	readonly give: ivm.Reference;
	readonly cpu: () => number;
	readonly bind: { say(level: string, line: string): void; random(n: unknown): Uint8Array };
	readonly early: [string, string][];
	readonly drop: () => void;
};
type Warm = Prepared & { readonly bytes: number };
type ModuleCache = {
	readonly data: ivm.ExternalCopy<ArrayBuffer>;
	readonly bytes: number;
	users: number;
	state: 'retained' | 'retired' | 'released';
};
type NativeCompilation = {
	readonly drop: () => void;
	readonly settled: Promise<void>;
};
type CompileModule = (
	isolate: ivm.Isolate,
	drop: () => void,
	cpu: () => number
) => Effect.Effect<ivm.Module, BoltError>;
type Pool = {
	readonly take: Effect.Effect<Prepared, BoltError, Scope.Scope>;
	readonly refill: Effect.Effect<void>;
};
export class PreparedIsolates extends Context.Service<
	PreparedIsolates,
	{ readonly pool: (program: GuestProgram) => Effect.Effect<Pool, BoltError, Scope.Scope> }
>()('bolt/PreparedIsolates') {}

export const IsolatesLive = Layer.effectContext(
	Effect.gen(function* () {
		const limits = yield* GuestLimits;
		const options = yield* GuestConfig;
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
		const pools = new Set<{ evict(): boolean }>();
		const prepare = (
			program: GuestProgram,
			compileModule: CompileModule
		): Effect.Effect<Prepared, BoltError, Scope.Scope> =>
			Effect.gen(function* () {
				// Native snapshots contain machine code; tenant programs are evaluated only as source.
				const isolate = yield* Effect.try({
					try: () => new ivm.Isolate({ memoryLimit: limits.memoryMiB }),
					catch: fault
				});
				const cpuStart = isolate.cpuTime;
				let measuredCpu = 0;
				const cpu = () =>
					isolate.isDisposed
						? measuredCpu
						: (measuredCpu = Number(isolate.cpuTime - cpuStart) / 1e6);
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
				yield* Effect.addFinalizer(() => Effect.sync(drop));
				const source: CpuSource = { cpu, drop, budget: limits.cpuMs };
				const nativeCall = <A>(work: () => PromiseLike<A>) => computeNative(work, source, options);
				const early: [string, string][] = [],
					key = createHash('sha256').update(program.source).digest('hex');
				const bind = {
					say: (level: string, line: string) => {
						if (early.length < 200) early.push([level, line]);
					},
					random: randomStream(`prepare:${key}`)
				};
				return yield* Effect.gen(function* () {
					const context = yield* nativeCall(() => isolate.createContext());
					const hooks = yield* nativeCall(() =>
						context.evalClosure(
							PRELUDE,
							[
								(level: unknown, line: unknown) => bind.say(String(level), String(line)),
								(n: unknown) => bind.random(n),
								digest,
								assetHook(program.assets)
							],
							{ filename: 'bolt:prelude', result: { reference: true } }
						)
					);
					const [start, take, give] = yield* Effect.all(
						(['start', 'take', 'give'] as const).map((name) =>
							nativeCall(() => hooks.get(name, { reference: true }))
						),
						{ concurrency: 'unbounded' }
					);
					if (start === undefined || take === undefined || give === undefined)
						return yield* Effect.fail(
							BoltError.make('internal', 'guest', 'the prelude did not return its hooks')
						);
					const module = yield* compileModule(isolate, drop, cpu);
					yield* nativeCall(() =>
						module.instantiate(context, (specifier) => {
							throw new Error(`guest.mjs is one module; it imports '${specifier}'`);
						})
					);
					yield* nativeCall(() => module.evaluate());
					yield* nativeCall(() => context.global.set('__boltGuest', module.namespace.derefInto()));
					return {
						isolate,
						context,
						start,
						take,
						give,
						cpu,
						bind,
						early,
						drop
					};
				}).pipe(
					Effect.onInterrupt(() => Effect.sync(drop)),
					Effect.tapError(() => Effect.sync(drop))
				);
			});
		const map = yield* RcMap.make({
			idleTimeToLive: limits.warm.idleMs,
			lookup: (program: GuestProgram) =>
				Effect.gen(function* () {
					const poolScope = yield* Scope.Scope,
						// Pool cleanup drops compilers before closing or awaiting individual background jobs.
						jobScope = yield* Scope.fork(poolScope),
						jobs = yield* FiberSet.make<void, never>(),
						cacheGate = yield* Semaphore.make(1),
						ready: Warm[] = [];
					const source = program.source;
					const compiling = new Set<NativeCompilation>();
					let pending = 0,
						open = true,
						broken = false;
					let cache: ModuleCache | undefined;
					const caching = () => limits.warm.depth > 0 && limits.warm.maxMiB > 0;
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
							while (counts.warmBytes > limits.warm.maxMiB * 2 ** 20 && other.evict()) {}
						}
					};
					const compileNative: CompileModule = (isolate, drop, cpu) =>
						computeEffect(
							Effect.suspend(() => {
								if (!open || poolScope.state._tag === 'Closed') return Effect.interrupt;
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
										isolate.compileModule(source, {
											filename: 'guest.mjs',
											...(used === undefined
												? produce
													? { produceCachedData: true }
													: {}
												: { cachedData: used.data })
										}),
									catch: fault
								});
								if (Result.isFailure(started)) {
									unpin();
									return Effect.fail(started.failure);
								}
								// This native Promise edge owns cache handles through actual native settlement, even after interruption.
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
											produced.bytes > limits.warm.maxMiB * 2 ** 20
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
									drop,
									settled: result.then(finish, finish)
								};
								compiling.add(compilation);
								return native(() => compilation.settled.then(() => result)).pipe(
									Effect.onInterrupt(() =>
										Effect.sync(drop).pipe(
											Effect.andThen(Effect.promise(() => compilation.settled))
										)
									)
								);
							}),
							{ cpu, drop, budget: limits.cpuMs },
							options
						);
					const compileModule: CompileModule = (isolate, drop, cpu) =>
						Effect.suspend(() =>
							!caching() || cache !== undefined
								? compileNative(isolate, drop, cpu)
								: cacheGate.withPermit(compileNative(isolate, drop, cpu))
						);
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							open = false;
							const pendingCompiles = Array.from(compiling);
							for (const compilation of pendingCompiles) compilation.drop();
							while (evict()) {}
							yield* Effect.promise(() =>
								Promise.all(pendingCompiles.map((compilation) => compilation.settled))
							);
							while (evict()) {}
							pools.delete(pool);
						})
					);
					const refill = Effect.gen(function* () {
						while (open && !broken && ready.length + pending < limits.warm.depth) {
							pending++;
							counts.preparing++;
							const job = Effect.scoped(
								Effect.gen(function* () {
									yield* options.warmPreparation ?? Effect.void;
									const item = yield* prepare(program, compileModule).pipe(Scope.provide(jobScope));
									// Only retained isolates need a heap measurement for the warm-pool memory cap.
									const heap = yield* computeNative(
										() => item.isolate.getHeapStatistics(),
										{ cpu: item.cpu, drop: item.drop, budget: limits.cpuMs },
										options
									).pipe(
										Effect.onInterrupt(() => Effect.sync(item.drop)),
										Effect.tapError(() => Effect.sync(item.drop))
									);
									return {
										...item,
										bytes: heap.total_heap_size + heap.externally_allocated_size
									};
								})
							).pipe(
								withRequestCpu,
								Effect.tap((item) =>
									Effect.sync(() => {
										if (!open || ready.length >= limits.warm.depth) {
											item.drop();
											return;
										}
										ready.push(item);
										counts.warm++;
										counts.warmBytes += item.bytes;
										pools.delete(pool);
										pools.add(pool);
										underLimit();
									})
								),
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
							const fresh = yield* prepare(program, compileModule);
							broken = false;
							return fresh;
						})
					} satisfies Pool;
				})
		});
		const prepared = {
			pool: ({ source, sourceMap, assets }: GuestProgram) =>
				// RcMap hashes every key property; ignored tenant fields must never enter that key.
				RcMap.get(map, {
					source,
					...(sourceMap === undefined ? {} : { sourceMap }),
					...(assets === undefined ? {} : { assets })
				})
		};
		const isolates: Isolates['Service'] = {
			counts: Effect.sync(() => ({ ...counts })),
			prepare: (program) => Effect.flatMap(prepared.pool(program), (pool) => pool.refill)
		};
		return Context.make(Isolates, isolates).pipe(Context.add(PreparedIsolates, prepared));
	})
);

/** Stored console output per invocation (lines, characters) and per line (characters). */
const CONSOLE = { lines: 200, bytes: 64 * 1024, lineChars: 2048 } as const;
const stackLocation = (program: GuestProgram) => {
	const map = program.sourceMap === undefined ? undefined : new TraceMap(program.sourceMap);
	return (frame: string): string => {
		const match = /([^\s()]+):(\d+):(\d+)\)?$/.exec(frame);
		if (match === null) return frame;
		const [, file = '', line = '0', column = '1'] = match;
		if (map !== undefined && file === 'guest.mjs') {
			const at = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
			if (at.source !== null) return `${at.source}:${at.line}`;
		}
		return `${file}:${line}`;
	};
};
const isCall = (value: CrossCall | CrossAnswer | Keyed): value is CrossCall => '_tag' in value;
const isKeyed = (value: CrossCall | CrossAnswer | Keyed): value is Keyed => 'keyed' in value;
const isFacility = (call: CrossCall) => Facilities.some((member) => member === call._tag);
type Landed = {
	readonly calls: Taken[1];
	readonly lowered: readonly (CrossCall | CrossAnswer | Keyed)[];
	readonly sent: readonly CrossAnswer[];
};
const run = (
	pool: Pool,
	program: GuestProgram,
	manifest: EngineManifest,
	options: GuestOptions,
	limits: GuestLimitsShape,
	events: InvocationEvents,
	invocation: Invocation,
	bridge: Bridge,
	tally: Tally
) =>
	Effect.gen(function* () {
		const warm = yield* pool.take.pipe(Effect.tapError(() => pool.refill));
		yield* Effect.addFinalizer(() => Effect.sync(warm.drop));
		// Refill the borrowed slot while its invocation runs, rather than waiting for another request.
		yield* pool.refill;
		const where = stackLocation(program),
			wallMs = Math.min(options.callWallMs ?? LIMITS.callMs.database, LIMITS.callMs.database);
		const read = options.lowerRead ?? ((member, args) => workspaceRead(manifest, member, args));
		const lines: [string, string][] = [];
		const say = (level: string, line: string) => {
			lines.push([level, line]);
			options.console?.(level, line, invocation);
		};
		warm.bind.say = say;
		warm.bind.random = randomStream(invocation.ctx.seed);
		for (const [level, line] of warm.early) say(level, line);
		// tenant console lines join the invocation's sys_event buffer (batched with its other events), bounded per
		// invocation and per line; a line past the bound still reaches stdout
		const kept = { lines: 0, bytes: 0, dropped: false };
		const tag =
			invocation.kind === 'automation'
				? { automation: invocation.target }
				: { callable: invocation.target, kind: invocation.kind };
		const flushLines = Effect.gen(function* () {
			while (lines.length > 0) {
				const next = lines.shift();
				if (next === undefined) break;
				const [level, raw] = next;
				const line =
					raw.length > CONSOLE.lineChars ? `${raw.slice(0, CONSOLE.lineChars)}… [clipped]` : raw;
				if (
					!kept.dropped &&
					kept.lines < CONSOLE.lines &&
					kept.bytes + line.length <= CONSOLE.bytes
				) {
					kept.lines++;
					kept.bytes += line.length;
					yield* events.emit(
						level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
						'console',
						{ ...tag, level, line }
					);
				} else {
					if (!kept.dropped)
						yield* events.emit('warn', 'console.dropped', {
							...tag,
							note: `further console lines are not stored (over ${CONSOLE.lines} lines or ${CONSOLE.bytes} characters)`
						});
					kept.dropped = true;
					if (options.console === undefined)
						yield* Effect.logInfo(`[guest ${invocation.id}] ${level} ${raw}`);
				}
			}
		});
		const cpu = warm.cpu;
		const slice = <A>(work: () => PromiseLike<A>) =>
			computeNative(work, { cpu, drop: warm.drop, budget: invocation.budget.cpuMs }, options).pipe(
				Effect.ensuring(flushLines)
			);
		const failed = (code: Code, message: string, cause?: unknown): GuestOutcome => ({
			kind: 'failed',
			error: BoltError.make(code, 'guest', message, cause),
			cpuMs: cpu()
		});
		const landed = yield* Queue.unbounded<Landed>();
		let pending = 0,
			crossings = 0,
			readBytes = 0;
		const { seed: _seed, ...ctx } = invocation.ctx;
		return yield* Effect.gen(function* () {
			yield* slice(() =>
				warm.start.apply(
					undefined,
					[
						invocation.kind,
						bodyPath(invocation.kind, invocation.target),
						JSON.stringify(invocation.input),
						JSON.stringify(ctx),
						invocation.id
					],
					{ arguments: { copy: true } }
				)
			);
			for (;;) {
				const raw = yield* slice(() => warm.take.apply(undefined, [], { result: { copy: true } }));
				const [final, calls, bins, ranTimer] = yield* decode(Taken, raw);
				if (ranTimer) continue;
				const first = calls[0];
				if (final !== null) {
					if (first !== undefined)
						return failed(
							'internal',
							`unawaited: the body returned while a ctx call was pending at ${where(first[2])}`
						);
					if (pending > 0)
						return failed('internal', 'unawaited: the body returned while a ctx call was pending');
					switch (final[0]) {
						case 'ok':
							if (Buffer.byteLength(final[1]) > limits.argsBytes)
								return failed('tooLarge', `the result is over ${limits.argsBytes} bytes`);
							return {
								kind: 'ok',
								output: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
									final[1]
								).pipe(Effect.mapError(fault)),
								cpuMs: cpu()
							} satisfies GuestOutcome;
						case 'refused':
							return {
								kind: 'refused',
								message: final[1],
								...(final[2] === null ? {} : { field: final[2] }),
								cpuMs: cpu()
							} satisfies GuestOutcome;
						case 'missing':
							return failed(
								'missingBody',
								`guest.mjs has no ${invocation.kind} body at ${final[1]}`
							);
						case 'error': {
							const at = final[3].split('\n').find((line) => line.includes('guest.mjs'));
							return failed('guestError', final[2], {
								name: final[1],
								message: final[2],
								stack: final[3],
								...(final.length === 5 ? { kind: final[4] } : {}),
								...(at === undefined ? {} : { at: where(at) })
							});
						}
					}
				}
				if (first !== undefined) {
					if (invocation.kind === 'page') {
						const forbidden = calls.find(([member]) => !PAGE_READS.has(member));
						if (forbidden !== undefined)
							return failed('forbidden', `page rendering cannot call '${forbidden[0]}'`);
					}
					if (crossings + calls.length > invocation.budget.crossings) {
						const over = calls[Math.max(0, invocation.budget.crossings - crossings)] ?? first;
						return failed(
							'crossingBudget',
							`the invocation made more than ${invocation.budget.crossings} crossings; the next was at ${where(over[2])}`
						);
					}
					const big = calls.find((call) => Buffer.byteLength(call[1]) > limits.argsBytes);
					if (big !== undefined)
						return failed(
							'tooLarge',
							`a ctx call's arguments are over ${limits.argsBytes} bytes at ${where(big[2])}`
						);
					yield* events.slice ?? Effect.void;
					crossings += calls.length;
					const lowered = yield* Effect.forEach(calls, ([member, json, , id], i) =>
						Effect.gen(function* () {
							const args = yield* argsOf(json).pipe(
								Effect.mapError((error) => BoltError.make('invalidInput', 'guest', error.message))
							);
							if (
								(member === 'read' || member === 'db.read') &&
								args.length === 1 &&
								args[0] !== undefined &&
								args[0] !== null &&
								typeof args[0] === 'object' &&
								!Array.isArray(args[0])
							)
								return yield* lowerKeyed(member, args[0], read, id);
							return yield* lower(member, args, bins[i] ?? [], read, manifest);
						}).pipe(Effect.catch((error) => Effect.succeed(fail('invalidInput', error.message))))
					);
					const alone = (value: CrossCall | CrossAnswer | Keyed) =>
						isCall(value) && (isFacility(value) || value._tag === 'request');
					const groups = [
						...lowered.flatMap((value, i) => (alone(value) ? [[i]] : [])),
						lowered.flatMap((value, i) => (alone(value) ? [] : [i]))
					].filter((group) => group.length > 0);
					for (const group of groups) {
						const part = group.flatMap((i) => (lowered[i] === undefined ? [] : [lowered[i]]));
						const sending = part.flatMap((value) =>
							isKeyed(value)
								? value.keyed.flatMap(([, call]) => (isCall(call) ? [call] : []))
								: isCall(value)
									? [value]
									: []
						);
						const only = part.length === 1 ? part[0] : undefined;
						const duration =
							only !== undefined && isCall(only) && only._tag === 'ai.sys_2.infer'
								? inferMs(only.args)
								: only !== undefined &&
									  isCall(only) &&
									  (only._tag === 'ai.transcribe' || only._tag === 'ai.speak')
									? LIMITS.callMs.speech
									: wallMs;
						pending++;
						const hostAnswers = (
							sending.length === 0 ? Effect.succeed([]) : bridge.cross(sending)
						).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.catchCause((cause) => {
								const defect = Cause.findDefect(cause),
									error = Cause.findErrorOption(cause);
								const message = Result.isSuccess(defect)
									? messageOf(defect.success)
									: Option.isSome(error)
										? messageOf(error.value)
										: 'the crossing was interrupted';
								return Effect.succeed(sending.map(() => fail('bridge', message)));
							})
						);
						const answers = hostAnswers.pipe(
							Effect.map((values) =>
								values.length === sending.length
									? values
									: sending.map(() =>
											fail('badAnswer', 'the host answered a different number of calls')
										)
							),
							Effect.timeoutOrElse({
								duration,
								orElse: () =>
									Effect.succeed(
										sending.map(
											() =>
												({
													ok: false,
													error: { kind: 'timeout', message: `no answer within ${duration} ms` }
												}) satisfies CrossAnswer
										)
									)
							})
						);
						yield* answers.pipe(
							Effect.flatMap((sent) =>
								Queue.offer(landed, {
									calls: group.flatMap((i) => (calls[i] === undefined ? [] : [calls[i]])),
									lowered: part,
									sent
								})
							),
							Effect.onExit((exit) =>
								Exit.isFailure(exit) ? Queue.failCause(landed, exit.cause) : Effect.void
							),
							Effect.forkScoped
						);
					}
				}
				if (pending === 0)
					return failed('stalled', 'stalled: the body awaits something no ctx call will settle');
				const answer = yield* Queue.take(landed);
				pending--;
				let next = 0;
				const answerOf = (value: CrossCall | CrossAnswer): CrossAnswer =>
					isCall(value) ? (answer.sent[next++] ?? fail('badAnswer', 'no answer')) : value;
				const answers = answer.lowered.map((value): CrossAnswer => {
					if (!isKeyed(value)) return answerOf(value);
					const members = value.keyed.map(([key, call]) => [key, answerOf(call)] as const),
						bad = members.find(([, member]) => !member.ok);
					return bad === undefined
						? {
								ok: true,
								value: Object.fromEntries(
									members.map(([key, member]) => [key, member.ok ? member.value : null])
								)
							}
						: bad[1];
				});
				crossings -= answer.sent.filter((value) => value.journal === true).length;
				tally.crossings = crossings;
				tally.statements += answer.lowered.filter(
					(value) => isKeyed(value) || (isCall(value) && STATEMENTS.has(value._tag))
				).length;
				let bytes = 0,
					biggest = 0,
					biggestAt = 0;
				const texts: string[] = [];
				for (const [i, value] of answers.entries()) {
					const text = yield* Effect.try({
						try: () =>
							JSON.stringify(
								value.ok ? { ok: true, value: value.value } : { ok: false, error: value.error }
							),
						catch: (error) => BoltError.make('badAnswer', 'guest', messageOf(error))
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed(JSON.stringify(fail('badAnswer', error.message)))
						)
					);
					const size =
						Buffer.byteLength(text) +
						(value.ok ? (value.bins ?? []) : []).reduce((sum, bin) => sum + bin.byteLength, 0);
					bytes += size;
					if (size > biggest) {
						biggest = size;
						biggestAt = i;
					}
					const call = answer.lowered[i];
					if (call !== undefined && (isKeyed(call) || (isCall(call) && call._tag === 'read')))
						readBytes += size;
					if (
						!value.ok &&
						call !== undefined &&
						isCall(call) &&
						isFacility(call) &&
						value.error.kind !== 'bolt'
					) {
						const [facility, ...member] = call._tag.split('.');
						yield* events.emit('warn', 'facility.failed', {
							facility: facility ?? '',
							method: member.join('.'),
							kind: value.error.kind,
							message: 'message' in value.error ? value.error.message : value.error.reason
						});
					}
					texts.push(text);
				}
				const at = answer.calls[0]?.[2] ?? 'unknown';
				if (bytes > limits.crossingBytes) {
					const big = answer.lowered[biggestAt],
						large = answers[biggestAt],
						member =
							big !== undefined && isKeyed(big)
								? Object.entries(object(large?.ok ? large.value : null))
										.map(
											([key, value]) =>
												[key, Buffer.byteLength(JSON.stringify(value) ?? '')] as const
										)
										.sort((a, b) => b[1] - a[1])[0]
								: undefined;
					const what =
						big === undefined || (!isCall(big) && !isKeyed(big))
							? 'complete the request'
							: isKeyed(big)
								? member === undefined
									? 'read data'
									: `read '${member[0]}'`
								: big._tag === 'read'
									? `read '${big.read.collection}'`
									: big._tag === 'act'
										? `run '${big.callable._tag === 'Verb' ? `${big.callable.collection}.${big.callable.verb}` : big.callable._tag === 'Action' ? `${big.callable.collection}.${big.callable.action}` : big.callable._tag === 'Automation' ? big.callable.automation : big.callable._tag === 'Pipeline' ? `${big.callable.collection}.pipeline` : `${big.callable.integration}.${big.callable.feed}`}'`
										: `complete ctx.${big._tag}`;
					const hint =
						big !== undefined && (isKeyed(big) || (isCall(big) && big._tag === 'read'))
							? 'page it with `limit` and the returned cursor, or `select` fewer fields'
							: 'return less from it';
					return failed(
						'tooLarge',
						`Could not ${what}: too much data returned at once (${(bytes / 1024 / 1024).toFixed(1)} MB total, over the ${limits.crossingBytes / 1024 / 1024} MB limit). Largest response: ${(biggest / 1024 / 1024).toFixed(1)} MB${member === undefined ? '' : `; '${member[0]}': ${(member[1] / 1024 / 1024).toFixed(1)} MB`}. At ${where(answer.calls[biggestAt]?.[2] ?? at)}; ${hint}.`
					);
				}
				if (readBytes > invocation.budget.readBytes)
					return failed(
						'readBudgetExceeded',
						`the invocation read over ${invocation.budget.readBytes} bytes; the last read was at ${where(at)}`
					);
				yield* slice(() =>
					warm.give.apply(
						undefined,
						[
							answer.calls.map((call) => call[3]),
							texts,
							answers.map((value) => (value.ok ? [...(value.bins ?? [])] : []))
						],
						{ arguments: { copy: true } }
					)
				);
			}
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed({ kind: 'failed', error, cpuMs: cpu() } satisfies GuestOutcome)
			),
			Effect.ensuring(
				Effect.sync(() => {
					cpu();
					warm.drop();
				})
			)
		);
	});

export const GuestLive = Layer.effect(
	Guest,
	Effect.gen(function* () {
		const activation = yield* Activation,
			manifest = yield* Manifest,
			prepared = yield* PreparedIsolates,
			limits = yield* GuestLimits,
			options = yield* GuestConfig,
			telemetry = yield* Telemetry,
			generation = yield* Scope.Scope;
		if (
			options.callWallMs !== undefined &&
			(!Number.isInteger(options.callWallMs) ||
				options.callWallMs < 0 ||
				options.callWallMs > 0xffffffff)
		)
			return yield* Effect.fail(
				BoltError.make(
					'invalidInput',
					'guest',
					'the crossing wall must be an integer from 0 to 4294967295 ms'
				)
			);
		const open = yield* Ref.make(true);
		yield* Effect.addFinalizer(() => Ref.set(open, false));
		const execute = (
			program: GuestProgram | undefined,
			invocation: Invocation,
			bridge: Bridge
		): Effect.Effect<GuestOutcome> =>
			Effect.gen(function* () {
				if (!(yield* Ref.get(open)))
					return {
						kind: 'failed',
						error: BoltError.make(
							'interrupted',
							'guest',
							'the invocation was interrupted: its generation is draining (rule 71a)'
						),
						cpuMs: 0
					} satisfies GuestOutcome;
				const work = ensureRequestCpu(
					Effect.scoped(
						Effect.gen(function* () {
							if (program === undefined)
								return {
									kind: 'failed',
									error: BoltError.make('noGuest', 'guest', 'the workspace has no guest program'),
									cpuMs: 0
								} satisfies GuestOutcome;
							const tally: Tally = { crossings: 0, statements: 0 };
							const events = yield* telemetry.open({
								invocation: invocation.id,
								run: invocation.run
							});
							const outcome = yield* run(
								yield* prepared.pool(program),
								program,
								manifest,
								options,
								limits,
								events,
								invocation,
								bridge,
								tally
							).pipe(
								Effect.catch((error) =>
									Effect.succeed({ kind: 'failed', error, cpuMs: 0 } satisfies GuestOutcome)
								)
							);
							if (options.cpu !== undefined)
								yield* Effect.try({
									try: () => options.cpu?.(invocation, outcome.cpuMs, tally),
									catch: (error) =>
										BoltError.make('internal', 'guest', 'the host CPU meter failed', error)
								}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
							return outcome;
						})
					)
				);
				return yield* Effect.acquireUseRelease(
					work.pipe(Effect.forkIn(generation)),
					Fiber.join,
					Fiber.interrupt
				);
			}).pipe(
				Effect.catch((error) =>
					Effect.succeed({ kind: 'failed', error, cpuMs: 0 } satisfies GuestOutcome)
				)
			);
		return Guest.of({
			invoke: (invocation, bridge) =>
				execute(Option.getOrUndefined(activation.guest), invocation, bridge),
			invokeProgram: (program, invocation, bridge) => execute(program, invocation, bridge)
		});
	})
);
