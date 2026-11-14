// The guest edge (D8, B.3): the one runtime per body invocation (A.3), bundled into guest.mjs only beside a generator
// body (`install` wires it into attach, `../body.ts`). A generator body runs through `runBody` over the lifted ctx:
// each member an uninterruptible Effect that crosses through the prelude's `call` with the author's call site, captured
// when the member is called. Avoid module-scope workflow construction in the guest prelude.
import * as Effect from 'effect/Effect';
import * as ConfigProvider from 'effect/ConfigProvider';
import { isArray } from 'effect/Array';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Scheduler from 'effect/Scheduler';
import * as Schema from 'effect/Schema';
import * as DateTime from 'effect/DateTime';
import { equal_json } from '@norbital-ai/store/kind';
import { attached, type AttachedBody, type GeneratorBody } from '../body.ts';
import type { BodyError, BodyReturn } from '../ctx.ts';
import { Refusal } from '../errors/refusal.ts';
import { Verdict, type VerdictData } from '../access/policy.ts';
import { act_failure_tag } from '../errors/act-failure-tag.ts';
import type { FacilityMember } from './facility-members.ts';

/** The prelude's raw crossing: member, args and the author's captured call site. */
type Call = (member: string, args: readonly unknown[], site: string) => Promise<unknown>;
const CALL: unique symbol = Symbol.for('norbital.bolt.call');
const CTX: unique symbol = Symbol.for('norbital.bolt.ctx');
const SECRETS: unique symbol = Symbol.for('norbital.bolt.secrets');
const outside: Call = () =>
	Promise.reject(new Error('a generator body runs inside the guest prelude only'));

type Family = 'engine' | 'act' | 'facility' | 'read';
const engineFault = (error: unknown): unknown => {
	if (!Predicate.hasProperty(error, 'kind') || error.kind !== 'bolt') return error;
	const fault = new Error(
		Predicate.hasProperty(error, 'message') ? String(error.message) : 'engine failed'
	);
	fault.name = 'BoltError';
	return Object.assign(fault, {
		code: Predicate.hasProperty(error, 'code') ? error.code : 'internal'
	});
};
const FAILED = {
	engine: (error: unknown) => Effect.die(engineFault(error)),
	read: (error: unknown) =>
		Effect.promise(() => import('../errors/read.ts')).pipe(
			Effect.flatMap(({ read_failure }) =>
				Option.match(read_failure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		),
	act: (error: unknown) =>
		Effect.promise(() => import('../errors/act.ts')).pipe(
			Effect.flatMap(({ act_failure }) =>
				Option.match(act_failure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		),
	facility: (error: unknown) =>
		Effect.promise(() => import('../errors/facility.ts')).pipe(
			Effect.flatMap(({ facility_failure }) =>
				Option.match(facility_failure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		)
};
const READS = new Set(['query', 'db.query', 'history']);
type CrossingFailure = Effect.Error<ReturnType<(typeof FAILED)[Family]>>;
/**
 * One member as an Effect: uninterruptible, so a sibling's failure never leaves its queued or in-flight call `unawaited`;
 * nothing crosses until the Effect runs (an unyielded call makes no crossing).
 */
const lifted = (call: Call, member: string, family: Family) => {
	const cross = (...args: readonly unknown[]): Effect.Effect<unknown, CrossingFailure> => {
		// every read (a request, a record's history) fails with `ReadFailed`
		const failureFamily = family === 'engine' && READS.has(member) ? 'read' : family;
		const at: { stack?: string } = {};
		Error.captureStackTrace(at, cross); // the author's frame: by the time the Effect runs the stack is the fiber's
		const site = at.stack?.split('\n')[1]?.trim() ?? 'unknown';
		return Effect.uninterruptible(
			Effect.callback<unknown, CrossingFailure>((resume) => {
				call(member, args, site).then(
					(value) =>
						resume(
							family === 'act'
								? Effect.suspend<unknown, CrossingFailure, never>(() =>
										act_failure_tag(value) === undefined
											? Effect.succeed(value)
											: Effect.promise(() => import('../errors/act.ts')).pipe(
													Effect.flatMap(({ act_failure }) => {
														const failure = act_failure(value);
														return Option.isSome(failure)
															? Effect.fail(failure.value)
															: Effect.succeed(value);
													})
												)
									)
								: Effect.succeed(value)
						),
					(error: unknown) => resume(FAILED[failureFamily](error))
				);
			})
		);
	};
	return cross;
};
const refuse = (
	message: unknown,
	at?: {
		readonly field?: string | undefined;
		readonly row?: number | undefined;
		readonly values?: Refusal['values'];
	}
): Effect.Effect<never, Refusal> =>
	Effect.fail(new Refusal({ message: String(message), values: at?.values, field: at?.field, row: at?.row }));
const RowChange = Schema.Struct({
	before: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
	set: Schema.Record(Schema.String, Schema.Unknown),
	after: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))
});
const changesOf = (input: unknown) => Schema.decodeUnknownSync(Schema.Array(RowChange))(input).map((change) => ({
	...change,
	changed: (...fields: readonly string[]) => {
		const names = fields.length === 0
			? Object.keys({ ...change.before, ...change.after })
			: fields;
		return names.some((field) => !equal_json(change.before?.[field], change.after?.[field]));
	}
}));
/** Builds only the members that this invocation kind admits; the prelude carries no ctx functions. */
const lift = (call: Call, raw: unknown): unknown => {
	if (!Predicate.isObject(raw)) return raw;
	const kind = raw[CTX];
	const cross = (member: string, family: Family = 'engine') => lifted(call, member, family);
	const facility = (member: FacilityMember) => cross(member, 'facility');
	const clock = {
		now: raw['now'],
		today: raw['today'],
		tz: raw['tz'],
		today_in: (zone: string) =>
			DateTime.formatIsoDate(DateTime.makeZonedUnsafe(String(raw['now']), { timeZone: zone }))
	};
	const reads = {
		query: cross('query'),
		history: cross('history')
	};
	const writes = {
		act: cross('act', 'act'),
		schedule: cross('schedule'),
		notify: cross('notify')
	};
	const actor = { actor: raw['actor'], invocation_id: raw['invocation_id'] };
	const policies = isArray(raw['policies'])
		? Object.freeze([...raw['policies']])
		: Object.freeze([]);
	const workspace = { query: cross('db.query') };
	// a sync body's instance: its configuration, `request` through it, and `send` (a conversation driver's message)
	const instance = {
		configuration: raw['configuration'] ?? {},
		request: cross('request', 'facility'),
		send: cross('send', 'facility')
	};
	switch (kind) {
		case 'create':
		case 'update':
		case 'delete':
			return {
				...clock,
				...actor,
				policies,
				admin: raw['admin'] === true,
				approving: raw['approving'] === true,
				refuse,
				...workspace
			};
		case 'syncRead':
			return { ...clock, ...actor, ...workspace, refuse, ...instance };
		case 'syncWrite':
			return {
				...clock,
				...actor,
				...workspace,
				refuse,
				...instance,
				...(raw['fileExport'] === true
					? {
							files: {
								get: cross('files.get', 'facility'),
								image: cross('files.image', 'facility')
							}
						}
					: {})
			};
		case 'parse':
			return {
				...clock,
				...actor,
				...workspace,
				refuse,
				...instance,
				files: { get: cross('files.get', 'facility') }
			};
		// a write grant's check: workspace reads and the three verdicts (decl `PolicyCtx`)
		case 'policy':
			return {
				...clock,
				...actor,
				policies,
				query: workspace.query,
				allow: Verdict.allow,
				refuse,
				approve: Verdict.approve
			};
		case 'page':
			return { ...clock, ...actor, ...reads };
		case 'tool':
			return {
				...clock,
				...actor,
				...reads,
				...writes,
				refuse,
				policies,
				admin: raw['admin'] === true,
				target: raw['row']
			};
		case 'automation':
		case 'effect':
			return {
				...(kind === 'effect' ? { event: raw['event'] } : {}),
				...clock,
				...actor,
				...reads,
				...writes,
				refuse,
				attempt: raw['attempt'],
				// an automation's trigger with its run id (a call has no id); an effect has none
				...(Predicate.isObject(raw['run']) && Predicate.isObject(raw['run']['trigger'])
					? {
							trigger: {
								...raw['run']['trigger'],
								...(raw['run']['id'] === undefined ? {} : { id: raw['run']['id'] })
							}
						}
					: {}),
				// a job's run waits durably; a call or an effect has no run to wait in
				...(kind === 'automation' && Predicate.isObject(raw['run']) && raw['run']['id'] !== undefined
					? { wait: cross('wait') }
					: {}),
				send: cross('send'),
				progress: cross('progress'),
				request: cross('request', 'facility'),
				web: { read: facility('web.read') },
				files: {
					meta: facility('files.meta'), get: facility('files.get'), url: facility('files.url'),
					image: facility('files.image'), put: facility('files.put')
				},
				convert: {
					document: facility('convert.document'),
					record: facility('convert.record'),
					ingest: facility('convert.ingest')
				},
				browser: {
					navigate: facility('browser.navigate'),
					snapshot: facility('browser.snapshot'),
					act: facility('browser.act'),
					evaluate: facility('browser.evaluate'),
					download: facility('browser.download'),
					close: facility('browser.close')
				},
				ai: {
					sys_1: { decide: facility('ai.sys_1.decide') },
					sys_2: { infer: facility('ai.sys_2.infer') },
					embed: facility('ai.embed')
				},
				geo: { search: facility('geo.search'), reverse: facility('geo.reverse') }
			};
		case 'integration':
			return { configuration: instance.configuration, request: instance.request };
		// a definition's webhook handler: reads and acts as the webhook's policies
		case 'webhook':
			return {
				...clock,
				...actor,
				...reads,
				act: writes.act,
				refuse,
				instance: raw['instance'],
				configuration: instance.configuration
			};
		default:
			return raw;
	}
};

/** A yield is a microtask, never the prelude's zero-delay timer (each of which is a `take()` round trip). */
const scheduler = new Scheduler.MixedScheduler('sync');
/** Check foreign JavaScript producers without replacing Effect's iterator, failure or cancellation machinery. */
const body_effect = <O>(body: () => BodyReturn<O>): Effect.Effect<O, BodyError> =>
	Effect.gen(function* () {
		const iterator = body();
		const candidate: unknown = iterator;
		if (!Predicate.isObject(candidate) || typeof candidate['next'] !== 'function')
			throw new TypeError('a declaration body must return a generator iterator');
		let step = iterator.next();
		for (;;) {
			const result: unknown = step;
			if (!Predicate.isObject(result) || typeof result['done'] !== 'boolean' || !('value' in result))
				throw new TypeError('a declaration body returned an invalid iterator result');
			if (step.done) return step.value;
			const effect = step.value;
			const yielded: unknown = effect;
			if (!Effect.isEffect(yielded))
				throw new TypeError('a declaration body must yield Effects; use yield* for effectful operations');
			step = iterator.next(yield* effect);
		}
	});
/** The one edge per invocation: one `runPromiseExit`, the body's output or its `finalOf` as the prelude's answer. */
export const runBody = <O>(body: () => BodyReturn<O>): Promise<O> => {
	const secrets: unknown = Reflect.get(globalThis, SECRETS);
	return Effect.runPromiseExit(
		body_effect(body).pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown(secrets ?? {})
			)
		),
		{ scheduler }
	).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		return import('./guest-failure.ts').then(({ finalOf }) => {
			throw finalOf(exit.cause);
		});
	});
};

/** Raw invocation arguments are prepared only at the prelude's unknown module boundary. */
const prepare_args = (args: readonly unknown[], at: number): readonly unknown[] => {
	const hook: unknown = Reflect.get(globalThis, CALL);
	const call: Call = (...args) => {
		if (typeof hook !== 'function') return outside(...args);
		const answer: unknown = hook(...args);
		return Promise.resolve(answer);
	};
	const ctx = args[at];
	const kind = Predicate.isObject(ctx) ? ctx[CTX] : undefined;
	const changes = ['create', 'update', 'delete', 'effect', 'policy'].includes(String(kind))
		? changesOf(args[0])
		: undefined;
	return args.map((arg, i) => i === at
		? lift(call, arg)
		: i === 0 && changes !== undefined ? changes : arg);
};
/** The generator tag supplies the authoring diagnostic; the typed producer and body_effect own execution proof. */
const described_body = <A extends readonly unknown[], W>(
	body: GeneratorBody<A>, wrapped: AttachedBody<A, W>, at: number
): AttachedBody<A, W> => {
	if (Object.prototype.toString.call(body) !== '[object GeneratorFunction]')
		throw new Error(
			`a ctx-bearing body must be a generator function, function* (…): ${String(body).slice(0, 120)}`
		);
	Object.defineProperty(wrapped, 'name', { value: body.name });
	Object.defineProperty(wrapped, Symbol.for('norbital.bolt.prepare'), {
		value: (args: readonly unknown[]) => prepare_args(args, at)
	});
	return Object.defineProperty(wrapped, Symbol.for('norbital.bolt.generator'), { value: body });
};
/** A typed producer runs with its original tuple and returns its exact result. */
const wrap = <A extends readonly unknown[], O>(
	body: GeneratorBody<A, O>, at: number
): AttachedBody<A, O> => described_body(body, (...args: A) => runBody(() => body(...args)), at);

/** Policy values have their own typed native boundary rather than claiming the authored result is unchanged. */
const wrap_verdict = <A extends readonly unknown[]>(
	body: GeneratorBody<A, Verdict>, at: number
): AttachedBody<A, VerdictData> => described_body(body, (...args: A) =>
		// A policy refusal is one arm's refusal. Other admitting arms still get their verdict.
		runBody(function* () {
			return yield* body_effect(() => body(...args)).pipe(
				Effect.map(Verdict.dataOf),
				Effect.catchIf(
					(error): error is Refusal => error instanceof Refusal,
					({ message, values, field, row }) =>
						Effect.succeed({
							kind: 'refuse' as const,
							message,
							...(values === undefined ? {} : { values }),
							at: { ...(field === undefined ? {} : { field }), ...(row === undefined ? {} : { row }) }
						})
				)
			);
		}), at);
/** Wires the edge into attach: a bundle that carries it calls this before any of its bodies attach. */
export const install = (): void => {
	attached.wrap = wrap;
	attached.verdict = wrap_verdict;
};
