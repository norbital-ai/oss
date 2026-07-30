import type { AnySchema, DefaultWorkspaceSchema, SchemaRow, TableName } from '../schema/types.js';
import type { MergedWorkspaceSchema } from '../schema/system-workspace.js';
import type { BeforeApi } from '../workspace/hook-api.js';
import type { WorkspaceAuthoringTypes } from '../index.js';

type PlatformTriggerableTableName = 'user' | 'team' | 'team_members';

type TriggerableCollection<S extends AnySchema> = TableName<S> | PlatformTriggerableTableName;

type AutomationCollectionEvent = 'created' | 'updated' | 'deleted';

export type AutomationTrigger<S extends AnySchema = AnySchema> =
	| { readonly schedule: string }
	| {
			readonly trigger: {
				readonly collection: TriggerableCollection<S>;
				readonly event: AutomationCollectionEvent;
			};
	  };

export type AutomationContext<
	TTrigger extends AutomationTrigger<S> = AutomationTrigger,
	S extends AnySchema = AnySchema
> = {
	readonly args: Record<string, unknown>;
	readonly scope: AutomationScope<S, TTrigger>;
};

type AutomationScope<
	S extends AnySchema,
	TTrigger extends AutomationTrigger<S>
> = TTrigger extends {
	readonly trigger: {
		readonly collection: infer C extends string;
		readonly event: AutomationCollectionEvent;
	};
}
	? {
			readonly incoming_record: C extends TableName<MergedWorkspaceSchema<S>>
				? SchemaRow<MergedWorkspaceSchema<S>, C>
				: Record<string, unknown>;
		}
	: Record<string, unknown>;

type WorkspaceCollectionName = WorkspaceAuthoringTypes extends {
	readonly collectionName: infer TName extends string;
}
	? TName
	: string;

type WorkspaceAgentToolName = WorkspaceAuthoringTypes extends {
	readonly agentToolName: infer TName extends string;
}
	? TName
	: string;

export type AgentAutomationSpec = {
	readonly kind: 'agent';
	readonly task: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly collections?: readonly WorkspaceCollectionName[];
	readonly access?: 'read' | 'write';
	readonly tools?: readonly WorkspaceAgentToolName[];
	readonly profile?: string;
	readonly maxIterations?: number;
	readonly maxTokens?: number;
};

export type DeterministicAutomationSpec = {
	readonly kind: 'deterministic';
	readonly handler: (
		api: BeforeApi,
		context: AutomationContext
	) => Promise<Record<string, unknown>>;
};

type AutomationHandler<S extends AnySchema, TTrigger extends AutomationTrigger<S>> = (
	api: BeforeApi<S>,
	context: AutomationContext<TTrigger, S>
) => Promise<Record<string, unknown>>;

export type AutomationSpec = AgentAutomationSpec | DeterministicAutomationSpec;

export type AutomationDefinition = {
	readonly trigger: AutomationTrigger;
	readonly spec: AutomationSpec;
};

export type AutomationDeclaration = AutomationDefinition & { readonly name: string };

export function defineAutomation<
	S extends AnySchema = DefaultWorkspaceSchema,
	const TTrigger extends AutomationTrigger<S> = AutomationTrigger<S>
>(
	trigger: TTrigger,
	specOrHandler: AutomationSpec | AutomationHandler<S, TTrigger>
): AutomationDefinition {
	const spec: AutomationSpec =
		typeof specOrHandler === 'function'
			? { kind: 'deterministic', handler: eraseAutomationHandler(specOrHandler) }
			: specOrHandler;
	return { trigger: trigger as AutomationTrigger, spec };
}

/**
 * Runtime boundary: author-typed automation handlers lose trigger generics here.
 * Registry storage and dispatch use the returned erased signature only.
 */
function eraseAutomationHandler<S extends AnySchema, TTrigger extends AutomationTrigger>(
	handler: AutomationHandler<S, TTrigger>
): DeterministicAutomationSpec['handler'] {
	return (api, context) =>
		handler(
			api as unknown as BeforeApi<S>, // stupidity: boundary-cast — dispatch provides the same registry API after generic erasure.
			context as unknown as AutomationContext<TTrigger, S> // stupidity: boundary-cast — the stored trigger is the handler's trigger.
		);
}
