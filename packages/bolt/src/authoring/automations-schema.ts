import { Effect } from 'effect';
import type {
	AnySchema,
	BeforeApi,
	PolicyName,
	DefaultWorkspaceSchema,
	SchemaRow,
	TableName
} from './contracts-schema.js';

export interface AutomationDeclaration {
	readonly name: string;
	readonly trigger:
		| { readonly _tag: 'Schedule'; readonly cron: string }
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
	| { readonly schedule: string }
	| {
			readonly trigger: {
				readonly collection: TableName<S>;
				readonly event: 'created' | 'updated' | 'deleted';
			};
	  };
export type AutomationContext<T extends AutomationTrigger<S>, S extends AnySchema> = {
	readonly args: Readonly<Record<string, unknown>>;
	readonly scope: T extends {
		readonly trigger: { readonly collection: infer N extends TableName<S> };
	}
		? { readonly incoming_record: SchemaRow<S, N> }
		: Readonly<Record<string, unknown>>;
};
export interface AutomationDefinition<
	S extends AnySchema = DefaultWorkspaceSchema,
	T extends AutomationTrigger<S> = AutomationTrigger<S>
> {
	readonly trigger: T;
	readonly spec: {
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
			api: BeforeApi<S>,
			context: AutomationContext<T, S>
		) =>
			| Effect.Effect<Readonly<Record<string, unknown>>, unknown, never>
			| Promise<Readonly<Record<string, unknown>>>
			| Readonly<Record<string, unknown>>;
	};
}

/**
 * Public call contract kept distinct from the implementation so declaration emission retains
 * `DefaultWorkspaceSchema`. Each workspace can therefore augment the handler's concrete tables
 * before TypeScript contextually types its incoming record and database API.
 */
interface DefineAutomation {
	<
		S extends AnySchema = DefaultWorkspaceSchema,
		const T extends AutomationTrigger<S> = AutomationTrigger<S>
	>(
		trigger: T,
		spec: AutomationDefinition<S, T>['spec']
	): AutomationDefinition<S, T>;
}

/** Owns declaration retention and automation validation behind their public call contracts. */
const AutomationAuthoring: {
	readonly declaration: (declaration: AutomationDeclaration) => AutomationDeclaration;
	readonly definition: DefineAutomation;
} = {
	declaration: (declaration) => declaration,
	definition: (trigger, spec) => {
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
