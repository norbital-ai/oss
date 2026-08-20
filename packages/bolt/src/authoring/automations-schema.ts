import { Effect } from 'effect';
import type {
	AnySchema,
	BeforeApi,
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
}

/**
 * `src/+agent.ts`: how a workspace configures the agent Bolt runs inside it.
 *
 * Every field below reaches the runtime. That is worth stating because for a long time none of them
 * did: the compiler discovered no `+agent.ts` and synthesized `{ name, prompt: 'You are the <name>
 * workspace agent.', tools, skills }` instead, so a workspace declaring a scoped, write-capable
 * agent with a real operating prompt and a raised token budget shipped an unscoped one that had read
 * none of it.
 *
 * A `tools` allowlist used to sit beside `denyTools` and was honoured by neither. It is gone rather
 * than implemented, because the workspace's tools are its `+<name>.tool.ts` files — authoring one is
 * already the act of offering it — and `denyTools` is the one direction that says something the
 * filesystem does not.
 */
export interface AgentAutomationSpec {
	/** What this agent is for, as the manifest and the studio report it. */
	readonly description: string;
	/** Self-identification. `defineAutomation` bodies never carry this; only `+agent.ts` does. */
	readonly kind: 'agent';
	/** The standing task, joined onto `systemPrompt` so a turn opens knowing what it is here to do. */
	readonly task: string;
	/** How the agent should behave, as the first message of every turn. */
	readonly systemPrompt: string;
	/** The collections `read_collection` and `write_collection` may reach. Absent means every one. */
	readonly collections?: ReadonlyArray<string>;
	/** Platform or workspace tools withheld from the funnel. It cannot withhold a bound sandbox. */
	readonly denyTools?: ReadonlyArray<string>;
	/** The MCP servers whose tools this agent may call. Absent leaves the connector facility the gate. */
	readonly mcpServers?: ReadonlyArray<string>;
	/** Non-sandbox host tools to opt into. Sandbox tools arrive with the sandbox and are not listed. */
	readonly hostTools?: ReadonlyArray<string>;
	/** The model each turn is made against. Absent means the host's default. */
	readonly model?: string;
	/** `read` withholds `write_collection` entirely; `write` offers it. Absent reads as `read`. */
	readonly access?: 'read' | 'write';
	/** The output budget of one provider call — per call, not per turn. */
	readonly maxTokens?: number;
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
		return { trigger, spec };
	}
};

export const automation = AutomationAuthoring.declaration;
export const defineAutomation = AutomationAuthoring.definition;
