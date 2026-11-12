// An automation's source path supplies its name. The run body infers its input and output from its literal.
import { Schema } from 'effect';
import { duration_seconds } from '@norbital-ai/std/date';
import type { Actor } from '../access/actor.ts';
import { attached, type AgentUse, type Body } from '../body.ts';
import type { Act, BodyReturn, CallerQuery, Clock, Eff } from '../ctx.ts';
import type { FacilityFailure, Refusal, Unavailable } from '../errors.ts';
import type {
	Checked,
	Exact,
	Simplify,
	ValidOutput,
	OutputKind,
	ValueOf
} from '../fields.ts';
import type { ModelName, PolicyName, Row } from '../names.ts';
import type { Duration, FileRef, IanaZone, Id, NonEmpty, RequestId } from '../values.ts';
import type { ApprovalEffectEvent } from '../../protocol/effect-events.ts';
import type {
	Ai,
	Browser,
	Convert,
	Files,
	Geo,
	ImageFacts,
	IngestOptions,
	Notify,
	Request,
	Run,
	RunCause,
	RunTrigger,
	Schedule,
	Send,
	Web
} from './facilities.ts';
import type { AutomationInputFields, AutomationInputOf, ValidAutomationInputs } from './automation-input.ts';

type Macro = '@yearly' | '@annually' | '@monthly' | '@weekly' | '@daily' | '@hourly';
type Fields<S, N extends unknown[] = [0]> = S extends `${string} ${infer R}`
	? Fields<R, [...N, 0]>
	: N['length'];
/** Five space-separated fields or a macro (rule 52: tsc checks the count; the build parses the fields). */
export type Cron<S> = S extends Macro
	? S
	: Fields<S> extends 5
		? S
		: 'error: a cron is 5 fields or a macro';
export const DeclaredDuration = Schema.TemplateLiteral([
	Schema.BigInt,
	Schema.Literals(['s', 'min', 'h', 'd'])
]);
export const CallCacheDuration = DeclaredDuration.check(Schema.makeFilter((value) => {
	const seconds = duration_seconds(value);
	return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? undefined : 'cache must be a positive duration';
}));
/** A cron schedule. Row writes run the model's effect; integrations own incoming webhooks. */
export const TriggerSpec = Schema.Struct({
	cron: Schema.String,
	tz: Schema.optionalKey(Schema.String),
	rest: Schema.optionalKey(DeclaredDuration)
});
export type Trigger = typeof TriggerSpec.Type;
type ValidTrigger<T> = T extends { cron: infer S }
	? { cron: Cron<S>; tz?: IanaZone; rest?: Duration }
	: Trigger;

type Attempts = 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Max = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
/** An automation literal's data: what the manifest holds (the `run` body is not data). */
/** Cached calls have no starter metadata and cannot write, including through nested runs. */
type AutomationMode =
	| { mode?: 'job'; cache?: never }
	| { mode: 'call'; cache?: Duration; on?: never; retry?: never; concurrency?: never };
export type AutomationSpec = AutomationMode & {
	description: string;
	/** The typed input a start or schedule passes. */
	input?: AutomationInputFields;
	/** The typed result returned by a call or recorded on a job. */
	output?: OutputKind;
	/** Cron schedules; absent means started only. */
	on?: readonly Trigger[];
	/**
	 * The policies every run holds, whoever or whatever starts it: a run executes as the reserved system identity, and
	 * who triggered it (`ctx.run.trigger`) never changes its authority.
	 */
	policies: NonEmpty<string>;
	/**
	 * Retries of a failed run, only for a transient failure: a refusal or a bug is final. `attempts` counts every run,
	 * the first included, so `1` never retries. `backoff` (default `10s`) doubles each attempt, up to an hour, with jitter.
	 */
	retry?: { attempts: Attempts; backoff?: Duration };
	/** At most `max` runs of this automation at once; absent, one. The rest wait queued. */
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
 * `run`'s ctx (§3.4): reads (`ctx.query`), writes and schedules as its `policies`; the only place for I/O. A failed
 * `yield*` ends the body: `try`/`catch` never sees it, so recover with `Effect.catch` or `Effect.catchTag` on the yielded
 * Effect (`yield* ctx.browser.download(url, options).pipe(Effect.catch(...))`). `actor` is
 * the reserved system identity; `run.trigger` records who or what started the run. Code acting for a starter checks it
 * explicitly (`trigger.kind === 'person'`, then their id, party or teams against the rows it touches).
 */
type SystemRunCtx = RunCtx<Extract<Actor, { kind: 'system' }>, true>;
type CachedCtx = Omit<SystemRunCtx, 'act' | 'schedule' | 'notify' | 'send' | 'files' | 'convert' | 'browser'> & {
	files: Pick<Files, 'meta' | 'get' | 'url'> & { image(ref: FileRef): Eff<ImageFacts, FacilityFailure | Unavailable> };
	convert: { ingest(file: FileRef, options?: Omit<IngestOptions, 'for'> & { for?: never }): ReturnType<Convert['ingest']> };
	browser: Pick<Browser, 'navigate' | 'snapshot' | 'close'>;
};
export type AutomationCtx<S = AutomationSpec> = (S extends { cache: Duration } ? CachedCtx : SystemRunCtx) & {
	readonly run: Run & (S extends { mode: 'call' }
		? S extends { cache: Duration } ? {} : { readonly trigger: RunTrigger }
		: { readonly id: Id<'sys_run'>; readonly trigger: RunTrigger });
};
type RunCtx<A, Tools extends boolean> = Omit<Clock, 'actor'> &
	CallerQuery & { invocation_id: string } & {
		actor: A;
		/** 1 on the first attempt. */
		attempt: number;
		cause: RunCause;
		progress(update: { ratio?: number | null; text?: string | null }): Eff<void>;
		act: Act;
		run: Run;
		/** Stops the current body with an authored refusal. */
		refuse(message: string, at?: { at?: object; field?: string; row?: number }): Eff<never, Refusal>;
		schedule: Schedule;
		notify: Notify;
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
/**
 * A model `effect`'s ctx: an automation run's facilities, as the writer whose committed write ran it (its actor, its
 * authority); an effect holds no policy of its own.
 */
export type EffectEvent<M = ModelName> =
	| { readonly kind: 'write' }
	| (Omit<ApprovalEffectEvent, 'request' | 'records' | 'requester'> & {
		readonly request: RequestId;
		readonly records: readonly { readonly id: Id<M & string>; readonly row: Readonly<Partial<Row<M>>> | null }[];
		readonly requester: Id<'sys_user'> | null;
	});
export type EffectCtx<M = ModelName> = RunCtx<Actor, false> & {
	/** Approval moves have no committed change list; their frozen data is carried here. */
	readonly event: EffectEvent<M>;
};
type AutomationLiteral<I extends AutomationInputFields, O extends OutputKind | undefined, M extends 'job' | 'call', C extends Duration | undefined> = Omit<
	AutomationSpec,
	'input' | 'output' | 'mode' | 'cache'
> & {
	input?: I;
	output?: O;
	mode?: M;
	cache?: C;
	run: (
		input: RunInput<{ input: I }>,
		ctx: AutomationCtx<{ mode: M; cache: C }>
	) => BodyReturn<O extends OutputKind ? ValueOf<O> : void>;
};
/** The literal and the body the guest calls. The file supplies its name. */
export type Automation<S> = {
	readonly spec: S;
	readonly body: Body;
};

/**
 * `src/automation/+<a>.automation.ts`: a job on a trigger or a call in the request, executed by
 * the reserved system identity with the declared `policies` (`ctx.run.trigger` records who started it), with typed `input` and `output`, retries and concurrency. `run` is a generator in the literal; `ctx` carries reads (`ctx.query`), `act`, files, AI and the other facilities.
 * A person's permission to start a job does not grant the job that person's authority. Check `ctx.run.trigger`
 * explicitly when business rules depend on the starter. External calls can repeat when a failed run retries.
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
	const C extends Duration | undefined = undefined,
	const S extends AutomationLiteral<I, O, M, C> = AutomationLiteral<I, O, M, C>
>(
	spec: { input?: I; output?: O; mode?: M; cache?: C } & S &
		NoInfer<
			Checked<
				AutomationLiteral<I, O, M, C>,
				S,
				Exact<S, AutomationFor<S, AutomationLiteral<I, O, M, C>['run']>>
			>
		>
): Automation<S> {
	return { spec, body: attached(spec.run, 1) };
}
