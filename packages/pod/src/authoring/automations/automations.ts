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
	S extends AnySchema = DefaultWorkspaceSchema
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
	/**
	 * What this agent is for, in prose — not what it is told to do.
	 *
	 * `task` is the instruction handed to the model and reads as one; it answers "what is being asked"
	 * rather than "why does this exist and what will it touch", which is the question a reader
	 * browsing the workspace has. Carried into the manifest, so it is not a comment.
	 */
	readonly description: string;
	readonly task: string;
	readonly model?: string;
	readonly systemPrompt?: string;
	readonly collections?: readonly WorkspaceCollectionName[];
	readonly access?: 'read' | 'write';
	readonly tools?: readonly WorkspaceAgentToolName[];
	/**
	 * Host tools this agent may call — the opt-in, and the whole of it.
	 *
	 * A host tool runs in the host process with the host's credentials, so it is offered to nothing by
	 * default: naming it here is the only way an agent ever sees one. That keeps a host capability at
	 * least as constrained as a workspace one, which `tools` already narrows the same way, and it puts
	 * the decision in workspace source where it appears in a diff.
	 *
	 * Plain `string` rather than a generated union, because these names belong to the *host*: which
	 * tools exist depends on where the workspace is deployed, and the compiler cannot know. The
	 * cross-reference is checked at startup instead — `assertHostAgentTools` refuses a workspace that
	 * names a tool its host does not supply, and refuses a host tool that shadows a workspace one.
	 */
	readonly hostTools?: readonly string[];
	/**
	 * How host sandbox tools may touch the tenant worktree for this run.
	 *
	 * Interactive defaults to read-write (omitted). Channel runs that name `hostTools` default to
	 * read-only unless the channel declaration sets `hostSandbox.workspace: 'read-write'`.
	 */
	readonly hostSandbox?: {
		readonly workspace: 'read-only' | 'read-write';
	};
	readonly profile?: string;
	readonly maxTokens?: number;
};

/**
 * The object form of a deterministic automation.
 *
 * Generic in the schema and the trigger for the same reason the bare-function form is: without it the
 * handler's `context` falls back to `AnySchema`, which collapses `scope.incoming_record` to
 * `Record<string, unknown>`. Two ways to declare the same automation should not disagree about how
 * well it is typed — the object form existed only to carry `kind`, and it was quietly the weaker one.
 */
export type DeterministicAutomationSpec<
	S extends AnySchema = DefaultWorkspaceSchema,
	TTrigger extends AutomationTrigger<S> = AutomationTrigger<S>
> = {
	readonly kind: 'deterministic';
	/** What this automation does each time its trigger fires. Carried into the manifest. */
	readonly description: string;
	readonly handler: AutomationHandler<S, TTrigger>;
};

type AutomationHandler<S extends AnySchema, TTrigger extends AutomationTrigger<S>> = (
	api: BeforeApi<S>,
	context: AutomationContext<TTrigger, S>
) => Promise<Record<string, unknown>>;

export type AutomationSpec<
	S extends AnySchema = DefaultWorkspaceSchema,
	TTrigger extends AutomationTrigger<S> = AutomationTrigger<S>
> = AgentAutomationSpec | DeterministicAutomationSpec<S, TTrigger>;

export type AutomationDefinition = {
	readonly trigger: AutomationTrigger;
	readonly spec: AutomationSpec;
};

export type AutomationDeclaration = AutomationDefinition & { readonly name: string };

/**
 * Declare one automation. The bare-function form is gone: a spec is always an object, because that is
 * the only place a mandatory `description` can live, and a description nobody is forced to write is a
 * description the studio never has.
 */
export function defineAutomation<
	S extends AnySchema = DefaultWorkspaceSchema,
	const TTrigger extends AutomationTrigger<S> = AutomationTrigger<S>
>(trigger: TTrigger, spec: AutomationSpec<S, TTrigger>): AutomationDefinition {
	if (!spec.description.trim()) throw new Error('Automation description cannot be empty');
	// The object form carries the author's generics, so it needs the unwrapping the bare function used
	// to get — otherwise the typed handler cannot be stored in the erased registry.
	const erased: AutomationSpec =
		spec.kind === 'deterministic'
			? {
					kind: 'deterministic',
					description: spec.description,
					handler: eraseAutomationHandler(spec.handler)
				}
			: spec;
	return { trigger: trigger as AutomationTrigger, spec: erased };
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
