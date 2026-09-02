import { Effect, Schema } from 'effect';
import type {
	AnySchema,
	Api,
	PolicyName,
	DefaultWorkspaceSchema,
	SchemaRow,
	TableName
} from './contracts-schema.js';

export interface AutomationDeclaration {
	readonly name: string;
	/** Human-readable purpose projected into read-only workspace manifests. */
	readonly description?: string;
	readonly trigger:
		| { readonly _tag: 'Schedule'; readonly cron: string }
		| { readonly _tag: 'Manual' }
		| {
				readonly _tag: 'Change';
				readonly collection: string;
				readonly event: 'created' | 'updated' | 'deleted';
		  };
	readonly command: string;
	/**
	 * The policies every run of this automation acts under.
	 *
	 * An automation's authority is a property of the automation, not of whoever tripped it. It used
	 * to inherit the caller's subject, so the same automation ran with different authority depending
	 * on who that was — and when an administrator tripped it, it ran as an administrator.
	 */
	readonly policies: ReadonlyArray<string>;
}

export type AutomationTrigger<S extends AnySchema = AnySchema> =
	/** No automatic trigger. The automation is still manually runnable, like every automation. */
	| { readonly schedule?: string; readonly trigger?: never }
	| {
			/** An additional automatic start when a row changes. Manual invocation remains available. */
			readonly trigger: {
				readonly collection: TableName<S>;
				readonly event: 'created' | 'updated' | 'deleted';
			};
			readonly schedule?: never;
	  };

/**
 * Keeps the public declaration a closed object even though `defineAutomation` needs a generic to
 * preserve its literal trigger and infer the incoming-record shape. A bare generic constraint would
 * otherwise accept unknown or misspelled properties as structural extras.
 */
type ExactAutomationTrigger<T> = T &
	Readonly<Record<Exclude<keyof T, 'schedule' | 'trigger'>, never>>;

type AutomationInput<I extends Schema.Top | undefined> = I extends Schema.Top
	? Schema.Schema.Type<I>
	: Readonly<Record<string, Schema.Json>>;
type AutomationOutput<O extends Schema.Top | undefined> = O extends Schema.Top
	? Schema.Schema.Type<O>
	: Readonly<Record<string, unknown>>;

/** One durable, coalesced progress snapshot for an automation run. */
export const AutomationProgression = Schema.Struct({
	/** Normalized completion, from 0 (not started) through 1 (complete). */
	progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
	/** Displayed verbatim until the next progression replaces it. */
	text: Schema.NullOr(Schema.String)
});
export type AutomationProgression = Schema.Schema.Type<typeof AutomationProgression>;

/**
 * The capability an authored automation has in addition to the ordinary server API.
 *
 * It is deliberately absent from hooks and remotes. Progress belongs to a durable background run;
 * a hook is part of somebody else's atomic write and must never acquire an I/O checkpoint API that
 * can outlive or partially report that write.
 */
export type AutomationApi<S extends AnySchema = DefaultWorkspaceSchema> = Api<S> & {
	/** Replaces this run's current progress snapshot and advances its monotonic sequence. */
	readonly progress: (value: AutomationProgression) => Effect.Effect<void>;
};

export type AutomationContext<
	T extends AutomationTrigger<S>,
	S extends AnySchema,
	I extends Schema.Top | undefined = undefined
> = {
	readonly args: AutomationInput<I>;
	readonly scope: T extends {
		readonly trigger: { readonly collection: infer N extends TableName<S> };
	}
		? { readonly incoming_record: SchemaRow<S, N> }
		: Readonly<Record<string, unknown>>;
};

type AutomationInputDeclaration<I extends Schema.Top | undefined> = I extends Schema.Top
	? Readonly<{ readonly input: I }>
	: Readonly<{ readonly input?: undefined }>;
type AutomationOutputDeclaration<O extends Schema.Top | undefined> = O extends Schema.Top
	? Readonly<{ readonly output: O }>
	: Readonly<{ readonly output?: undefined }>;

export interface AutomationDefinition<
	S extends AnySchema = DefaultWorkspaceSchema,
	T extends AutomationTrigger<S> = AutomationTrigger<S>,
	I extends Schema.Top | undefined = undefined,
	O extends Schema.Top | undefined = undefined,
	E = never
> {
	readonly trigger: T;
	readonly spec: Readonly<{
		readonly description: string;
		/**
		 * The policies this automation runs under — its authority *and* its toolset.
		 *
		 * Required, and required for the reason `envoy()` requires them: an automation that names none
		 * would hold nothing, and the shape that let it hold whatever its trigger held is exactly what
		 * this replaces.
		 */
		readonly policies: ReadonlyArray<PolicyName>;
		readonly handler: (
			api: AutomationApi<S>,
			context: AutomationContext<T, S, I>
		) => Effect.Effect<AutomationOutput<O>, E, never> | AutomationOutput<O>;
	}> &
		AutomationInputDeclaration<I> &
		AutomationOutputDeclaration<O>;
}

/**
 * Public call contract kept distinct from the implementation so declaration emission retains
 * `DefaultWorkspaceSchema`. Each workspace can therefore augment the handler's concrete tables
 * before TypeScript contextually types its incoming record and database API.
 */
interface DefineAutomation {
	<
		S extends AnySchema = DefaultWorkspaceSchema,
		const T extends AutomationTrigger<S> = AutomationTrigger<S>,
		const I extends Schema.Top | undefined = undefined,
		const O extends Schema.Top | undefined = undefined,
		E = never
	>(
		trigger: ExactAutomationTrigger<T>,
		spec: AutomationDefinition<S, T, I, O, E>['spec']
	): AutomationDefinition<S, T, I, O, E>;
}

/** Owns declaration retention and automation validation behind their public call contracts. */
const AutomationAuthoring: {
	readonly declaration: (declaration: AutomationDeclaration) => AutomationDeclaration;
	readonly definition: DefineAutomation;
} = {
	declaration: (declaration) => declaration,
	definition: (trigger, spec) => {
		const authored = trigger as Readonly<Record<string, unknown>>;
		const unsupported = Object.keys(authored).filter(
			(key) => key !== 'schedule' && key !== 'trigger'
		);
		if (unsupported.length > 0) {
			throw new Error(
				`Automation automatic-trigger declaration has unsupported ${unsupported.length === 1 ? 'property' : 'properties'}: ${unsupported.join(', ')}. Use {}, { schedule }, or { trigger }.`
			);
		}
		const hasSchedule = Object.hasOwn(authored, 'schedule');
		const hasChange = Object.hasOwn(authored, 'trigger');
		if (hasSchedule && hasChange) {
			throw new Error(
				'An automation can declare one automatic trigger: schedule or change, not both'
			);
		}
		if (hasSchedule) {
			if (typeof authored['schedule'] !== 'string' || authored['schedule'].trim() === '') {
				throw new Error('An automation schedule must be a non-empty cron expression');
			}
		}
		if (hasChange) {
			const change = authored['trigger'];
			if (typeof change !== 'object' || change === null) {
				throw new Error('An automation change trigger must name a collection and event');
			}
			const collection = Reflect.get(change, 'collection');
			const event = Reflect.get(change, 'event');
			if (
				typeof collection !== 'string' ||
				collection.trim() === '' ||
				(event !== 'created' && event !== 'updated' && event !== 'deleted')
			) {
				throw new Error('An automation change trigger must name a collection and valid event');
			}
		}
		if (spec.description.trim() === '') throw new Error('Automation description cannot be empty');
		if (spec.policies.length === 0) {
			throw new Error(
				'An automation names the policies it runs under. Declaring none would leave every run with no authority at all, which is never what an automation is for.'
			);
		}
		return { trigger, spec };
	}
};

export const automation = AutomationAuthoring.declaration;
export const defineAutomation = AutomationAuthoring.definition;
