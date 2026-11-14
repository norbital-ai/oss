// The guest run loop: lowering, crossings, budgets and console events. Every native slice is the host's
// (`GuestIsolates`): it makes, meters and ends the isolate; the engine only decodes its turns.
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping';
import {
	Cause,
	Config,
	ConfigProvider,
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
import { FACILITY_MEMBERS } from '../../decl/runtime/facility-members.ts';
import { MessageValues, message_text } from '../../decl/errors/refusal.ts';
import {
	type GuestCall,
	type GuestFinal,
	GuestFinalSchema,
	type GuestProgram,
	type GuestTurn
} from '@norbital-ai/host-api';
import type { CrossAnswer, GuestOutcome, GuestPart, Invocation, InvocationKind } from '../contracts.ts';
import { LIMITS, cross_failure, facility_wall_ms } from '../contracts.ts';
import { BoltError, type Code } from '../../protocol/errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { decode_acts } from '../callables/parse.ts';
import { lower_read as workspaceRead } from '../query/engine.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import {
	Activation,
	Guest,
	GuestLimits,
	Manifest,
	Telemetry,
	type Bridge,
	type CrossCall,
	type FacilityCall,
	type GuestLimitsShape,
	type InvocationEvents
} from '../services.ts';
import { GuestIsolates, type GuestSession } from '../ports.ts';
import { PRELUDE } from './prelude.ts';

export type GuestOptions = {
	readonly lower_read?: ((member: string, args: readonly Json[]) => Effect.Effect<ReadIR, BoltError>) | undefined;
	readonly console?: ((level: string, line: string, invocation: Invocation) => void) | undefined;
	readonly call_wall_ms?: number | undefined;
};
export const GuestConfig = Context.Reference<GuestOptions>('bolt/GuestConfig', {
	defaultValue: () => ({})
});
const PAGE_READS = new Set(['query', 'history']);
const SERVER_READS = new Set(['query', 'history', 'db.query']);
const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).byteLength;
const object = (value: Json | undefined): { readonly [key: string]: Json } =>
	Predicate.isObject(value) ? Object.fromEntries(Object.entries<Json>(value)) : {};
const argsOf = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Json)));
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((error) => BoltError.make('invalid_input', 'guest', error.message))
	);
const facility = Schema.Literals(FACILITY_MEMBERS);
const lower = (
	member: string,
	args: readonly Json[],
	bins: readonly Uint8Array[],
	read: NonNullable<GuestOptions['lower_read']>,
	manifest: EngineManifest
): Effect.Effect<CrossCall, BoltError> =>
	Effect.gen(function* () {
		// every body aggregates inside a query request
		if (SERVER_READS.has(member))
			return {
				_tag: 'read',
				read: yield* read(member, args).pipe(
					Effect.mapError((error) => BoltError.make('invalid_input', 'guest', messageOf(error)))
				)
			};
		switch (member) {
			case 'act': {
				const decoded = yield* decode_acts(manifest, args[0], args[1]);
				return { _tag: 'act', ...decoded };
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
				return { _tag: 'notify', notices: args[0] ?? null, ...(bins.length === 0 ? {} : { bins }) };
			// `ctx.send(to, message)` in an automation; a sync body's `ctx.send(message)` goes through its instance (`to` null)
			case 'send':
				return args.length >= 2
					? {
							_tag: 'send',
							to: yield* decode(Schema.String, args[0]),
							message: args[1] ?? null,
							...(bins.length === 0 ? {} : { bins })
						}
					: { _tag: 'send', to: null, message: args[0] ?? null };
			case 'progress':
				return { _tag: 'progress', progress: args[0] ?? null };
			case 'wait':
				return { _tag: 'wait', on: args[0] ?? null };
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
		key: Schema.optionalKey(Schema.String),
		values: Schema.optionalKey(MessageValues),
		rows: Schema.optionalKey(Schema.Array(Schema.Number)),
		rule: Schema.optionalKey(Schema.String),
		data: Schema.optionalKey(Schema.Struct({ request_id: Schema.String })),
		records: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					model: Schema.String,
					id: Schema.String
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
			return ['policy', model, 'grants', member, ...rest, 'verdict'];
		case 'automation':
			return ['automation', target, 'body'];
		// `<model>.effect.<verb>`
		case 'effect':
			return [
				'model',
				target.slice(0, target.lastIndexOf('.effect.')),
				'bodies',
				'effect',
				target.slice(target.lastIndexOf('.') + 1)
			];
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
		if (program.source_map !== undefined && file === 'guest.mjs') {
			map ??= new TraceMap(program.source_map);
			const at = originalPositionFor(map, { line: Number(line), column: Number(column) - 1 });
			if (at.source !== null) return `${at.source}:${at.line}`;
		}
		return `${file}:${line}`;
	};
};
const isCall = (value: CrossCall | CrossAnswer): value is CrossCall => '_tag' in value;
export const isFacility = (call: CrossCall): call is FacilityCall => FACILITY_MEMBERS.some((member) => member === call._tag);
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
	bridge: Bridge,
	secrets: Readonly<Record<string, string>>,
	/** Several bodies of the invocation's kind, started together: one outcome each, in order. */
	parts?: readonly GuestPart[]
) =>
	Effect.gen(function* (): Effect.fn.Return<readonly GuestOutcome[]> {
		const where = stackLocation(program),
			wallMs = Math.min(options.call_wall_ms ?? LIMITS.callMs.database, LIMITS.callMs.database);
		const read = options.lower_read ?? ((member, args) => workspaceRead(manifest, member, args));
		// tenant console lines are the invocation's events, bounded per invocation and per line; a line past the bound
		// is only this runtime's own log line
		const kept = { lines: 0, bytes: 0, dropped: false };
		const tag =
			invocation.kind === 'automation' || invocation.kind === 'effect'
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
		/** A body's end state as its outcome. */
		const settle = Effect.fnUntraced(function* (final: GuestFinal): Effect.fn.Return<GuestOutcome, BoltError> {
			switch (final[0]) {
				case 'ok':
					// A write transform returns the expanded change set, including owned rows. Its
					// existing change-set bound applies; ordinary results and call arguments stay bounded.
					const resultBytes =
						invocation.kind === 'create' || invocation.kind === 'update' || invocation.kind === 'delete'
							? limits.change_set_bytes
							: limits.args_bytes;
					if (byteLength(final[1]) > resultBytes)
						return failed('too_large', `the result is over ${resultBytes} bytes`);
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
				case 'refused': {
					const details = yield* Schema.decodeUnknownEffect(RefusalDetails)(final[4]).pipe(
						Effect.mapError((error) =>
							BoltError.make(
								'internal',
								'guest',
								'The guest refusal metadata did not decode.',
								error
							)
						)
					);
					// an authored refusal leaves the guest as its key: the workspace catalogue renders it once, here
					return {
						kind: 'refused',
						message:
							details.key === undefined
								? final[1]
								: message_text(manifest.messages, details.key, details.values),
						...details,
						...(final[2] === null ? {} : { field: final[2] }),
						...(final[3] === null ? {} : { row: final[3] })
					} satisfies GuestOutcome;
				}
				case 'missing':
					return failed(
						'missing_body',
						`guest.mjs has no ${invocation.kind} body at ${final[1]}`
					);
				case 'error': {
					const at = final[3].split('\n').find((line) => line.includes('guest.mjs'));
					return failed('guest_error', final[2], {
						name: final[1],
						message: final[2],
						stack: final[3],
						...(final.length === 5 ? { kind: final[4] } : {}),
						...(at === undefined ? {} : { at: where(at) })
					});
				}
			}
		});
		const landed = yield* Queue.unbounded<Landed>();
		let pending = 0,
			crossings = 0,
			readBytes = 0;
		const { seed: _seed, ...ctx } = invocation.ctx;
		/** One run of the body in one isolate, to its end. */
		const pass = (session: GuestSession) =>
			Effect.gen(function* (): Effect.fn.Return<
				GuestOutcome | readonly GuestOutcome[],
				BoltError,
				Scope.Scope
			> {
				let taken = yield* slice(
					session.start({
						kind: invocation.kind,
						// an empty path starts each part's body (`[path, input]`) instead of one
						path: parts === undefined ? bodyPath(invocation.kind, invocation.target) : [],
						input: JSON.stringify(
							parts === undefined
								? invocation.input
								: parts.map((part) => [bodyPath(invocation.kind, part.target), part.input])
						),
						ctx: JSON.stringify({ ...ctx, $secrets: secrets }),
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
						if (parts === undefined) return yield* settle(final);
						if (final[0] !== 'ok') return failed('internal', 'the guest batch did not answer');
						const states = yield* Schema.decodeUnknownEffect(
							Schema.fromJsonString(Schema.Array(GuestFinalSchema))
						)(final[1]).pipe(
							Effect.mapError((error) =>
								BoltError.make('internal', 'guest', 'the guest isolate failed', error)
							)
						);
						if (states.length !== parts.length)
							return failed('internal', 'the guest batch answered another number of bodies');
						return yield* Effect.forEach(states, settle);
					}
					if (first !== undefined) {
						if (invocation.kind === 'page') {
							const forbidden = calls.find(([member]) => !PAGE_READS.has(member));
							if (forbidden !== undefined)
								return failed('forbidden', `page rendering cannot call '${forbidden[0]}'`);
						}
						// a policy check reads through `ctx.query` only
						if (invocation.kind === 'policy') {
							const forbidden = calls.find(([member]) => member !== 'db.query');
							if (forbidden !== undefined)
								return failed('forbidden', `a policy check cannot call '${forbidden[0]}'`);
						}
						if (crossings + calls.length > invocation.budget.crossings) {
							const over = calls[Math.max(0, invocation.budget.crossings - crossings)] ?? first;
							return failed(
								'crossing_budget',
								`the invocation made more than ${invocation.budget.crossings} crossings; the next was at ${where(over[2])}`
							);
						}
						const big = calls.find((call) => byteLength(call[1]) > limits.args_bytes);
						if (big !== undefined)
							return failed(
								'too_large',
								`a ctx call's arguments are over ${limits.args_bytes} bytes at ${where(big[2])}`
							);
						crossings += calls.length;
						const lowered = yield* Effect.forEach(calls, ([member, json, , id], i) =>
							Effect.gen(function* () {
								const args = yield* argsOf(json).pipe(
									Effect.mapError((error) => BoltError.make('invalid_input', 'guest', error.message))
								);
								return yield* lower(member, args, bins[i] ?? [], read, manifest);
							}).pipe(
								Effect.catch((error) =>
									Effect.succeed(
										member === 'act'
											? ({
													ok: false,
													error: { kind: 'refused', code: error.code, message: error.message }
												} satisfies CrossAnswer)
											: cross_failure('invalid_input', error.message)
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
							const duration = only !== undefined && isCall(only) && isFacility(only)
								? facility_wall_ms(only._tag, wallMs)
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
									return Effect.succeed(sending.map(() => cross_failure('bridge', message)));
								})
							);
							const counted = hostAnswers.pipe(
								Effect.map((values) =>
									values.length === sending.length
										? values
										: sending.map(() =>
												cross_failure('bad_answer', 'the host answered a different number of calls')
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
						isCall(value) ? (answer.sent[next++] ?? cross_failure('bad_answer', 'no answer')) : value;
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
							catch: (error) => BoltError.make('bad_answer', 'guest', messageOf(error))
						}).pipe(
							Effect.catch((error) =>
								Effect.succeed(JSON.stringify(cross_failure('bad_answer', error.message)))
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
					if (bytes > limits.crossing_bytes) {
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
										? 'complete ctx.act'
										: `complete ctx.${big._tag}`;
						const hint = read
							? 'page it with `limit` and the returned cursor, or `select` fewer fields'
							: 'return less from it';
						return failed(
							'too_large',
							`Could not ${what}: too much data returned at once (${(bytes / 1024 / 1024).toFixed(1)} MB total, over the ${limits.crossing_bytes / 1024 / 1024} MB limit). Largest response: ${(biggest / 1024 / 1024).toFixed(1)} MB${member === undefined ? '' : `; '${member[0]}': ${(member[1] / 1024 / 1024).toFixed(1)} MB`}. At ${where(answer.calls[biggestAt]?.[2] ?? at)}; ${hint}.`
						);
					}
					if (readBytes > invocation.budget.readBytes)
						return failed(
							'read_budget_exceeded',
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
				Effect.flatMap(pass),
				Scope.provide(held),
				Effect.ensuring(Scope.close(held, Exit.void))
			);
		}).pipe(
			Effect.catch((error) => Effect.succeed({ kind: 'failed', error } satisfies GuestOutcome)),
			// one failure of the whole run (a budget, the isolate) is every part's
			Effect.map((outcome) => ('kind' in outcome ? (parts ?? [null]).map(() => outcome) : outcome))
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
		const configuration = yield* ConfigProvider.ConfigProvider;
		if (
			options.call_wall_ms !== undefined &&
			(!Number.isInteger(options.call_wall_ms) ||
				options.call_wall_ms < 0 ||
				options.call_wall_ms > 0xffffffff)
		)
			return yield* Effect.fail(
				BoltError.make(
					'invalid_input',
					'guest',
					'the crossing wall must be an integer from 0 to 4294967295 ms'
				)
			);
		const open = yield* Ref.make(true);
		yield* Effect.addFinalizer(() => Ref.set(open, false));
		const execute = (
			program: GuestProgram | undefined,
			invocation: Invocation,
			bridge: Bridge,
			parts?: readonly GuestPart[]
		): Effect.Effect<readonly GuestOutcome[]> => {
			const every = (outcome: GuestOutcome) => (parts ?? [null]).map(() => outcome);
			return Effect.gen(function* () {
				if (!(yield* Ref.get(open)))
					return every({
						kind: 'failed',
						error: BoltError.make(
							'interrupted',
							'guest',
							'the invocation was interrupted: its generation is draining'
						)
					});
				const work = Effect.scoped(
					Effect.gen(function* () {
						if (program === undefined)
							return every({
								kind: 'failed',
								error: BoltError.make('no_guest', 'guest', 'the workspace has no guest program')
							});
						const events = yield* telemetry.open({
							invocation: invocation.id,
							run: invocation.run
						});
						// Only tenant-declared values cross into server code; never an ambient environment dump.
						const secrets = Object.fromEntries(
							(yield* Effect.forEach(Object.keys(manifest.workspace.secrets ?? {}), (name) =>
								Config.option(Config.String(name)).pipe(
									Effect.provideService(ConfigProvider.ConfigProvider, configuration),
									Effect.mapError(() =>
										BoltError.make(
											'unavailable',
											'facility',
											'Workspace secrets could not be loaded.'
										)
									),
									Effect.map((value) =>
										Option.isSome(value) ? [[name, value.value] as const] : []
									)
								)
							)).flat()
						);
						return yield* run(
							isolates.open(program, {
								prelude: PRELUDE,
								seed: invocation.ctx.seed,
								memory_mib: limits.memory_mib
							}),
							program,
							manifest,
							options,
							limits,
							events,
							invocation,
							bridge,
							secrets,
							parts
						);
					})
				);
				return yield* Effect.acquireUseRelease(
					work.pipe(Effect.forkIn(generation)),
					Fiber.join,
					Fiber.interrupt
				);
			}).pipe(Effect.catch((error) => Effect.succeed(every({ kind: 'failed', error }))));
		};
		const one = (outcomes: readonly GuestOutcome[]): GuestOutcome =>
			outcomes[0] ?? {
				kind: 'failed',
				error: BoltError.make('internal', 'guest', 'the guest answered nothing')
			};
		return Guest.of({
			invoke: (invocation, bridge) =>
				execute(Option.getOrUndefined(activation.guest), invocation, bridge).pipe(Effect.map(one)),
			invokeEach: (invocation, parts, bridge) =>
				execute(
					Option.getOrUndefined(activation.guest),
					{ ...invocation, target: parts.map((part) => part.target).join(' '), input: null },
					bridge,
					parts
				),
			invokeProgram: (program, invocation, bridge) =>
				execute(program, invocation, bridge).pipe(Effect.map(one))
		});
	})
);
