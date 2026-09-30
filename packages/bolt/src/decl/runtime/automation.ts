// `automation()` (§3.3.8, rules 48–56): triggers are one literal union (P26); the run body attaches with `a.run`
// exactly once, typed from the literal (its input from the triggers or the declared input, its output, its ctx).
import type { Actor } from '../access/actor.ts';
import type { AgentUse } from '../collection.ts';
import type { Act, QueryCtx } from '../ctx.ts';
import type { Checked, Exact, InputFields, InputKind, InputOf, Simplify, ValidInput, ValidInputs, ValueOf } from '../fields.ts';
import type { CollectionName, PolicyName, ReadField, ReadableName, Row, SystemColumns } from '../names.ts';
import type { Where } from '../where.ts';
import type { Duration, IanaZone, Id, NonEmpty } from '../values.ts';
import type { Ai, Convert, Files, Geo, Http, Notify, RunCause, Schedule, Send, Web } from './facilities.ts';
import type { EnvName } from './names.ts';

type Macro = '@yearly' | '@annually' | '@monthly' | '@weekly' | '@daily' | '@hourly';
type Fields<S, N extends unknown[] = [0]> = S extends `${string} ${infer R}` ? Fields<R, [...N, 0]> : N['length'];
/** Five space-separated fields or a macro (rule 52: tsc checks the count; the build parses the fields). */
export type Cron<S> = S extends Macro ? S : Fields<S> extends 5 ? S : 'error: a cron is 5 fields or a macro';
export type WebhookScheme = 'bearer' | 'hmac-sha256' | 'svix' | 'stripe' | 'slack' | 'meta';
/** Ledgers take no trigger (X-18). */
export type TriggerTarget = ReadableName;
/** Fields an `updated` trigger may name: exposed, stored or derived, never system columns. */
type TriggerField<C> = Exclude<ReadField<C>, keyof SystemColumns<C>>;

/**
 * When an automation runs (its `on`): a `cron` schedule, a `webhook` path, or a row `created`, `updated` or `deleted` in a
 * collection (optionally filtered by `where`, `fields`, and delayed).
 */
export type Trigger =
	| { cron: string; tz?: IanaZone }
	| { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: string } }
	| { created: string; where?: object; delay?: Duration }
	| { updated: string; where?: object; fields?: readonly string[]; delay?: Duration }
	| { deleted: string; where?: object; delay?: Duration };
type ValidTrigger<T> =
	T extends { cron: infer S } ? { cron: Cron<S>; tz?: IanaZone }
	: T extends { webhook: unknown } ? { webhook: `/${string}`; verify: { scheme: WebhookScheme; secret: EnvName } }
	: T extends { created: infer C } ? { created: TriggerTarget; where?: Where<C>; delay?: Duration }
	: T extends { updated: infer C } ? { updated: TriggerTarget; where?: Where<C>; fields?: readonly TriggerField<C>[]; delay?: Duration }
	: T extends { deleted: infer C } ? { deleted: TriggerTarget; where?: Where<C>; delay?: Duration }
	: Trigger;

type Attempts = 2 | 3 | 4 | 5 | 6 | 7 | 8;
type Max = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
export type AutomationSpec = {
	description: string;
	/** The typed input a start or schedule passes. */
	input?: InputFields;
	/** The typed result recorded on the run. */
	output?: InputKind;
	/** What runs it: cron, webhook, or a row created, updated or deleted; absent means started only. */
	on?: Trigger | readonly Trigger[];
	/** The policies the run holds, or `'trigger'` (the starter's authority) for an automation with no `on`. */
	runAs: NonEmpty<string> | 'trigger';
	/** Retries of a failed run, with backoff. */
	retry?: { attempts: Attempts; backoff?: Duration };
	/** At most `max` runs at once. */
	concurrency?: { max: Max };
	/** How the agent may start it (`direct`, `confirm`, `never`). */
	agent?: AgentUse;
};
type On<S> = S extends { on: infer O } ? O extends readonly unknown[] ? O[number] : O : never;
type AutomationFor<S> = {
	description: string;
	input?: S extends { input: infer I } ? ValidInputs<I> : InputFields;
	output?: S extends { output: infer O } ? ValidInput<O> : InputKind;
	on?: S extends { on: infer O } ? O extends readonly unknown[] ? { [I in keyof O]: ValidTrigger<O[I]> } : ValidTrigger<O> : never;
	/** 'trigger' (the starter's authority) only when nothing triggers it (rule 53). */
	runAs: NonEmpty<PolicyName> | (S extends { on: unknown } ? 'error: runAs trigger needs an automation without on' : 'trigger');
	retry?: { attempts: Attempts; backoff?: Duration };
	concurrency?: { max: Max };
	agent?: AgentUse;
};

// ── the run's input and ctx ──
type Target<T> = T extends { created: infer C } | { updated: infer C } | { deleted: infer C } ? C & CollectionName : never;
type Deleted<T> = T extends { deleted: infer C } ? C & CollectionName : never;
type EventInput<T> = [Target<T>] extends [never] ? {}
	: { readonly ids: readonly Id<Target<T>>[] } extends infer E ? Exclude<T, { created: unknown } | { updated: unknown } | { deleted: unknown }> extends never ? E : Partial<E> : never;
/** A `deleted` run also receives the pre-images, masked to its `runAs` read grant (rule 50). */
type Removed<T> = [Deleted<T>] extends [never] ? {} : { readonly rows?: readonly Row<Deleted<T>>[] };
export type RunInput<S> = Simplify<(S extends { input: infer I } ? InputOf<I> : EventInput<On<S>>) & Removed<On<S>>>;
export type RunOutput<S> = S extends { output: infer O } ? ValueOf<O> : void;

/** `a.run`'s ctx (§3.4): reads, writes and schedules as its `runAs` policies; the only place for I/O. */
export type AutomationCtx<S = AutomationSpec> = Omit<QueryCtx, 'actor' | 'refuse'> & {
	actor: S extends { runAs: 'trigger' } ? Actor : Extract<Actor, { kind: 'system' }>;
	/** 1 on the first attempt. */
	attempt: number;
	cause: RunCause;
	progress(update: { ratio?: number | null; text?: string | null }): Promise<void>;
	act: Act; schedule: Schedule; notify: Notify; send: Send; http: Http;
	web: Web;
	files: Files;
	/** Markdown or HTML to a declared document format (optional host capability; absent → `unavailable`). */
	convert: Convert;
	ai: Ai<S extends { runAs: 'trigger' } ? false : true>;
	geo: Geo;
};
export type RunBody<S> = (input: RunInput<S>, ctx: AutomationCtx<S>) => Promise<RunOutput<S>>;
export type Automation<S> = {
	readonly spec: S;
	/** Exactly once (a missing body is a build error). */
	run(body: RunBody<S>): void;
	/** The attached body, read by the compiler. */
	readonly body: RunBody<S> | undefined;
};

/**
 * `src/automation/+<a>.automation.ts`: work that runs on a trigger (`on`: cron, webhook, a row created, updated or deleted)
 * or when started, as the policies in `runAs`, with typed `input` and `output`, retries and concurrency. The body attaches
 * with `a.run(async (input, ctx) => …)`; `ctx` carries reads, `act`, files, AI and the other facilities.
 * @example
 * const a = automation({ description: 'Daily sweep of lapsed quotes.', on: { cron: '0 6 * * *' }, runAs: ['quote_watch'] });
 * export default a;
 * a.run(async (_, ctx) => {
 * 	const lapsed = await ctx.read('quotes', { where: { valid_until: { lt: { today: '' } } }, limit: 50 });
 * 	await ctx.progress({ text: `${lapsed.rows.length} lapsed` });
 * });
 */
export function automation<const S extends AutomationSpec>(spec: S & Checked<AutomationSpec, S, Exact<S, AutomationFor<S>>>): Automation<S> {
	let body: RunBody<S> | undefined;
	return {
		spec,
		run(b) {
			if (body !== undefined) throw new Error('automation: run is attached twice');
			body = b;
		},
		get body() {
			return body;
		}
	};
}
