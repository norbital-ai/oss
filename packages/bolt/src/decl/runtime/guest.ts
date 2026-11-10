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
// Wire decimals must revive even when a body only uses methods on its typed input.
import '@norbital-ai/std/decimal';
import { attached, type Body } from '../body.ts';
import type { BodyError } from '../ctx.ts';
import { Refusal } from '../errors/refusal.ts';
import { Verdict } from '../access/policy.ts';
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
		// every query is one read request; a runtime-built one (`dynamicRead`) fails with `ReadFailed`
		const failureFamily =
			family === 'engine' && (member === 'query' || member === 'db.query') ? 'read' : family;
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
		readonly path?: string | undefined;
	}
): Effect.Effect<never, Refusal> => {
	const failure = { message: String(message), field: at?.field, row: at?.row, path: at?.path };
	return Effect.fail(new Refusal(failure));
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
		today_in: (zone: string) =>
			new Intl.DateTimeFormat('en-CA', {
				timeZone: zone,
				year: 'numeric',
				month: '2-digit',
				day: '2-digit'
			}).format(new Date(String(raw['now'])))
	};
	const reads = {
		query: cross('query'),
		aggregate: cross('aggregate'),
		history: cross('history')
	};
	const writes = {
		act: Object.assign(cross('act', 'act'), {
			many: cross('acts', 'act'),
			checked: cross('acts', 'act')
		}),
		schedule: cross('schedule'),
		notify: cross('notify')
	};
	const actor = { actor: raw['actor'], invocation_id: raw['invocation_id'] };
	const policies = isArray(raw['policies'])
		? Object.freeze([...raw['policies']])
		: Object.freeze([]);
	const workspace = { query: cross('db.query'), aggregate: cross('db.aggregate') };
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
				carried_by: typeof raw['carriedBy'] === 'string' ? raw['carriedBy'] : null,
				approving: raw['approving'] === true,
				refuse,
				...workspace,
				query: Object.assign(workspace.query, { after: cross('db.after') })
			};
		case 'notify':
			return { ...clock, ...actor, ...workspace };
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
				...clock,
				...actor,
				...reads,
				...writes,
				refuse,
				cause: raw['cause'],
				// an automation run's id and trigger; an effect has none
				...(raw['run'] === undefined ? {} : { run: raw['run'] }),
				approvals: { withdraw: cross('approvals.withdraw', 'act') },
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
				convert: {
					document: cross('convert.document', 'facility'),
					ingest: cross('convert.ingest', 'facility')
				},
				browser: {
					navigate: cross('browser.navigate', 'facility'),
					snapshot: cross('browser.snapshot', 'facility'),
					act: cross('browser.act', 'facility'),
					evaluate: cross('browser.evaluate', 'facility'),
					download: cross('browser.download', 'facility'),
					close: cross('browser.close', 'facility')
				},
				ai: {
					sys_1: { decide: cross('ai.sys_1.decide', 'facility') },
					sys_2: { infer: cross('ai.sys_2.infer', 'facility') },
					embed: cross('ai.embed', 'facility')
				},
				geo: { search: cross('geo.search', 'facility'), reverse: cross('geo.reverse', 'facility') }
			};
		case 'integration':
			return { configuration: instance.configuration, request: instance.request };
		default:
			return raw;
	}
};

/** A yield is a microtask, never the prelude's zero-delay timer (each of which is a `take()` round trip). */
const scheduler = new Scheduler.MixedScheduler('sync');
/** The one edge per invocation: one `runPromiseExit`, the body's output or its `finalOf` as the prelude's answer. */
export const runBody = <O>(body: () => Effect.fn.Return<O, BodyError>): Promise<O> =>
	Effect.runPromiseExit(
		Effect.gen(body).pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromUnknown(
					(globalThis as { readonly [key: symbol]: unknown })[
						Symbol.for('norbital.bolt.secrets')
					] ?? {}
				)
			)
		),
		{ scheduler }
	).then((exit) => {
		if (Exit.isSuccess(exit)) return exit.value;
		return import('./guest-failure.ts').then(({ finalOf }) => {
			throw finalOf(exit.cause);
		});
	});

/** A generator body as the prelude calls it: its ctx argument (at `at`) lifted, its run one `runBody`. */
const wrap = (body: Body, at: number): Body => {
	if (Object.prototype.toString.call(body) !== '[object GeneratorFunction]')
		throw new Error(
			`a ctx-bearing body must be a generator function, function* (…): ${String(body).slice(0, 120)}`
		);
	const gen = body as (...args: readonly unknown[]) => Effect.fn.Return<unknown, BodyError>; // checked above
	const wrapped = (...args: readonly unknown[]) => {
		const call = (globalThis as { readonly [CALL]?: Call })[CALL] ?? outside;
		const invoke = () => gen(...args.map((arg, i) => (i === at ? lift(call, arg) : arg)));
		const ctx = args[at];
		if (!Predicate.isObject(ctx) || ctx[CTX] !== 'policy') return runBody(invoke);
		// A policy refusal is one arm's denial. Other admitting arms still get their verdict.
		return runBody(function* () {
			return yield* Effect.gen(invoke).pipe(
				Effect.map(Verdict.dataOf),
				Effect.catchIf(
					(error): error is Refusal => error instanceof Refusal,
					({ message, field, row, path }) =>
						Effect.succeed({
							kind: 'deny' as const,
							message,
							at: {
								...(field === undefined ? {} : { field }),
								...(row === undefined ? {} : { row }),
								...(path === undefined ? {} : { path })
							}
						})
				)
			);
		});
	};
	Object.defineProperty(wrapped, 'name', { value: body.name });
	return Object.defineProperty(wrapped, Symbol.for('norbital.bolt.generator'), { value: body });
};
/** Wires the edge into attach: a bundle that carries it calls this before any of its bodies attach. */
export const install = (): void => {
	attached.wrap = wrap;
};
