// The guest edge (D8, B.3): the one runtime per body invocation (A.3), bundled into guest.mjs only beside a generator
// body (`install` wires it into attach, `../collection.ts`). A generator body runs through `runBody` over the lifted ctx:
// each member an uninterruptible Effect that crosses through the prelude's `call` with the author's call site, captured
// when the member is called. Avoid module-scope workflow construction in the guest prelude.
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Option from 'effect/Option';
import * as Predicate from 'effect/Predicate';
import * as Scheduler from 'effect/Scheduler';
import { attached, type Body } from '../collection.ts';
import type { BodyError } from '../ctx.ts';
import type { Refusal } from '../errors/refusal.ts';
import { actFailureTag } from '../errors/act-failure-tag.ts';

/** The prelude's raw crossing: member, args and the author's captured call site. */
type Call = (member: string, args: readonly unknown[], site: string) => Promise<unknown>;
const CALL: unique symbol = Symbol.for('norbital.bolt.call');
const CTX: unique symbol = Symbol.for('norbital.bolt.ctx');
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
			Effect.flatMap(({ readFailure }) =>
				Option.match(readFailure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		),
	act: (error: unknown) =>
		Effect.promise(() => import('../errors/act.ts')).pipe(
			Effect.flatMap(({ actFailure }) =>
				Option.match(actFailure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		),
	facility: (error: unknown) =>
		Effect.promise(() => import('../errors/facility.ts')).pipe(
			Effect.flatMap(({ facilityFailure }) =>
				Option.match(facilityFailure(error), {
					onNone: () => Effect.die(engineFault(error)),
					onSome: Effect.fail
				})
			)
		)
};
type CrossingFailure = Effect.Error<ReturnType<(typeof FAILED)[Family]>>;
/**
 * One member as an Effect: uninterruptible, so a sibling's failure never leaves its queued or in-flight call `unawaited`;
 * nothing crosses until the Effect runs (an unyielded call makes no crossing).
 */
const lifted = (call: Call, member: string, family: Family) => {
	const cross = (...args: readonly unknown[]): Effect.Effect<unknown, CrossingFailure> => {
		const failureFamily =
			family === 'engine' &&
			(member === 'read' || member === 'db.read') &&
			Predicate.isObject(args[1]) &&
			args[1]['mode'] === 'declared'
				? 'read'
				: family;
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
										actFailureTag(value) === undefined
											? Effect.succeed(value)
											: Effect.promise(() => import('../errors/act.ts')).pipe(
													Effect.flatMap(({ actFailure }) => {
														const failure = actFailure(value);
														return Option.isSome(failure)
															? Effect.fail(failure.value)
															: Effect.succeed(value);
													})
												)
									)
								: Effect.succeed(value)
						),
					(error) => resume(FAILED[failureFamily](error))
				);
			})
		);
	};
	return cross;
};
const refuse = (
	message: unknown,
	at?: { readonly field?: string | undefined }
): Effect.Effect<never, Refusal> => {
	const failure = { message: String(message), field: at?.field };
	return Effect.promise(() => import('../errors/refusal.ts')).pipe(
		Effect.flatMap(({ Refusal }) => Effect.fail(new Refusal(failure)))
	);
};
/** Builds only the members that this invocation kind admits; the prelude carries no ctx functions. */
const lift = (call: Call, raw: unknown): unknown => {
	if (!Predicate.isObject(raw)) return raw;
	const kind = (raw as { readonly [CTX]?: string })[CTX];
	const cross = (member: string, family: Family = 'engine') => lifted(call, member, family);
	const clock = {
		now: raw['now'],
		today: raw['today'],
		tz: raw['tz'],
		todayIn: (zone: string) =>
			new Intl.DateTimeFormat('en-CA', {
				timeZone: zone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit'
			}).format(new Date(String(raw['now'])))
	};
	const reads = {
		read: cross('read'),
		get: cross('get'),
		aggregate: cross('aggregate'),
		similar: cross('similar'),
		history: cross('history'),
		query: cross('query')
	};
	const writes = {
		act: Object.assign(cross('act', 'act'), { many: cross('acts', 'act') }),
		schedule: cross('schedule'),
		notify: cross('notify')
	};
	const actor = { actor: raw['actor'], invocationId: raw['invocationId'] };
	const policies = Array.isArray(raw['policies'])
		? Object.freeze([...raw['policies']])
		: Object.freeze([]);
	switch (kind) {
		case 'transform':
			return {
				...clock,
				...actor,
				policies,
				admin: raw['admin'] === true,
				refuse,
				existing: Array.isArray(raw['existing'])
					? raw['existing'].map((row) => (row === null ? undefined : row))
					: [],
				staged: Object.freeze(
					Array.isArray(raw['staged'])
						? raw['staged'].map(
								(row: { readonly path: readonly unknown[]; readonly parent?: object }) =>
									Object.freeze({
										...row,
										path: Object.freeze([...row.path]),
										...(row.parent === undefined
											? {}
											: { parent: Object.freeze({ ...row.parent }) })
									})
							)
						: []
				),
				db: {
					read: cross('db.read'),
					get: cross('db.get'),
					aggregate: cross('db.aggregate'),
					after: cross('db.after'),
					prepareCreate: cross('db.prepareCreate')
				}
			};
		case 'projection':
			return {
				...clock,
				...actor,
				...reads,
				refuse,
				admin: raw['admin'] === true,
				policies,
				fields: Object.freeze(Array.isArray(raw['fields']) ? [...raw['fields']] : [])
			};
		case 'query':
			return { ...clock, ...actor, ...reads, refuse };
		case 'page':
			return { ...clock, ...actor, ...reads };
		case 'action':
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
			return {
				...clock,
				...actor,
				...reads,
				...writes,
				cause: raw['cause'],
				send: cross('send'),
				progress: cross('progress'),
				request: cross('request', 'facility'),
				web: { read: cross('web.read', 'facility') },
				files: Object.fromEntries(
					['meta', 'get', 'url', 'text', 'table', 'sheet', 'image', 'put'].map((name) => [
						name,
						cross(`files.${name}`, 'facility')
					])
				),
				convert: { document: cross('convert.document', 'facility') },
				ai: {
					sys_1: { decide: cross('ai.sys_1.decide', 'facility') },
					sys_2: { infer: cross('ai.sys_2.infer', 'facility') },
					embed: cross('ai.embed', 'facility'),
					transcribe: cross('ai.transcribe', 'facility'),
					speak: cross('ai.speak', 'facility')
				},
				geo: { search: cross('geo.search', 'facility'), reverse: cross('geo.reverse', 'facility') }
			};
		case 'integration':
			return {
				...clock,
				read: reads.read,
				get: reads.get,
				instance: raw['instance'],
				partition: raw['partition'] ?? null,
				...(raw['key'] === undefined ? {} : { key: raw['key'] }),
				configuration: raw['configuration'] ?? {},
				request: cross('request', 'facility')
			};
		case 'pipeline':
			return { ...clock, read: reads.read, get: reads.get, aggregate: reads.aggregate };
		default:
			return raw;
	}
};

/** A yield is a microtask, never the prelude's zero-delay timer (each of which is a `take()` round trip). */
const scheduler = new Scheduler.MixedScheduler('sync');
/** The one edge per invocation: one `runPromiseExit`, the body's output or its `finalOf` as the prelude's answer. */
export const runBody = <O>(body: () => Effect.fn.Return<O, BodyError>): Promise<O> =>
	Effect.runPromiseExit(Effect.gen(body), { scheduler }).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		return import('./guest-failure.ts').then(({ finalOf }) => {
			throw finalOf(exit.cause);
		});
	});

/** A generator body as the prelude calls it: its ctx argument (at `at`) lifted, its run one `runBody`. */
const wrap = (body: Body, at: number): Body => {
	if (Object.prototype.toString.call(body) !== '[object GeneratorFunction]')
		throw new Error('a ctx-bearing body must be a generator function');
	const gen = body as (...args: readonly unknown[]) => Effect.fn.Return<unknown, BodyError>; // checked above
	const wrapped = (...args: readonly unknown[]) => {
		const call = (globalThis as { readonly [CALL]?: Call })[CALL] ?? outside;
		return runBody(() => gen(...args.map((arg, i) => (i === at ? lift(call, arg) : arg))));
	};
	Object.defineProperty(wrapped, 'name', { value: body.name });
	return Object.defineProperty(wrapped, Symbol.for('norbital.bolt.generator'), { value: body });
};
/** Wires the edge into attach: a bundle that carries it calls this before any of its bodies attach. */
export const install = (): void => {
	attached.wrap = wrap;
};
