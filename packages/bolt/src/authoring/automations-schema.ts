import { Effect } from 'effect';
import type { AnySchema, BeforeApi, DefaultWorkspaceSchema, SchemaRow, TableName } from './contracts-schema.js';

export interface AutomationDeclaration {
	readonly name: string;
	readonly trigger: { readonly _tag: 'Schedule'; readonly cron: string } | { readonly _tag: 'Change'; readonly collection: string };
	readonly command: string;
}

export interface AgentAutomationSpec {
	readonly description: string;
	readonly kind: 'agent';
	readonly task: string;
	readonly systemPrompt: string;
	readonly collections?: ReadonlyArray<string>;
	readonly tools?: ReadonlyArray<string>;
	readonly denyTools?: ReadonlyArray<string>;
	readonly mcpServers?: ReadonlyArray<string>;
	readonly hostTools?: ReadonlyArray<string>;
	readonly model?: string;
	readonly access?: 'read' | 'write';
	readonly maxTokens?: number;
}

export type AutomationTrigger<S extends AnySchema = AnySchema> = { readonly schedule: string } | { readonly trigger: { readonly collection: TableName<S>; readonly event: 'created' | 'updated' | 'deleted' } };
export type AutomationContext<T extends AutomationTrigger<S>, S extends AnySchema> = {
	readonly args: Readonly<Record<string, unknown>>;
	readonly scope: T extends { readonly trigger: { readonly collection: infer N extends TableName<S> } }
		? { readonly incoming_record: SchemaRow<S, N> }
		: Readonly<Record<string, unknown>>;
};
export interface AutomationDefinition<S extends AnySchema = DefaultWorkspaceSchema, T extends AutomationTrigger<S> = AutomationTrigger<S>> {
	readonly trigger: T;
	readonly spec: {
		readonly description: string;
		readonly handler: (api: BeforeApi<S>, context: AutomationContext<T, S>) => Effect.Effect<Readonly<Record<string, unknown>>, unknown, never> | Promise<Readonly<Record<string, unknown>>> | Readonly<Record<string, unknown>>;
	};
}

/**
 * Public call contract kept distinct from the implementation so declaration emission retains
 * `DefaultWorkspaceSchema`. Each workspace can therefore augment the handler's concrete tables
 * before TypeScript contextually types its incoming record and database API.
 */
interface DefineAutomation {
	<S extends AnySchema = DefaultWorkspaceSchema, const T extends AutomationTrigger<S> = AutomationTrigger<S>>(
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
		return { trigger, spec };
	}
};

export const automation = AutomationAuthoring.declaration;
export const defineAutomation = AutomationAuthoring.definition;
