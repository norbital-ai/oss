// `automation('<name>', …)` (§3.3.8, rules 48–56): triggers are one literal union (P26); the `run` body sits in the
// literal, typed from the generated names (its input from the triggers or the declared input, its output, its ctx).
import type { Actor } from '../access/actor.ts';
import { attached, type AgentUse, type Body } from '../body.ts';
import type { Act, BodyReturn, CallerQuery, Clock, Eff } from '../ctx.ts';
import type { Transaction } from '../transaction.ts';
import type {
	Checked,
	Exact,
	InputFields,
	InputOf,
	Simplify,
	ValidOutput,
	OutputKind,
	ValidInputs,
	ValueOf
} from '../fields.ts';
import type { AutomationName, ModelName, PolicyName } from '../names.ts';
import type { Duration, IanaZone, Id, NonEmpty, Rate } from '../values.ts';
import type {
	Ai,
	Convert,
	Files,
	Geo,
	Notify,
	Request,
	RunCause,
	RunTrigger,
	Schedule,
	Send,
	Web
} from './facilities.ts';
import type { AutomationSpecOf, SecretName } from './names.ts';

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
/**
 * How a webhook is signed: `standard` is Standard Webhooks (HMAC-SHA256 over `id.timestamp.body`, `webhook-*` headers;
 * Svix sends the same scheme under `svix-*` headers and is accepted as it), `hmac-sha256` a hex digest of the body,
 * `stripe`, `slack` and `meta` those providers' own signatures, `bearer` a shared token in `Authorization`.
 */
export type WebhookScheme = 'standard' | 'hmac-sha256' | 'stripe' | 'slack' | 'meta' | 'bearer';
/** When an automation runs (its `on`): a `cron` schedule or a `webhook` path. Row writes run a model's `effect`. */
export type Trigger =
	| { cron: string; tz?: IanaZone }
	| { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: string } };
type ValidTrigger<T> = T extends { cron: infer S }
	? { cron: Cron<S>; tz?: IanaZone }
	: T extends { webhook: unknown }
		? { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: SecretName } }
		: Trigger;

type Attempts = 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Max = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
/** An automation literal's data: what the manifest holds (the `run` body is not data). */
export type AutomationSpec = {
	description: string;
	/** The typed input a start or schedule passes. */
	input?: InputFields;
	/** The typed result recorded on the run. */
	output?: OutputKind;
	/** What runs it: cron or webhook; absent means started only. */
	on?: Trigger | readonly Trigger[];
	/**
	 * The policies every run holds, whoever or whatever starts it: a run executes as the reserved system identity, and
	 * who triggered it (`ctx.run.trigger`) never changes its authority.
	 */
	policies: NonEmpty<string>;
	/** Native generated verbs delegated to this authenticated run and its child action lineage only. */
	delegations?: readonly { verb: `${string}.${'create' | 'update' | 'delete'}`; policy: string }[];
	/** Retries of a failed run, with backoff. */
	retry?: { attempts: Attempts; backoff?: Duration };
	/** At most `max` runs at once. */
	concurrency?: { max: Max };
	/** How the agent may start it (`direct`, `confirm`, `never`). */
	agent?: AgentUse;
	/**
	 * Manual starts per starter (`'10/min'`; default `'30/min'`): the `start` callable, Run now and the agent, each
	 * admitted by a policy's `automations`. Cron, webhook and model effect runs, schedules from code, and the acts a run's
	 * body performs, are never rate limited and need no start grant.
	 */
	limit?: Rate;
};
type AutomationFor<N, S> = {
	description: string;
	input?: S extends { input: infer I } ? ValidInputs<I> : InputFields;
	output?: S extends { output: infer O } ? ValidOutput<O> : OutputKind;
	on?: S extends { on: infer O }
		? O extends readonly unknown[]
			? { [I in keyof O]: ValidTrigger<O[I]> }
			: ValidTrigger<O>
		: never;
	policies: NonEmpty<PolicyName>;
	delegations?: readonly {
		verb: `${ModelName}.${'create' | 'update' | 'delete'}`;
		policy: PolicyName;
	}[];
	retry?: { attempts: Attempts; backoff?: Duration };
	concurrency?: { max: Max };
	agent?: AgentUse;
	limit?: Rate;
	run: RunBody<SpecOf<N>>;
};

// ── the run's input and ctx ──
/** What `run` receives: the declared input (a cron or webhook run without one receives `{}`). */
export type RunInput<S> = Simplify<S extends { input: infer I } ? InputOf<I> : {}>;
/** What `run` returns: the declared output, recorded on the run. */
export type RunOutput<S> = S extends { output: infer O } ? ValueOf<O> : void;

/**
 * `run`'s ctx (§3.4): reads (`ctx.query`), writes and schedules as its `policies`; the only place for I/O. `actor` is
 * the reserved system identity; `run.trigger` records who or what started the run. Code acting for a starter checks it
 * explicitly (`trigger.kind === 'person'`, then their id, party or teams against the rows it touches).
 */
export type AutomationCtx<_S = AutomationSpec> = RunCtx<Extract<Actor, { kind: 'system' }>, true> & {
	readonly run: { readonly id: Id<'sys_run'>; readonly trigger: RunTrigger };
};
type RunCtx<A, Tools extends boolean> = Omit<Clock, 'actor'> &
	CallerQuery & { invocationId: string } & {
		actor: A;
		/** 1 on the first attempt. */
		attempt: number;
		cause: RunCause;
		progress(update: { ratio?: number | null; text?: string | null }): Eff<void>;
		act: Act;
		/** Caller-scoped model reads and guarded CRUD in one fixed five-second native transaction. */
		transaction: Transaction;
		schedule: Schedule;
		notify: Notify;
		send: Send;
		request: Request;
		web: Web;
		files: Files;
		/** Markdown or HTML to a declared document format (optional host capability; absent → `unavailable`). */
		convert: Convert;
		ai: Ai<Tools>;
		geo: Geo;
	};
/**
 * A model `effect`'s ctx: an automation run's facilities, as the writer whose committed write ran it (its actor, its
 * authority); an effect holds no policy of its own.
 */
export type EffectCtx = RunCtx<Actor, false>;
type RunBody<S> = (input: RunInput<S>, ctx: AutomationCtx<S>) => BodyReturn<RunOutput<S>>;
/** Automation `N`'s data from the generated names; the general shape until the first sync knows it. */
type SpecOf<N> = [AutomationSpecOf<N>] extends [never] ? AutomationSpec : AutomationSpecOf<N>;
/** The literal `automation(N, …)` takes: its data and the `run` body, typed from the generated names. */
type AutomationLiteral<N> = AutomationSpec & { run: RunBody<SpecOf<N>> };
/** What `automation()` returns: the name, the literal, and `run` as the guest calls it. */
export type Automation<N extends string, S> = {
	readonly name: N;
	readonly spec: S;
	readonly body: Body;
};

/**
 * `src/automation/+<a>.automation.ts`: a job that runs on a trigger (`on`: cron or webhook) or when started, executed by
 * the reserved system identity with the declared `policies` (`ctx.run.trigger` records who started it), with typed `input` and `output`, retries and concurrency. `run` is a generator in the literal; `ctx` carries reads (`ctx.query`), `act`, files, AI and the other facilities.
 * @example
 * export default automation('sweep_quotes', {
 * 	description: 'Daily sweep of lapsed quotes.',
 * 	on: { cron: '0 6 * * *' },
 * 	policies: ['quote_watch'],
 * 	run: function* (_, ctx) {
 * 		const lapsed = yield* ctx.query('quotes', { where: { valid_until: { lt: ctx.today } }, limit: 50 });
 * 		yield* ctx.progress({ text: `${lapsed.rows.length} lapsed` });
 * 	}
 * });
 */
export function automation<const N extends AutomationName, const S extends AutomationLiteral<N>>(
	name: N,
	spec: S & NoInfer<Checked<AutomationLiteral<N>, S, Exact<S, AutomationFor<N, S>>>>
): Automation<N, S> {
	return { name, spec, body: attached(spec.run, 1) };
}
