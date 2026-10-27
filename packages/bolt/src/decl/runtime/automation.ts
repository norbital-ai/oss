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
import type {
	AutomationName,
	ModelName,
	PolicyName,
	ReadField,
	ReadableName,
	Row,
	SystemColumns
} from '../names.ts';
import type { Where } from '../where.ts';
import type { Duration, IanaZone, Id, NonEmpty } from '../values.ts';
import type {
	Ai,
	Convert,
	Files,
	Geo,
	Notify,
	Request,
	RunCause,
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
/** Ledgers take no trigger (X-18). */
type TriggerTarget = ReadableName;
/** Fields an `updated` trigger may name: exposed, stored or derived, never system columns. */
type TriggerField<C> = Exclude<ReadField<C>, keyof SystemColumns<C>>;

/**
 * When an automation runs (its `on`): a `cron` schedule, a `webhook` path, or a row `created`, `updated` or `deleted` in a
 * model (optionally filtered by `where`, `fields`, and delayed).
 */
export type Trigger =
	| { cron: string; tz?: IanaZone }
	| { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: string } }
	| { created: string; where?: object; delay?: Duration }
	| { updated: string; where?: object; fields?: readonly string[]; delay?: Duration }
	| { deleted: string; where?: object; delay?: Duration };
type ValidTrigger<T> = T extends { cron: infer S }
	? { cron: Cron<S>; tz?: IanaZone }
	: T extends { webhook: unknown }
		? { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: SecretName } }
		: T extends { created: infer C }
			? { created: TriggerTarget; where?: Where<C>; delay?: Duration }
			: T extends { updated: infer C }
				? {
						updated: TriggerTarget;
						where?: Where<C>;
						fields?: readonly TriggerField<C>[];
						delay?: Duration;
					}
				: T extends { deleted: infer C }
					? { deleted: TriggerTarget; where?: Where<C>; delay?: Duration }
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
	/** What runs it: cron, webhook, or a row created, updated or deleted; absent means started only. */
	on?: Trigger | readonly Trigger[];
	/** The policies the run holds, or `'trigger'` (the starter's authority) for an automation with no `on`. */
	runAs: NonEmpty<string> | 'trigger';
	/** Native generated verbs delegated to this authenticated run and its child action lineage only. */
	delegations?: readonly { verb: `${string}.${'create' | 'update' | 'delete'}`; policy: string }[];
	/** Retries of a failed run, with backoff. */
	retry?: { attempts: Attempts; backoff?: Duration };
	/** At most `max` runs at once. */
	concurrency?: { max: Max };
	/** How the agent may start it (`direct`, `confirm`, `never`). */
	agent?: AgentUse;
};
type On<S> = S extends { on: infer O } ? (O extends readonly unknown[] ? O[number] : O) : never;
type AutomationFor<N, S> = {
	description: string;
	input?: S extends { input: infer I } ? ValidInputs<I> : InputFields;
	output?: S extends { output: infer O } ? ValidOutput<O> : OutputKind;
	on?: S extends { on: infer O }
		? O extends readonly unknown[]
			? { [I in keyof O]: ValidTrigger<O[I]> }
			: ValidTrigger<O>
		: never;
	/** 'trigger' (the starter's authority) only when nothing triggers it (rule 53). */
	runAs:
		| NonEmpty<PolicyName>
		| (S extends { on: unknown }
				? 'error: runAs trigger needs an automation without on'
				: 'trigger');
	delegations?: readonly {
		verb: `${ModelName}.${'create' | 'update' | 'delete'}`;
		policy: PolicyName;
	}[];
	retry?: { attempts: Attempts; backoff?: Duration };
	concurrency?: { max: Max };
	agent?: AgentUse;
	run: RunBody<SpecOf<N>>;
};

// ── the run's input and ctx ──
type Target<T> = T extends { created: infer C } | { updated: infer C } | { deleted: infer C }
	? C & ModelName
	: never;
type Deleted<T> = T extends { deleted: infer C } ? C & ModelName : never;
/** One row-event trigger's input: which model fired, correlated with the ids it fired for. */
type RowArm<T> = T extends { created: infer C } | { updated: infer C } | { deleted: infer C }
	? { readonly model: C & ModelName; readonly ids: readonly Id<C & ModelName>[] }
	: never;
type EventInput<T> = [Target<T>] extends [never]
	? {}
	: Exclude<T, { created: unknown } | { updated: unknown } | { deleted: unknown }> extends never
		? RowArm<T> // all triggers are row events: one arm per model (a declared union)
		: Partial<{ readonly model: Target<T>; readonly ids: readonly Id<Target<T>>[] }>;
/** A `deleted` run also receives the pre-images, masked to its `runAs` read grant (rule 50). */
type Removed<T> = [Deleted<T>] extends [never]
	? {}
	: { readonly rows?: readonly Row<Deleted<T>>[] };
/** What `run` receives: the declared input, else the row event that fired it (and a `deleted` run's pre-images). */
export type RunInput<S> = Simplify<
	(S extends { input: infer I } ? InputOf<I> : EventInput<On<S>>) & Removed<On<S>>
>;
/** What `run` returns: the declared output, recorded on the run. */
export type RunOutput<S> = S extends { output: infer O } ? ValueOf<O> : void;

/** `run`'s ctx (§3.4): reads (`ctx.query`), writes and schedules as its `runAs` policies; the only place for I/O. */
export type AutomationCtx<S = AutomationSpec> = Omit<Clock, 'actor'> &
	CallerQuery & { invocationId: string } & {
	actor: S extends { runAs: 'trigger' } ? Actor : Extract<Actor, { kind: 'system' }>;
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
	ai: Ai<S extends { runAs: 'trigger' } ? false : true>;
	geo: Geo;
};
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
 * `src/automation/+<a>.automation.ts`: work that runs on a trigger (`on`: cron, webhook, a row created, updated or deleted)
 * or when started, as the policies in `runAs`, with typed `input` and `output`, retries and concurrency. `run` is a
 * generator in the literal; `ctx` carries reads (`ctx.query`), `act`, files, AI and the other facilities.
 * @example
 * export default automation('sweep_quotes', {
 * 	description: 'Daily sweep of lapsed quotes.',
 * 	on: { cron: '0 6 * * *' },
 * 	runAs: ['quote_watch'],
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
