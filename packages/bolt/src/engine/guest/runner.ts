// The guest run loop: lowering, crossings, budgets and console events. Every native slice is the host's
// (`GuestIsolates`): it makes, meters and ends the isolate; the engine only decodes its turns.
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import {
	Cause,
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Predicate,
	Queue,
	Ref,
	Result,
	Schema,
	Scope
} from 'effect';
import type { Json } from '../../decl/values.ts';
import type {
	CrossAnswer,
	GuestCall,
	GuestOutcome,
	GuestTurn,
	Invocation,
	InvocationKind
} from '../contracts.ts';
import { LIMITS } from '../contracts.ts';
import { BoltError, type Code } from '../../protocol/errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { isBatchCallable, parseCallable } from '../callables/index.ts';
import { lowerRead as workspaceRead } from '../query/engine.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import {
	Activation,
	Guest,
	GuestLimits,
	Manifest,
	Telemetry,
	type Bridge,
	type CrossCall,
	type GuestLimitsShape,
	type InvocationEvents
} from '../services.ts';
import { GuestIsolates, type GuestSession } from '../ports.ts';
import { PRELUDE } from './prelude.ts';

export type GuestProgram = {
	source: string;
	sourceMap?: string;
	assets?: Readonly<Record<string, Uint8Array>>;
};
export type GuestOptions = {
	readonly lowerRead?: ((member: string, args: readonly Json[]) => ReadIR) | undefined;
	readonly console?: ((level: string, line: string, invocation: Invocation) => void) | undefined;
	readonly callWallMs?: number | undefined;
};
export const GuestConfig = Context.Reference<GuestOptions>('bolt/GuestConfig', {
	defaultValue: () => ({})
});
const PAGE_READS = new Set(['query', 'aggregate', 'history']);
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).byteLength;
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
		// the one read API: `query`, `aggregate`, `history`, and the workspace's `db.query`, `db.aggregate`, `db.after`
		const head = member.split('.')[0];
		if (head === 'query' || head === 'aggregate' || head === 'history' || head === 'db')
			return {
				_tag: 'read',
				read: yield* Effect.try({
					try: () => read(member, args),
					catch: (error) => BoltError.make('invalidInput', 'guest', messageOf(error))
				})
			};
		switch (member) {
			case 'transaction.begin':
				return { _tag: 'transactionBegin' };
			case 'transaction.abort':
				return { _tag: 'transactionAbort' };
			case 'transaction.finish': {
				const result = yield* decode(
					Schema.Struct({ output: Schema.Json, omitted: Schema.Boolean }),
					args[0]
				);
				return { _tag: 'transactionFinish', ...result };
			}
			case 'transaction.act': {
				const name = yield* callable(yield* decode(Schema.String, args[0]), manifest);
				if (!isBatchCallable(name))
					return yield* Effect.fail(
						BoltError.make(
							'invalidInput',
							'guest',
							'A transaction takes generated create, update, upsert or delete.'
						)
					);
				const options = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ onConflict: Schema.optionalKey(Schema.Literals(['update', 'keep'])) }),
					{ onExcessProperty: 'error' }
				)(args[2] ?? {}).pipe(
					Effect.mapError((error) => BoltError.make('invalidInput', 'guest', error.message))
				);
				if ((name.verb === 'upsert') !== (options.onConflict !== undefined))
					return yield* Effect.fail(
						BoltError.make('invalidInput', 'guest', 'Only upsert requires an onConflict mode.')
					);
				return { _tag: 'transactionAct', callable: name, input: args[1] ?? null, ...options };
			}
			case 'transaction.query': {
				const query = yield* Effect.try({
					try: () => read('query', args),
					catch: (error) => BoltError.make('invalidInput', 'guest', messageOf(error))
				});
				return { _tag: 'transactionRead', reads: [query] };
			}
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
					Schema.Array(
						Schema.Struct({
							callable: Schema.String,
							input: Schema.Json,
							observed: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
							onConflict: Schema.optionalKey(Schema.Literals(['update', 'keep']))
						})
					),
					args[0]
				);
				return {
					_tag: 'acts',
					acts: yield* Effect.forEach(acts, (act) =>
						Effect.gen(function* () {
							const name = yield* callable(act.callable, manifest);
							if (!isBatchCallable(name))
								return yield* Effect.fail(
									BoltError.make(
										'invalidInput',
										'guest',
										'An act batch takes create, update, upsert or delete.'
									)
								);
							return {
								callable: name,
								input: act.input,
								...(act.observed === undefined ? {} : { observed: act.observed }),
								...(act.onConflict === undefined ? {} : { onConflict: act.onConflict })
							};
						})
					)
				};
			}
			case 'schedule': {
				const automation = yield* decode(Schema.String, args[0]);
				const options = yield* decode(
					Schema.Struct({
						at: Schema.optionalKey(
							Schema.Union([Schema.String, Schema.Struct({ var: Schema.String })])
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
			// `ctx.send(to, message)` in an automation; a sync body's `ctx.send(message)` goes through its instance (`to` null)
			case 'send':
				return args.length >= 2
					? { _tag: 'send', to: yield* decode(Schema.String, args[0]), message: args[1] ?? null }
					: { _tag: 'send', to: null, message: args[0] ?? null };
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

/**
 * Where a body lives in the guest's default export (the Guest ABI). `integration` and `tool` targets are that path,
 * dotted. A parser's media type keeps its own dots: `'<model>.<sync>.<type>'` splits on the first two.
 */
const RefusalDetails = Schema.fromJsonString(
	Schema.Struct({
		code: Schema.String,
		rows: Schema.optionalKey(Schema.Array(Schema.Number)),
		rule: Schema.optionalKey(Schema.String),
		data: Schema.optionalKey(Schema.Struct({ requestId: Schema.String })),
		records: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					model: Schema.String,
					id: Schema.String,
					fields: Schema.Array(Schema.String)
				})
			)
		),
		invocation: Schema.optionalKey(Schema.String)
	})
);

export function bodyPath(kind: InvocationKind, target: string): string[] {
	const [model = '', member = '', ...rest] = target.split('.');
	switch (kind) {
		case 'create':
		case 'update':
		case 'delete':
		case 'notify':
			return ['model', target, 'bodies', kind];
		case 'vector':
		case 'probe':
		case 'rerank':
			return ['model', model, 'bodies', 'indexes', member, kind];
		case 'syncRead':
			return ['model', model, 'bodies', 'syncs', member, 'read'];
		case 'syncWrite':
			return ['model', model, 'bodies', 'syncs', member, 'write'];
		case 'parse':
			return ['model', model, 'bodies', 'syncs', member, 'parse', rest.join('.')];
		case 'policy':
			return ['policy', model, 'grants', member, ...rest, 'check'];
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

/** Stored console output per invocation (lines, characters) and per line (characters). */
const CONSOLE = { lines: 200, bytes: 64 * 1024, lineChars: 2048 } as const;
const stackLocation = (program: GuestProgram) => {
	let map: TraceMap | undefined;
	return (frame: string): string => {
		const match = /([^\s()]+):(\d+):(\d+)\)?$/.exec(frame);
		if (match === null) return frame;
		const [, file = '', line = '0', column = '1'] = match;
		if (program.sourceMap !== undefined && file === 'guest.mjs') {
			map ??= new TraceMap(program.sourceMap);
			const at = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
			if (at.source !== null) return `${at.source}:${at.line}`;
		}
		return `${file}:${line}`;
	};
};
const isCall = (value: CrossCall | CrossAnswer): value is CrossCall => '_tag' in value;
const isFacility = (call: CrossCall) => Facilities.some((member) => member === call._tag);
type Landed = {
	readonly calls: readonly GuestCall[];
	readonly lowered: readonly (CrossCall | CrossAnswer)[];
	readonly sent: readonly CrossAnswer[];
};
const run = (
	open: Effect.Effect<GuestSession, BoltError, Scope.Scope>,
	program: GuestProgram,
	manifest: EngineManifest,
	options: GuestOptions,
	limits: GuestLimitsShape,
	events: InvocationEvents,
	invocation: Invocation,
	bridge: Bridge
) =>
	Effect.gen(function* () {
		const where = stackLocation(program),
			wallMs = Math.min(options.callWallMs ?? LIMITS.callMs.database, LIMITS.callMs.database);
		const read = options.lowerRead ?? ((member, args) => workspaceRead(manifest, member, args));
		// tenant console lines are the invocation's events, bounded per invocation and per line; a line past the bound
		// is only this runtime's own log line
		const kept = { lines: 0, bytes: 0, dropped: false };
		const tag =
			invocation.kind === 'automation'
				? { automation: invocation.target }
				: { callable: invocation.target, kind: invocation.kind };
		const dropped = Effect.gen(function* () {
			if (!kept.dropped)
				yield* events.emit('warn', 'console.dropped', {
					...tag,
					note: `further console lines are not stored (over ${CONSOLE.lines} lines or ${CONSOLE.bytes} characters)`
				});
			kept.dropped = true;
		});
		/** One native slice's turn: its console lines become events before the turn is read. */
		const slice = (turn: Effect.Effect<GuestTurn, BoltError>) =>
			Effect.gen(function* () {
				const { taken, lines, dropped: lost } = yield* turn;
				for (const [level, raw] of lines) {
					options.console?.(level, raw, invocation);
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
						yield* dropped;
						if (options.console === undefined)
							yield* Effect.logInfo(`[guest ${invocation.id}] ${level} ${raw}`);
					}
				}
				if (lost > 0) yield* dropped;
				return taken;
			});
		const failed = (code: Code, message: string, cause?: unknown): GuestOutcome => ({
			kind: 'failed',
			error: BoltError.make(code, 'guest', message, cause)
		});
		const landed = yield* Queue.unbounded<Landed>();
		let pending = 0,
			crossings = 0,
			readBytes = 0;
		const { seed: _seed, ...ctx } = invocation.ctx;
		/** One run of the body in one isolate, to its end. */
		const pass = (session: GuestSession) =>
			Effect.gen(function* (): Effect.fn.Return<GuestOutcome, BoltError, Scope.Scope> {
				let taken = yield* slice(
					session.start({
						kind: invocation.kind,
						path: bodyPath(invocation.kind, invocation.target),
						input: JSON.stringify(invocation.input),
						ctx: JSON.stringify(ctx),
						invocation: invocation.id
					})
				);
				for (;;) {
					const [final, calls, bins, ranTimer] = taken;
					if (ranTimer) {
						taken = yield* slice(session.take);
						continue;
					}
					const first = calls[0];
					if (final !== null) {
						if (first !== undefined)
							return failed(
								'internal',
								`unawaited: the body returned while a ctx call was pending at ${where(first[2])}`
							);
						if (pending > 0)
							return failed(
								'internal',
								'unawaited: the body returned while a ctx call was pending'
							);
						switch (final[0]) {
							case 'ok':
								if (byteLength(final[1]) > limits.argsBytes)
									return failed('tooLarge', `the result is over ${limits.argsBytes} bytes`);
								return {
									kind: 'ok',
									output: yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
										final[1]
									).pipe(
										Effect.mapError((error) =>
											BoltError.make('internal', 'guest', 'the guest isolate failed', error)
										)
									)
								} satisfies GuestOutcome;
							case 'refused':
								return {
									kind: 'refused',
									message: final[1],
									...(yield* Schema.decodeUnknownEffect(RefusalDetails)(final[4]).pipe(
										Effect.mapError((error) =>
											BoltError.make(
												'internal',
												'guest',
												'The guest refusal metadata did not decode.',
												error
											)
										)
									)),
									...(final[2] === null ? {} : { field: final[2] }),
									...(final[3] === null ? {} : { row: final[3] })
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
						// a policy check reads through `ctx.db.query` only (rule 35)
						if (invocation.kind === 'policy') {
							const forbidden = calls.find(([member]) => member !== 'db.query');
							if (forbidden !== undefined)
								return failed('forbidden', `a policy check cannot call '${forbidden[0]}'`);
						}
						if (crossings + calls.length > invocation.budget.crossings) {
							const over = calls[Math.max(0, invocation.budget.crossings - crossings)] ?? first;
							return failed(
								'crossingBudget',
								`the invocation made more than ${invocation.budget.crossings} crossings; the next was at ${where(over[2])}`
							);
						}
						const big = calls.find((call) => byteLength(call[1]) > limits.argsBytes);
						if (big !== undefined)
							return failed(
								'tooLarge',
								`a ctx call's arguments are over ${limits.argsBytes} bytes at ${where(big[2])}`
							);
						crossings += calls.length;
						const lowered = yield* Effect.forEach(calls, ([member, json, , id], i) =>
							Effect.gen(function* () {
								const args = yield* argsOf(json).pipe(
									Effect.mapError((error) => BoltError.make('invalidInput', 'guest', error.message))
								);
								return yield* lower(member, args, bins[i] ?? [], read, manifest);
							}).pipe(
								Effect.catch((error) =>
									Effect.succeed(
										member === 'act' || member === 'acts' || member.startsWith('transaction.')
											? ({
													ok: false,
													error: { kind: 'refused', code: error.code, message: error.message }
												} satisfies CrossAnswer)
											: fail('invalidInput', error.message)
									)
								)
							)
						);
						const alone = (value: CrossCall | CrossAnswer) =>
							isCall(value) && (isFacility(value) || value._tag === 'request');
						const groups = [
							...lowered.flatMap((value, i) => (alone(value) ? [[i]] : [])),
							lowered.flatMap((value, i) => (alone(value) ? [] : [i]))
						].filter((group) => group.length > 0);
						for (const group of groups) {
							const part = group.flatMap((i) => (lowered[i] === undefined ? [] : [lowered[i]]));
							const sending = part.flatMap((value) => (isCall(value) ? [value] : []));
							const only = part.length === 1 ? part[0] : undefined;
							// an inference has no wall: its stall window ends it
							const duration =
								only !== undefined && isCall(only) && only._tag === 'ai.sys_2.infer'
									? undefined
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
							const counted = hostAnswers.pipe(
								Effect.map((values) =>
									values.length === sending.length
										? values
										: sending.map(() =>
												fail('badAnswer', 'the host answered a different number of calls')
											)
								)
							);
							const answers =
								duration === undefined
									? counted
									: counted.pipe(
											Effect.timeoutOrElse({
												duration,
												orElse: () =>
													Effect.succeed(
														sending.map(
															() =>
																({
																	ok: false,
																	error: {
																		kind: 'timeout',
																		message: `no answer within ${duration} ms`
																	}
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
					const answers = answer.lowered.map(answerOf);
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
							byteLength(text) +
							(value.ok ? (value.bins ?? []) : []).reduce((sum, bin) => sum + bin.byteLength, 0);
						bytes += size;
						if (size > biggest) {
							biggest = size;
							biggestAt = i;
						}
						const call = answer.lowered[i];
						if (call !== undefined && isCall(call) && call._tag === 'read') readBytes += size;
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
							read = big !== undefined && isCall(big) && big._tag === 'read',
							// a read request answers per root: name the largest
							member =
								read && isCall(big) && big._tag === 'read' && big.read.kind === 'request'
									? Object.entries(object(large?.ok ? large.value : null))
											.map(
												([key, value]) => [key, byteLength(JSON.stringify(value) ?? '')] as const
											)
											.sort((a, b) => b[1] - a[1])[0]
									: undefined;
						const what =
							big === undefined || !isCall(big)
								? 'complete the request'
								: big._tag === 'read'
									? member !== undefined
										? `read '${member[0]}'`
										: 'model' in big.read
											? `read '${big.read.model}'`
											: 'read data'
									: big._tag === 'act'
											? `run '${big.callable._tag === 'Verb' ? `${big.callable.model}.${big.callable.verb}` : big.callable._tag === 'Automation' ? big.callable.automation : `${big.callable.model}.sync.${big.callable.sync}`}'`
											: `complete ctx.${big._tag}`;
						const hint =
							read
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
					taken = yield* slice(
						session.give({
							ids: answer.calls.map((call) => call[3]),
							texts,
							bins: answers.map((value) => (value.ok ? [...(value.bins ?? [])] : []))
						})
					);
				}
			});
		return yield* Effect.gen(function* () {
			const held = yield* Scope.make();
			return yield* open.pipe(
				Scope.provide(held),
				Effect.flatMap(pass),
				Effect.ensuring(Scope.close(held, Exit.void))
			);
		}).pipe(
			Effect.catch((error) => Effect.succeed({ kind: 'failed', error } satisfies GuestOutcome))
		);
	});

export const GuestLive = Layer.effect(
	Guest,
	Effect.gen(function* () {
		const activation = yield* Activation,
			manifest = yield* Manifest,
			isolates = yield* GuestIsolates,
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
						)
					} satisfies GuestOutcome;
				const work = Effect.scoped(
					Effect.gen(function* () {
						if (program === undefined)
							return {
								kind: 'failed',
								error: BoltError.make('noGuest', 'guest', 'the workspace has no guest program')
							} satisfies GuestOutcome;
						const events = yield* telemetry.open({
							invocation: invocation.id,
							run: invocation.run
						});
						return yield* run(
							isolates.open(program, {
								prelude: PRELUDE,
								seed: invocation.ctx.seed,
								memoryMiB: limits.memoryMiB
							}),
							program,
							manifest,
							options,
							limits,
							events,
							invocation,
							bridge
						);
					})
				);
				return yield* Effect.acquireUseRelease(
					work.pipe(Effect.forkIn(generation)),
					Fiber.join,
					Fiber.interrupt
				);
			}).pipe(
				Effect.catch((error) => Effect.succeed({ kind: 'failed', error } satisfies GuestOutcome))
			);
		return Guest.of({
			invoke: (invocation, bridge) =>
				execute(Option.getOrUndefined(activation.guest), invocation, bridge),
			invokeProgram: (program, invocation, bridge) => execute(program, invocation, bridge)
		});
	})
);
