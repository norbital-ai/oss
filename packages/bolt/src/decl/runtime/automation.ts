// An automation's source path supplies its name. The run body infers its input and output from its literal.
import { Schema } from 'effect';
import type { Actor } from '../access/actor.ts';
import { attached, type AgentUse, type Body } from '../body.ts';
import type { Act, BodyReturn, CallerQuery, Clock, Eff, Refuse } from '../ctx.ts';
import type {
	Checked,
	Exact,
	Simplify,
	ValidOutput,
	OutputKind,
	ValueOf
} from '../fields.ts';
import type { ModelName, PolicyName, ReadableName, Row } from '../names.ts';
import type { Duration, IanaZone, Id, Instant, NonEmpty, RequestId } from '../values.ts';
import type { Where } from '../where.ts';
import type { ApprovalStateSchema } from '../../protocol/approval-view.ts';
type ApprovalState = typeof ApprovalStateSchema.Type;
import type { ApprovalEffectEvent } from '../../protocol/effect-events.ts';
import type {
	Ai,
	ApprovalRecipient,
	Browser,
	Convert,
	Files,
	Geo,
	Notify,
	Recipient,
	Request,
	RunTrigger,
	EventTrigger,
	Schedule,
	Send,
	Web
} from './facilities.ts';
import type { AutomationInputFields, AutomationInputOf, ValidAutomationInputs } from './automation-input.ts';

type Macro = '@yearly' | '@annually' | '@monthly' | '@weekly' | '@daily' | '@hourly';
type Fields<S, N extends unknown[] = [0]> = S extends `${string} ${infer R}`
	? Fields<R, [...N, 0]>
	: N['length'];
/** Five space-separated fields or a macro (tsc checks the count; the build parses the fields). */
export type Cron<S> = S extends Macro
	? S
	: Fields<S> extends 5
		? S
		: 'error: a cron is 5 fields or a macro';
export const DeclaredDuration = Schema.TemplateLiteral([
	Schema.BigInt,
	Schema.Literals(['s', 'min', 'h', 'd'])
]);
/** A cron schedule. */
export const CronTriggerSpec = Schema.Struct({
	cron: Schema.String,
	tz: Schema.optionalKey(Schema.String),
	rest: Schema.optionalKey(DeclaredDuration)
});
/** A committed write to a model, template or system (`sys_user`, `sys_invitation`, …): see `AutomationSpec.on`. */
export const WriteTriggerSpec = Schema.Struct({
	model: Schema.String,
	verbs: Schema.NonEmptyArray(Schema.Literals(['create', 'update', 'delete']))
});
export const TriggerSpec = Schema.Union([CronTriggerSpec, WriteTriggerSpec]);
export type Trigger = typeof TriggerSpec.Type;
type WriteVerb = 'create' | 'update' | 'delete';
type ValidTrigger<T> = T extends { cron: infer S }
	? { cron: Cron<S>; tz?: IanaZone; rest?: Duration }
	: T extends { model: unknown }
		? { model: ReadableName; verbs: NonEmpty<WriteVerb> }
		: Trigger;

type Attempts = 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Max = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
/**
 * `job` (the default) queues a durable run; `call` is the page RPC: a page's `run` executes it in the request and
 * answers its declared output (the one request/response path from a page to server code). Server code never starts a
 * call; it calls the same `src/lib` function directly.
 */
type AutomationMode =
	| { mode?: 'job' }
	| { mode: 'call'; on?: never; retry?: never; concurrency?: never };
/** An automation literal's data: what the manifest holds (the `run` body is not data). */
export type AutomationSpec = AutomationMode & {
	description: string;
	/** The typed input a start or schedule passes. */
	input?: AutomationInputFields;
	/** The typed result returned by a call or recorded on a job. */
	output?: OutputKind;
	/**
	 * What starts it besides an explicit start; absent means started only. `{ cron }` fires on a schedule.
	 * `{ model, verbs }` fires after a committed write of one of `verbs` to `model`, a template model or a system one
	 * alike (`sys_user`: a sign-up, an accepted invitation, a team or handle change; `sys_invitation`: sent, resent,
	 * accepted, revoked). The run executes as the reserved system identity with `policies`, never the writer's
	 * authority, so the follow-up needs nothing from the person who wrote. One committed statement queues one run per
	 * automation and verb, in that statement (durable, never per row); `ctx.trigger` is
	 * `{ kind: 'system', cause: 'event', model, verb, records }` with the written ids, and the body reads the rows it needs.
	 * The run takes no input. A write held for approval emits when the approving decision commits it, with each held
	 * record's net verb; a rejected or withdrawn one emits nothing. Every write a run makes, identity ones included,
	 * chains one deeper; a write that would queue a run past depth 8 (`LIMITS.writeDepth`) is refused.
	 * A model's own reaction to its writes stays its `effect`.
	 * @example on: [{ model: 'sys_user', verbs: ['create', 'update'] }]
	 */
	on?: readonly Trigger[];
	/**
	 * The policies every run holds, whoever or whatever starts it: a run executes as the reserved system identity, and
	 * who triggered it (`ctx.trigger`) never changes its authority.
	 */
	policies: NonEmpty<string>;
	/**
	 * Retries of a failed run, only for a transient failure: a refusal or a bug is final. `attempts` counts every run,
	 * the first included, so `1` never retries. `backoff` (default `10s`) doubles each attempt, up to an hour, with jitter.
	 */
	retry?: { attempts: Attempts; backoff?: Duration };
	/**
	 * At most `max` runs of this automation at once; absent, one. The rest wait queued. A host runs as many runs at
	 * once as the sum of its automations' `max`.
	 */
	concurrency?: { max: Max };
	/** How the agent may start it (`direct`, `confirm`, `never`). */
	agent?: AgentUse;
};
type AutomationFor<S, Body> = AutomationMode & {
	description: string;
	input?: S extends { input: infer I } ? ValidAutomationInputs<I> : AutomationInputFields;
	output?: S extends { output: infer O } ? ValidOutput<O> : OutputKind;
	on?: S extends { on: infer O extends readonly Trigger[] }
		? { [I in keyof O]: ValidTrigger<O[I]> }
		: never;
	policies: NonEmpty<PolicyName>;
	retry?: { attempts: Attempts; backoff?: Duration };
	concurrency?: { max: Max };
	agent?: AgentUse;
	run: Body;
};

// ── the run's input and ctx ──
/** What `run` receives: the declared input (a cron run without one receives `{}`). */
export type RunInput<S> = Simplify<S extends { input: infer I } ? AutomationInputOf<I> : {}>;
/** What `run` returns: the declared output. */
export type RunOutput<S> = S extends { output: infer O } ? ValueOf<O> : void;

/**
 * `run`'s ctx: reads (`ctx.query`), writes and schedules as its `policies`; the only place for I/O. A failed
 * `yield*` ends the body: `try`/`catch` never sees it (`bolt check` refuses one), so recover with `Effect.catch` or
 * `Effect.catchTag` on the yielded Effect (`yield* ctx.browser.download(url, options).pipe(Effect.catch(...))`). `actor`
 * is the reserved system identity; `trigger` records who or what started the run and, for a job, its run `id`. Code
 * acting for a starter checks it explicitly (`trigger.kind === 'person'`, then their id, party or teams against the
 * rows it touches).
 */
export type AutomationCtx<S = AutomationSpec> = RunCtx<Extract<Actor, { kind: 'system' }>, true, Recipient> & {
	readonly trigger: TriggerOf<S> & (S extends { mode: 'call' } ? {} : { readonly id: Id<'sys_run'> });
} & (S extends { mode: 'call' } ? {} : { wait: Wait });
/** What woke a wait: its deadline `until` (`at`), a write on the waited model (`records`), or the approval's decision. */
export type Woke<M extends string = never> =
	| { readonly kind: 'time'; readonly at: Instant }
	| { readonly kind: 'event'; readonly model: M; readonly records: readonly Id<M>[] }
	| { readonly kind: 'approval'; readonly request: RequestId; readonly state: ApprovalState };
/**
 * Waits durably, holding no lane and waking nothing while it waits: until the instant `until`; until a write commits
 * to `model` (one of `verbs`, any by default) whose written rows match `where`, read as the run's policies; or until
 * approval request `approval` is decided. An event wait may take `until` too, and answers `time` when it passes first.
 * A wait already met answers at once: a decided approval, a passed `until`; a write counts from the wait on.
 *
 * The run resumes across restarts and releases by running its body again from the start with the same input, clock
 * (`ctx.now` stays the run's first) and random seed: every call before the wait answers what it answered then
 * (reads, acts, sends, inference) without running again, so the code before a wait must make the same calls. A body
 * changed under a waiting run fails it (`diverged`). At most `LIMITS.waitBytes` (4 MiB) of earlier answers are kept.
 * Job runs only: a call or a model effect has no run to wait in.
 * @example
 * const held = yield* ctx.act({ 'quotes.update': [{ target: quote, set: { state: 'review' } }] });
 * if (held.kind === 'pending_approval') {
 * 	const until = DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(ctx.now), { days: 3 }));
 * 	const woke = yield* ctx.wait({ approval: held.request_id, until });
 * 	if (woke.kind === 'time') yield* ctx.schedule('remind_reviewers', { quote: quote.id });
 * }
 */
export interface Wait {
	(on: { readonly until: Instant }): Eff<Extract<Woke, { kind: 'time' }>>;
	<const M extends ReadableName>(on: {
		readonly model: M;
		readonly where?: Where<M>;
		readonly verbs?: NonEmpty<WriteVerb>;
		readonly until?: Instant;
	}): Eff<Exclude<Woke<M>, { kind: 'approval' }>>;
	(on: { readonly approval: RequestId; readonly until?: Instant }): Eff<Exclude<Woke, { kind: 'event' }>>;
}
/** The triggers a run of `S` can carry: an event only from a declared listener, narrowed to its model and verbs. */
type TriggerOf<S> =
	| Exclude<RunTrigger, { cause: 'event' }>
	| (S extends { on: readonly (infer T)[] }
			? T extends { model: infer M extends string; verbs: readonly (infer V extends WriteVerb)[] }
				? EventTrigger<M, V>
				: never
			: never);
type RunCtx<A, Tools extends boolean, To> = Omit<Clock, 'actor'> &
	CallerQuery & { invocation_id: string } & {
		actor: A;
		/** 1 on the first attempt. */
		attempt: number;
		progress(update: { ratio?: number | null; text?: string | null }): Eff<void>;
		act: Act;
		/** Stops the current body with an authored refusal; `row` and `field` name the input list row and field. */
		refuse: Refuse<{ field?: string; row?: number }>;
		schedule: Schedule;
		notify: Notify<To>;
		send: Send;
		request: Request;
		web: Web;
		files: Files;
		/** This run's own browser tab; it closes when the run's scope ends. */
		browser: Browser;
		/** Markdown or HTML to a declared document format (optional host capability; absent → `unavailable`). */
		convert: Convert;
		ai: Ai<Tools>;
		geo: Geo;
	};
/** What started a model `effect`: a committed write, or an approval move with its request, records and requester. */
export type EffectEvent<M = ModelName> =
	| { readonly kind: 'write' }
	| (Omit<ApprovalEffectEvent, 'request' | 'records' | 'requester'> & {
		readonly request: RequestId;
		readonly records: readonly { readonly id: Id<M & string>; readonly row: Readonly<Partial<Row<M>>> | null }[];
		readonly requester: Id<'sys_user'> | null;
	});
/**
 * A model `effect`'s ctx (`create.effect`, `update.effect`, `delete.effect`): an automation run's facilities, as the
 * writer whose committed write ran it (member, envoy, visitor or automation run, with that authority); an effect holds
 * no policy of its own and its `ai` has no host tools. Each committed batch queues one durable run
 * `<model>.effect.<verb>` in the write's own statement, retried for over an hour on a transient failure and never rate
 * limited; a failure never undoes the write. Changes carry `before`, `set`, `after` and `changed(...)` over the root
 * fields of the writer's output (`default` when held, else the first named output it holds; a writer holding no read
 * output of the model sees its rows as stored). An effect's writes run effects one level deeper; a write that would
 * queue one past depth 8 (`LIMITS.writeDepth`) is refused. `ctx.notify` may also address the approval's `'requester'`
 * and `'approvers'`; they resolve only when `ctx.event.kind === 'approval'`. A write held for approval freezes its changes
 * and writer until final approval releases them; rejection discards them. The writer sees its effect run's status and
 * error code; an administrator also sees its input.
 */
export type EffectCtx<M = ModelName> = RunCtx<Actor, false, Recipient | ApprovalRecipient> & {
	/** Approval moves have no committed change list; their frozen data is carried here. */
	readonly event: EffectEvent<M>;
};
type AutomationLiteral<
	I extends AutomationInputFields,
	O extends OutputKind | undefined,
	M extends 'job' | 'call',
	T extends readonly Trigger[] = readonly Trigger[]
> = Omit<AutomationSpec, 'input' | 'output' | 'mode' | 'on'> & {
	input?: I;
	output?: O;
	mode?: M;
	on?: T;
	run: (
		input: RunInput<{ input: I }>,
		ctx: AutomationCtx<{ mode: M; on: T }>
	) => BodyReturn<O extends OutputKind ? ValueOf<O> : void>;
};
/** The literal and the body the guest calls. The file supplies its name. */
export type Automation<S> = {
	readonly spec: S;
	readonly body: Body;
};

/**
 * `src/automation/+<a>.automation.ts`: a job on a trigger, or a call (a page's request/response), executed by
 * the reserved system identity with the declared `policies` (`ctx.trigger` records who started it), with typed `input` and `output`, retries and concurrency. `run` is a generator in the literal; `ctx` carries reads (`ctx.query`), `act`, files, AI and the other facilities.
 * A person's permission to start a job does not grant the job that person's authority. Check `ctx.trigger`
 * explicitly when business rules depend on the starter. A retried run's `act` answers from its earlier commit;
 * `ctx.send` and external requests can repeat.
 * Every declared automation the caller may start appears in the native Command Center Automations, with this typed
 * input rendered by `Form`; a page form is optional, not required. A start queues a run and is followed by the native
 * run status — the page does not poll or reimplement the queue.
 * @param spec Input/output contracts, execution policies, trigger and generator body.
 * @returns Declaration metadata with an attached run body; declaring it does not start a job.
 * @example
 * export default automation({
 * 	description: 'Daily sweep of lapsed quotes.',
 * 	on: [{ cron: '0 6 * * *' }],
 * 	policies: ['quote_watch'],
 * 	run: function* (_, ctx) {
 * 		const { quotes: lapsed } = yield* ctx.query({ quotes: { where: { valid_until: { lt: ctx.today } }, limit: 50 } });
 * 		yield* ctx.progress({ text: `${lapsed.rows.length} lapsed` });
 * 	}
 * });
 */
export function automation<
	const I extends AutomationInputFields = {},
	const O extends OutputKind | undefined = undefined,
	const M extends 'job' | 'call' = 'job',
	const T extends readonly Trigger[] = readonly [],
	const S extends AutomationLiteral<I, O, M, T> = AutomationLiteral<I, O, M, T>
>(
	spec: { input?: I; output?: O; mode?: M; on?: T } & S &
		NoInfer<
			Checked<
				AutomationLiteral<I, O, M, T>,
				S,
				Exact<S, AutomationFor<S, AutomationLiteral<I, O, M, T>['run']>>
			>
		>
): Automation<S> {
	return { spec, body: attached(spec.run, 1) };
}
