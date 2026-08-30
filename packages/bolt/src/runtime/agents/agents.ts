import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
	addAIUsage,
	AIUsage,
	EffectId,
	readAIUsage,
	type AgentEnqueueResult,
	type ChatDocumentRef,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import { AI, Connector, HostTools, Tasks } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	aliased,
	composer,
	executeBuilt,
	increment,
	transactionBuilt,
	transactionSql
} from '#lib/runtime/persistence.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { TurnResult, type TurnResult as TurnResultValue } from './agent-schemas.js';
export { TurnResult } from './agent-schemas.js';
import { RemoteRegistry } from '#lib/runtime/remotes.js';
import type { WhereCompileError } from '#lib/runtime/collections/read/where.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { WEB_AGENT_NAME } from '#lib/authoring/workspace-schema.js';
import { envoyPrincipalId } from '#lib/runtime/identity/static-identity.js';
import {
	TurnOutput,
	TurnPart,
	TurnStatus,
	StoredTurn,
	SettledTarget,
	closeUnpairedToolCalls,
	maxDelegationDepth,
	protectedAssistantTurns,
	pruneToolOutput,
	replayTurn,
	truncatePromptWindow,
	type PromptWindowTurn,
	type TurnSurface
} from './turn.js';
export { TurnPart, type TurnSurface } from './turn.js';

/**
 * The agent one turn runs as: the web agent, or one envoy.
 *
 * There is no declaration behind either. The web agent is defined entirely by *who is using it* —
 * it runs as the signed-in person, so their policies decide its tools, its collections and its
 * limits — and an envoy adds exactly one thing a policy cannot state, which is what it is for.
 *
 * `src/+agent.ts` used to sit here, carrying `tools`, `mcpServers`, `denyTools`, `hostTools`,
 * `collections`, `access`, `model` and `maxTokens`. Every one of those either duplicated a policy or
 * was a host default, and while it existed two people in one workspace were offered the same tools
 * however differently they were authorised.
 */
type ResolvedAgent = Readonly<{
	readonly name: string;
	/** The envoy's standing instruction, absent for the web agent. */
	readonly task?: string;
	/** `public` on an envoy anyone can message; absent for the web agent, which is never public. */
	readonly audience?: 'public' | 'authenticated';
	/** Whether this agent may create and coordinate delegated sandbox-agent sessions. */
	readonly delegation: 'enabled' | 'disabled';
}>;

/**
 * Which sandbox this turn works in — the tenant plane's counterpart to §10's personal plane.
 *
 * A person gets one tree, keyed by who they are. An envoy gets exactly one tree, keyed by the
 * principal its declaration mints. Documents are not stored in that tree: every document belongs to
 * a chat session through `chat_document`, so sharing delegated-agent state across an envoy cannot
 * share anything a sender uploaded.
 */
const sandboxKeyFor = (
	subject: Identity.Subject,
	agent: ResolvedAgent,
	_conversationId: string
): string => (agent.audience === undefined ? subject.userId : envoyPrincipalId(agent.name));
import {
	AgentModelUnavailable,
	McpToolError,
	SkillError,
	ToolNotAllowed
} from '#lib/runtime/agents/agent-errors.js';
import {
	executeHostTool,
	executePlatformTool,
	isPlatformTool,
	platformToolSpecs,
	readSkillBody
} from '#lib/runtime/agents/platform-tools.js';
import { callMcpTool } from '#lib/runtime/agents/mcp.js';
import {
	agentMessageForModel,
	parseAgentMessage,
	StoredAgentMessage,
	type StoredAgentMessage as StoredAgentMessageValue
} from '#lib/runtime/agents/agent-message.js';
import {
	executeSandboxTool,
	isSandboxTool,
	sandboxToolSpecs
} from '#lib/runtime/agents/sandbox-tools.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as ChatDocuments from '#lib/runtime/agents/documents.js';
import {
	chatInputForModel,
	chatInputText,
	parseStoredChatInput,
	type StoredChatInput
} from '#lib/runtime/agents/chat-messages.js';

const {
	agent_mailbox: agentMailbox,
	chat_session: chatSession,
	chat_message: chatMessage
} = SYSTEM_MODEL_TABLES;
type BuiltQuery = Parameters<typeof executeBuilt>[2];

export {
	AgentModelUnavailable,
	McpToolError,
	SkillError,
	ToolNotAllowed
} from '#lib/runtime/agents/agent-errors.js';
export {
	MCP_PROTOCOL_VERSION,
	McpCallToolRequest,
	McpCallToolResponse,
	McpCallToolResult,
	McpRequestMeta
} from '#lib/runtime/agents/mcp.js';

/** Owns resolve tool behavior at the agents boundary so validation and typed semantics stay consistent for every caller. */
const AgentTools = {
	resolve: (
		offered: ReadonlyArray<ToolDeclaration>,
		agentName: string,
		name: string
	): ToolDeclaration | ToolNotAllowed =>
		offered.find((tool) => tool.name === name) ??
		new ToolNotAllowed({ agent: agentName, tool: name }),
	mcpName: (server: string, tool: string): string =>
		`${server.replaceAll(':', '_')}:${tool.replaceAll(':', '_')}`,
	parseMcpName: (name: string): { readonly server: string; readonly tool: string } | undefined => {
		const separator = name.indexOf(':');
		return separator < 1 || separator === name.length - 1
			? undefined
			: { server: name.slice(0, separator), tool: name.slice(separator + 1) };
	}
};
export const resolveTool = AgentTools.resolve;
export const mcpToolName = AgentTools.mcpName;
export const parseMcpToolName = AgentTools.parseMcpName;

const StoredTurnMessageRow = Schema.Struct({ id: Schema.String, content: StoredTurn });
const decodeStoredTurnMessageRow = Schema.decodeUnknownOption(StoredTurnMessageRow);
const SandboxSpawnActionInput = Schema.Struct({
	task: Schema.NonEmptyString,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
});
const SandboxAdmitActionInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	agentName: Schema.NonEmptyString,
	message: StoredAgentMessage,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
});
const SandboxTaskActionInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const SandboxAgentActionInput = Schema.Struct({ agentId: Schema.NonEmptyString });

/** A completed delegated turn, returned to the parent as the answer to its await tool call. */
const SettledTargetRow = Schema.Struct({ content: SettledTarget });
const AgentModelCatalog = Schema.Struct({
	defaultModel: Schema.NonEmptyString,
	options: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			contextLength: Schema.optionalKey(
				Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
			)
		})
	)
});
const decodeAgentModelCatalog = Schema.decodeUnknownOption(AgentModelCatalog);
type AgentModelDescriptor = Readonly<{ readonly id: string; readonly contextTokens: number }>;

const NullableString = Schema.Union([Schema.String, Schema.Null]);
const ConversationVisibility = Schema.Literals(['personal', 'envoy_dm', 'envoy_group']);
const ConversationRow = Schema.Struct({
	id: Schema.String,
	agent_name: Schema.String,
	title: NullableString,
	user_id: Schema.String,
	visibility: ConversationVisibility,
	envoy_key: NullableString
});
const AuthorizedConversationRow = Schema.Struct({
	...ConversationRow.fields,
	sandbox_key: Schema.String
});
const StoredConversationRow = Schema.Struct({
	conversation_id: Schema.String,
	agent_name: Schema.String,
	title: NullableString,
	user_id: Schema.String,
	sandbox_key: Schema.String,
	visibility: ConversationVisibility,
	envoy_key: NullableString
});
const MessageRow = Schema.Struct({
	role: Schema.String,
	content: Schema.Json,
	/**
	 * The turn this row belongs to, or nothing for a row no turn produced.
	 *
	 * A delegated session's rows come back inside its parent's history, so the reader's projection
	 * needs to know which call's transcript each row belongs to. Ordering cannot answer that: a
	 * subagent writes while its parent is suspended, so its rows sit in the middle of the parent's
	 * sequence and read as messages the person sent.
	 */
	turn_id: Schema.optionalKey(NullableString)
});

/** The stored rows a replay reads; the decoder shapes are built beside the row schema, once. */
const MessageContent = Schema.Struct({
	parts: Schema.Array(TurnPart),
	subject: Schema.optionalKey(Identity.Subject),
	usage: Schema.optionalKey(AIUsage)
});

const decodeMessageRow = Schema.decodeUnknownOption(MessageRow);
const decodeMessageContent = Schema.decodeUnknownOption(MessageContent);
const decodeStoredConversationRow = Schema.decodeUnknownOption(StoredConversationRow);
const conversationRow = (
	row: unknown
): Schema.Schema.Type<typeof AuthorizedConversationRow> | undefined => {
	const decoded = decodeStoredConversationRow(row);
	if (decoded._tag === 'None') return undefined;
	const { conversation_id: id, ...fields } = decoded.value;
	return { id, ...fields };
};

const ConversationLinkRow = Schema.Struct({
	conversation_id: Schema.String,
	parent_id: Schema.Union([Schema.String, Schema.Null])
});
const decodeConversationLinkRow = Schema.decodeUnknownOption(ConversationLinkRow);
const TaskIdRow = Schema.Struct({ task_id: Schema.NonEmptyString });
const decodeTaskIdRow = Schema.decodeUnknownOption(TaskIdRow);
const RecoveryCountRow = Schema.Struct({
	recovered: Schema.Union([Schema.Number, Schema.String])
});
const decodeRecoveryCountRow = Schema.decodeUnknownOption(RecoveryCountRow);

export type AgentExecutionError =
	| Workspace.WorkspaceLookupError
	| AccessControl.AccessDenied
	| Database.FacilityError
	| SkillError
	| ToolNotAllowed
	| ApprovalConflict
	| PendingApproval
	| WhereCompileError
	| Collections.MutationError
	| Collections.MutationPhaseFailure
	| AuthoredRefusal
	| ChatDocuments.ChatDocumentError
	| InvocationBudget.NestingLimitExceeded
	| AgentModelUnavailable;

export type Interface = Readonly<{
	/** Host startup hook. Conductor calls this once for each loaded environment after a restart. */
	readonly recover: (effectId: EffectIdType) => Effect.Effect<void, Database.FacilityError>;
	/** Opens an empty conversation; a session's source files attach to it by key, never at open time. */
	readonly open: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string
	) => Effect.Effect<
		void,
		Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError
	>;
	/** Persists and executes one complete turn in this invocation. */
	readonly enqueue: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string,
		turnId: string,
		message: StoredChatInput,
		model?: string
	) => Effect.Effect<AgentEnqueueResult, AgentExecutionError>;
	/** Executes one already-persisted exact turn. */
	readonly execute: (
		effectId: EffectIdType,
		conversationId: string,
		turnId: string,
		/**
		 * The transport surface the turn reflects into, when a transport is watching one. Its
		 * `observe` is called with the parts after each durable commit — presentation and pacing
		 * belong to the surface, never to this service. Absent, the web agent's turns: the chat
		 * itself is the surface.
		 */
		surface?: TurnSurface
	) => Effect.Effect<
		TurnResultValue,
		AgentExecutionError
		// A turn runs authored code — its tools reach collections and remotes — so a business rule
		// can refuse it, and a delegated turn can be stopped by the nesting bound. Both were
		// reaching this boundary already; only the declaration did not say so, which is how a
		// refusal here left as something a caller could not name.
	>;
	readonly attachFile: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		file: ChatDocumentRef
	) => Effect.Effect<
		void,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly readMedia: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		Readonly<{ readonly file: ChatDocumentRef; readonly bytes: Uint8Array }>,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly removeFile: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		void,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly interrupt: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, AgentExecutionError>;
	readonly stop: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, AgentExecutionError>;
	readonly resume: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, AgentExecutionError>;
	readonly updateVerifier: (
		effectId: EffectIdType,
		conversationId: string,
		verifier: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	/**
	 * The skills this subject may load — its policies', not an agent declaration's.
	 *
	 * It takes a subject rather than an agent name because a skill is capability: two people on the
	 * same web agent are offered different skills, and asking by agent name could not express that.
	 */
	readonly listSkills: (subject: Identity.Subject) => ReadonlyArray<string>;
	readonly readSkill: (
		subject: Identity.Subject,
		name: string
	) => Effect.Effect<string, SkillError>;
}>;
/** Identifies the agents service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Agents');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const access = yield* AccessControl.Service;
		const ai = yield* AI.Service;
		const database = yield* Database.Service;
		const tasks = yield* Tasks.Service;
		const collections = yield* Collections.Service;
		const hostTools = yield* HostTools.Service;
		const connector = yield* Connector.Service;
		const documents = yield* ChatDocuments.Service;
		const remotes = yield* RemoteRegistry;

		/**
		 * Closes work left live by a previous host process.
		 *
		 * This is deliberately not called by ordinary service methods. The invocation layer is rebuilt
		 * for every call, so invocation-local caching would let a later request interrupt a concurrently
		 * running turn. Conductor owns the process-memory, once-per-environment startup gate.
		 */
		const recoverRunningTurns = Effect.fn('Agents.recover')(function* (effectId: EffectIdType) {
			const recovered = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `with interrupted_turns as (
						update "chat_message" message
						set "content" = jsonb_set(
							jsonb_set(message."content", '{status}', '"interrupted"'::jsonb, true),
							'{parts}',
							coalesce(message."content"->'parts', '[]'::jsonb) || coalesce((
								select jsonb_agg(jsonb_build_object(
									'kind', 'tool-result',
									'id', call->>'id',
									'name', call->>'name',
									'output', jsonb_build_object(
										'terminal', true,
										'error', 'tool interrupted before completion',
										'reason', 'host-restarted'
									)
								))
								from jsonb_array_elements(coalesce(message."content"->'parts', '[]'::jsonb)) call
								where call->>'kind' = 'tool'
									and not exists (
										select 1
										from jsonb_array_elements(coalesce(message."content"->'parts', '[]'::jsonb)) result
										where result->>'kind' = 'tool-result' and result->>'id' = call->>'id'
									)
							), '[]'::jsonb),
							true
						), "updated_at" = now(), "row_version" = message."row_version" + 1
						where message."role" = 'assistant'
							and message."content"->>'status' = 'running'
						returning message."id"
					)
					select count(*)::integer as "recovered" from interrupted_turns`,
				parameters: []
			});
			const count = decodeRecoveryCountRow(recovered.rows[0]);
			if (count._tag === 'Some' && Number(count.value.recovered) > 0) {
				// Interrupted turns are durable rows the panel reads back itself; recovery only repairs
				// them, so there is nothing further to deliver here.
			}
		});

		/** The host catalog is read once per invocation; its context length is the prompt-window seam. */
		const readModelCatalog = yield* Effect.cached(
			ai.execute(EffectId.make('agents:model-catalog'), { _tag: 'Models' }).pipe(
				Effect.flatMap((response) => {
					const decoded = decodeAgentModelCatalog(response.output);
					if (decoded._tag === 'None') {
						return Effect.fail(
							new AgentModelUnavailable({ model: 'catalog', reason: 'invalid-catalog' })
						);
					}
					return Effect.succeed(decoded.value);
				})
			)
		);
		const resolveModel = Effect.fn('Agents.resolveModel')(function* (requested?: string) {
			const catalog = yield* readModelCatalog;
			const modelId = requested ?? catalog.defaultModel;
			const selected = catalog.options.find(({ id }) => id === modelId);
			if (selected === undefined) {
				return yield* new AgentModelUnavailable({ model: modelId, reason: 'not-found' });
			}
			if (selected.contextLength === undefined) {
				return yield* new AgentModelUnavailable({ model: modelId, reason: 'context-missing' });
			}
			return {
				id: selected.id,
				contextTokens: selected.contextLength
			} satisfies AgentModelDescriptor;
		});

		/**
		 * Commits a chat mutation.
		 *
		 * The rows are the durable record; readers (the conversation view, the transcript, the panel)
		 * all read them back directly, so a committed write needs no second delivery step.
		 */
		const syncMutation = Effect.fn('Agents.syncMutation')(function* (
			effectId: EffectIdType,
			query: BuiltQuery,
			collections: ReadonlyArray<'chat_session' | 'chat_message'>
		) {
			const response = yield* executeBuilt(effectId, database, query);
			return response;
		});
		const syncTransaction = Effect.fn('Agents.syncTransaction')(function* (
			effectId: EffectIdType,
			queries: ReadonlyArray<BuiltQuery>,
			collections: ReadonlyArray<'chat_session' | 'chat_message'>
		) {
			if (queries.length === 0) return;
			yield* transactionBuilt(effectId, database, queries);
		});

		/**
		 * The conversations one signed-in caller may inspect, expressed once for every direct read.
		 *
		 * Ownership remains the ordinary rule. The only wider inbox is an administrator's view of a
		 * currently declared public envoy. Its row must also carry every invariant `openConversation`
		 * writes for that surface: an envoy visibility, matching agent/key, and that envoy's workbench
		 * key. Requiring the key shape prevents a formerly authenticated/private envoy
		 * row becoming readable merely because a later release changes that envoy's audience to public.
		 */
		const publicEnvoys = workspace.definition.envoys
			.filter(({ audience }) => audience === 'public')
			.map(({ name }) => name);
		const canReadConversation = (
			subject: Identity.Subject,
			conversation: Schema.Schema.Type<typeof AuthorizedConversationRow>
		): boolean =>
			conversation.user_id === subject.userId ||
			(subject.admin === true &&
				(conversation.visibility === 'envoy_dm' || conversation.visibility === 'envoy_group') &&
				conversation.envoy_key !== null &&
				publicEnvoys.includes(conversation.envoy_key) &&
				conversation.agent_name === conversation.envoy_key &&
				conversation.sandbox_key === envoyPrincipalId(conversation.envoy_key));

		const requireReadableConversation = Effect.fn('Agents.requireReadableConversation')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({
						conversation_id: chatSession.conversation_id,
						agent_name: chatSession.agent_name,
						title: chatSession.title,
						user_id: chatSession.user_id,
						sandbox_key: chatSession.sandbox_key,
						visibility: chatSession.visibility,
						envoy_key: chatSession.envoy_key
					})
					.from(chatSession)
					.where(eq(chatSession.conversation_id, conversationId))
					.limit(1)
			);
			const conversation = conversationRow(result.rows[0]);
			if (conversation === undefined || !canReadConversation(subject, conversation)) {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: conversationId,
					reason: 'unknown conversation'
				});
			}
			return conversation;
		});
		const requireControllableConversation = Effect.fn('Agents.requireControllableConversation')(
			function* (effectId: EffectIdType, subject: Identity.Subject, conversationId: string) {
				const conversation = yield* requireReadableConversation(effectId, subject, conversationId);
				if (conversation.user_id !== subject.userId || conversation.visibility !== 'personal') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'only the owner may control this agent conversation'
					});
				}
				return conversation;
			}
		);

		/**
		 * The tools one turn is offered, decided by the subject's policies and nothing else.
		 *
		 * This is the whole of §5 in one function: two people in one workspace get different tools on
		 * the *same* web agent because they hold different policies, and an envoy gets what its
		 * declared policies name. Adding a `capabilities/tools/+<name>.ts` file widens **nobody** until
		 * a policy names it.
		 *
		 * It replaces four fields on a declaration none of which were enforced. The funnel returned the
		 * platform set, the sandbox set and every workspace tool unconditionally, so a workspace that
		 * declared `access: 'read'` shipped an agent holding `write_collection` and one that named
		 * `denyTools` shipped an agent holding all of them.
		 *
		 * `write_collection` follows the grants, which is the honest reading of "may this subject
		 * write": a policy that grants no `create`, `update` or `delete` on anything has said the
		 * holder does not write, and offering the tool anyway only moves the refusal later. `access:
		 * 'read' | 'write'` was a second, coarser way of saying the same thing, in a place a reviewer
		 * comparing it against the grants would not look.
		 *
		 * Sandbox tools are normally offered unconditionally. A sandbox is per-principal and holds no
		 * workspace data (§10), so reaching one grants nothing. A narrow ingress envoy can nevertheless
		 * disable delegation as a behavioral boundary: in that case none of the coordination tools are
		 * offered, and the execution funnel below enforces the same boundary on direct calls.
		 */
		const allowedTools = (
			subject: Identity.Subject,
			agent: ResolvedAgent
		): ReadonlyArray<ToolDeclaration> => {
			const granted = access.capabilities(subject);
			const mayWrite = writesForSubject(subject);
			const authored = workspace.definition.tools
				.filter((tool) =>
					tool.mcp === undefined ? granted.tools.has(tool.name) : granted.mcp.has(tool.mcp.server)
				)
				.filter((tool) => agent.delegation === 'enabled' || !isSandboxTool(tool.name));
			const authoredNames = new Set(authored.map(({ name }) => name));
			const platform = platformToolSpecs.filter(
				(tool) =>
					!authoredNames.has(tool.name) &&
					(tool.name !== 'write_collection' || mayWrite) &&
					(tool.name !== 'search_envoy_history' || agent.name !== WEB_AGENT_NAME)
			);
			return [
				...platform,
				...(agent.delegation === 'disabled'
					? []
					: sandboxToolSpecs.filter((tool) => !authoredNames.has(tool.name))),
				...authored
			];
		};
		const allowedSkills = (subject: Identity.Subject) =>
			workspace.definition.skills.filter(({ name }) =>
				access.capabilities(subject).skills.has(name)
			);

		/**
		 * Whether any policy this subject holds grants a write on anything at all.
		 *
		 * The gate on `write_collection`, read off the grants rather than off a separate `access`
		 * field. A subject with no write grant anywhere cannot succeed at a write, so offering the tool
		 * would only teach the model to try.
		 */
		const writesForSubject = (subject: Identity.Subject): boolean =>
			workspace.definition.collections.some((collection) =>
				(['create', 'update', 'delete'] as const).some(
					(action) => access.explain(subject, action, collection.name).allowed
				)
			);

		/** Collection names this subject may use through the generic data tools. */
		const reachableCollections = (
			subject: Identity.Subject,
			action: 'read' | 'write'
		): ReadonlyArray<string> =>
			workspace.definition.collections
				.filter(({ name }) =>
					action === 'read'
						? access.explain(subject, 'read', name).allowed
						: (['create', 'update', 'delete'] as const).some(
								(write) => access.explain(subject, write, name).allowed
							)
				)
				.map(({ name }) => name);

		/**
		 * The agent a turn is for: the web agent, or one declared envoy.
		 *
		 * `web` is reserved at authoring time (`envoy()` refuses it) so this cannot be shadowed, and it
		 * needs no declaration to resolve because there is nothing in one. Anything else must be a
		 * declared envoy — a name that is neither is a refusal, reported as an access denial rather
		 * than a lookup failure because from the caller's side "no such agent" and "not yours" are the
		 * same answer and the difference is worth not disclosing.
		 */
		const resolveAgent = Effect.fn('Agents.resolveAgent')(function* (agentName: string) {
			if (agentName === WEB_AGENT_NAME)
				return { name: WEB_AGENT_NAME, delegation: 'enabled' } satisfies ResolvedAgent;
			const envoy = workspace.definition.envoys.find(({ name }) => name === agentName);
			if (envoy === undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: agentName,
					reason: 'unknown agent'
				});
			}
			return {
				name: envoy.name,
				task: envoy.task,
				audience: envoy.audience,
				delegation: envoy.delegation
			} satisfies ResolvedAgent;
		});

		/**
		 * The conversation row a turn writes into, carrying what kind of thread it is.
		 *
		 * `visibility` and `envoy_key` were read by `conversation-selector.ts` and written by nothing:
		 * neither column existed, so `visibility` was always `undefined`, the group bucket was
		 * permanently empty, and a public envoy's threads never reached the admin inbox they were
		 * routed to. Both are populated here, at the one place a conversation is opened.
		 *
		 * Ownership and workbench scope are separate fields. `user_id` owns the chat; `sandbox_key`
		 * identifies the delegated-agent workbench. Every envoy session uses its envoy principal for the
		 * latter, while its documents stay isolated by the session id.
		 */
		const openConversation = Effect.fn('Agents.openConversation')(function* (
			effectId: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			conversationId: string
		) {
			const group = conversationId.includes(':group:');
			yield* syncMutation(
				effectId,
				composer
					.insert(chatSession)
					.values({
						conversation_id: conversationId,
						agent_name: agent.name,
						user_id: subject.userId,
						sandbox_key: sandboxKeyFor(subject, agent, conversationId),
						visibility:
							agent.name === WEB_AGENT_NAME ? 'personal' : group ? 'envoy_group' : 'envoy_dm',
						envoy_key: agent.name === WEB_AGENT_NAME ? null : agent.name
					})
					.onConflictDoNothing(),
				['chat_session']
			);
		});

		type AdmittedAgentInput = StoredChatInput | StoredAgentMessageValue;
		const admitTurn = Effect.fn('Agents.admitTurn')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			agentName: string,
			conversationId: string,
			turnId: string,
			message: AdmittedAgentInput,
			options: Readonly<{
				readonly parentId?: string;
				readonly depth?: number;
				readonly model?: string;
			}> = {}
		) {
			const agent = yield* resolveAgent(agentName);
			yield* access.authorize(subject, 'agent', agentName);
			if (options.parentId === undefined) {
				const existing = yield* executeBuilt(
					EffectId.make(`${effectId}:existing-conversation`),
					database,
					composer
						.select({
							conversation_id: chatSession.conversation_id,
							agent_name: chatSession.agent_name,
							title: chatSession.title,
							user_id: chatSession.user_id,
							sandbox_key: chatSession.sandbox_key,
							visibility: chatSession.visibility,
							envoy_key: chatSession.envoy_key
						})
						.from(chatSession)
						.where(eq(chatSession.conversation_id, conversationId))
						.limit(1)
				);
				const row = existing.rows[0];
				if (row !== undefined) {
					const conversation = conversationRow(row);
					if (
						conversation === undefined ||
						!canReadConversation(subject, conversation) ||
						conversation.user_id !== subject.userId ||
						conversation.agent_name !== agent.name
					) {
						return yield* new AccessControl.AccessDenied({
							action: 'agent',
							resource: conversationId,
							reason: 'conversation belongs to a different agent or owner'
						});
					}
				}
			}
			const title =
				message.kind === 'agent_message' ? undefined : chatInputText(message).slice(0, 48);
			const group = conversationId.includes(':group:');
			yield* transactionBuilt(effectId, database, [
				composer
					.insert(chatSession)
					.values({
						conversation_id: conversationId,
						agent_name: agent.name,
						user_id: subject.userId,
						sandbox_key: sandboxKeyFor(subject, agent, conversationId),
						title:
							message.kind === 'agent_message'
								? message.text.slice(0, 48)
								: chatInputText(message).slice(0, 48),
						parent_id: options.parentId ?? null,
						visibility:
							options.parentId !== undefined || agent.name === WEB_AGENT_NAME
								? 'personal'
								: group
									? 'envoy_group'
									: 'envoy_dm',
						envoy_key:
							options.parentId !== undefined || agent.name === WEB_AGENT_NAME ? null : agent.name
					})
					.onConflictDoNothing(),
				// The pre-read gives a typed refusal for ordinary conflicts; this in-transaction assertion
				// closes the concurrent-insert race before any message or task is written.
				transactionSql(
					`select case when exists (
						select 1 from "chat_session"
						where "conversation_id" = $1 and "user_id" = $2 and "agent_name" = $3
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[conversationId, subject.userId, agent.name]
				),
				...(title === undefined
					? []
					: [
							composer
								.update(chatSession)
								.set({ title })
								.where(
									and(
										eq(chatSession.conversation_id, conversationId),
										or(
											isNull(chatSession.title),
											eq(chatSession.title, ''),
											eq(chatSession.title, 'New conversation')
										)
									)
								)
						]),
				composer
					.insert(chatMessage)
					.values({
						conversation_id: conversationId,
						turn_id: turnId,
						role: 'user',
						content: JSON.stringify(message)
					})
					.onConflictDoNothing({
						target: [chatMessage.conversation_id, chatMessage.turn_id, chatMessage.role]
					}),
				composer
					.insert(chatMessage)
					.values({
						conversation_id: conversationId,
						turn_id: turnId,
						role: 'assistant',
						content: JSON.stringify({
							id: turnId,
							status: 'running',
							depth: options.depth ?? 0,
							parts: [],
							subject,
							agent_name: agent.name,
							...(options.model === undefined ? {} : { model: options.model }),
							usage_unreported: false
						})
					})
					.onConflictDoNothing({
						target: [chatMessage.conversation_id, chatMessage.turn_id, chatMessage.role]
					}),
				composer
					.insert(agentMailbox)
					.values({ conversation_id: conversationId, status: 'active' })
					.onConflictDoNothing({ target: agentMailbox.conversation_id }),
				transactionSql(
					`select case when exists (
						select 1 from "agent_mailbox"
						where "conversation_id" = $1 and "status" = 'active'
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[conversationId]
				),
				// A caller owns the turn id so an unknown transport outcome can be retried safely. The two
				// immutable transcript rows must still describe this exact admission; reusing an id for
				// different work rolls the entire transaction back instead of returning a false receipt.
				transactionSql(
					`select case when exists (
						select 1 from "chat_message"
						where "conversation_id" = $1 and "turn_id" = $2 and "role" = 'user'
							and "content" = $3::jsonb
					) and exists (
						select 1 from "chat_message"
						where "conversation_id" = $1 and "turn_id" = $2 and "role" = 'assistant'
							and ("content"->>'model') is not distinct from $4::text
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[conversationId, turnId, JSON.stringify(message), options.model ?? null]
				)
			]);
			return { conversationId, taskId: turnId, turnId };
		});

		const executeTool = Effect.fn('Agents.executeTool')(function* (
			agent: ResolvedAgent,
			name: string,
			input: Schema.Json,
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string,
			depth: number,
			modelId: string
		) {
			const sandboxKey = sandboxKeyFor(subject, agent, conversationId);
			const allowlist = allowedTools(subject, agent);
			const declared = allowlist.find((tool) => tool.name === name);
			// A platform or sandbox name was admitted on the strength of being one, which made `denyTools`
			// and `access` advisory: an agent that was never offered `write_collection` could still call
			// it by name. The allowlist is the answer for every kind now, and an MCP call is admitted only
			// when a policy this subject holds named that server.
			if (declared === undefined) {
				return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
			}
			const context = {
				effectId,
				subject,
				agentName: agent.name,
				conversationId,
				database,
				envoyWideHistory: access.capabilities(subject).envoyHistory,
				// The skills this subject's policies grant, not a list an agent declaration carried. A
				// skill is capability, so it is granted where every other capability is.
				skills: allowedSkills(subject),
				toolNames: allowlist.map(({ name: tool }) => tool),
				collectionNames: [
					...new Set([
						...reachableCollections(subject, 'read'),
						...reachableCollections(subject, 'write')
					])
				],
				workspace,
				collections,
				hostTools
			};
			if (isPlatformTool(name)) {
				if (name === 'load_media') {
					const decoded = Schema.decodeUnknownOption(
						Schema.Struct({ storageKey: Schema.NonEmptyString })
					)(input);
					if (decoded._tag === 'None') {
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: no storageKey` });
					}
					const media = yield* documents
						.media(EffectId.make(`${effectId}:media`), conversationId, decoded.value.storageKey)
						.pipe(Effect.catch((failure) => Effect.succeed({ error: failure.message })));
					if ('error' in media) return media;
					// A media part means an image the model can see: sources that are not images are
					// refused by name, and one oversized object is refused rather than smuggled in.
					if (!media.file.mime_type.startsWith('image/')) {
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: not an image` });
					}
					if (media.bytes.byteLength > 20 * 1024 * 1024) {
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: > 20 MiB` });
					}
					return {
						file: media.file,
						bytesBase64: Buffer.from(media.bytes).toString('base64')
					};
				}
				return yield* executePlatformTool(name, input, context);
			}
			if (isSandboxTool(name)) {
				// The sandbox action taxonomy is FacilityError | ToolNotAllowed | NestingLimitExceeded;
				// an unavailable child model is reported as the tool it refused to run.
				const sandboxError = (error: unknown) =>
					error instanceof Database.FacilityError ||
					error instanceof ToolNotAllowed ||
					error instanceof InvocationBudget.NestingLimitExceeded
						? error
						: new ToolNotAllowed({ agent: agent.name, tool: name });
				const action = <A>(effect: Effect.Effect<A, unknown>) =>
					effect.pipe(
						Effect.map((value) => value as Schema.Json),
						Effect.mapError(sandboxError)
					);
				const decodeAction = <S extends Schema.Top>(schema: S, value: Schema.Json) =>
					Schema.decodeUnknownEffect(schema)(value).pipe(
						Effect.mapError(() => new ToolNotAllowed({ agent: agent.name, tool: name }))
					);
				return yield* executeSandboxTool(name, input, {
					effectId,
					subject,
					sandboxKey,
					agentName: agent.name,
					conversationId,
					database,
					budget: InvocationBudget.make(depth),
					spawn: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxSpawnActionInput, value);
								const childId = `agent:${String(actionId)}`;
								const admitted = yield* admitTurn(
									actionId,
									subject,
									agent.name,
									childId,
									String(actionId),
									{ kind: 'user_message', text: parsed.task },
									{ parentId: conversationId, depth: parsed.depth, model: modelId }
								);
								return {
									agentId: childId,
									taskId: admitted.taskId,
									status: 'running'
								};
							})
						),
					admit: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxAdmitActionInput, value);
								const admitted = yield* admitTurn(
									actionId,
									subject,
									parsed.agentName,
									parsed.agentId,
									String(actionId),
									parsed.message,
									{ depth: parsed.depth, model: modelId }
								);
								return {
									agentId: parsed.agentId,
									taskId: admitted.taskId,
									status: 'running'
								};
							})
						),
					awaitTarget: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxTaskActionInput, value);
								return yield* awaitDelegatedTurn(
									EffectId.make(`${actionId}:await`),
									parsed.agentId,
									parsed.taskId
								);
							})
						),
					interrupt: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxAgentActionInput, value);
								return {
									agentId: parsed.agentId,
									interruptedTaskIds: yield* interruptConversation(actionId, parsed.agentId)
								};
							})
						),
					stop: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxAgentActionInput, value);
								return {
									agentId: parsed.agentId,
									stoppedTaskIds: yield* stopConversation(actionId, parsed.agentId)
								};
							})
						),
					resume: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxAgentActionInput, value);
								return {
									agentId: parsed.agentId,
									resumedTaskIds: yield* resumeConversation(actionId, parsed.agentId)
								};
							})
						)
				});
			}
			if (declared?.mcp !== undefined)
				return yield* callMcpTool(declared.mcp, input, effectId, connector);
			const AuthoredLookup = Schema.Union([
				Schema.Struct({ _tag: Schema.Literal('hit'), value: Schema.Json }),
				Schema.Struct({ _tag: Schema.Literal('miss') })
			]);
			type AuthoredLookup = typeof AuthoredLookup.Type;
			const authored = yield* remotes.invoke(name, input, subject, effectId).pipe(
				Effect.map((value): AuthoredLookup => ({ _tag: 'hit', value })),
				Effect.catch((error): Effect.Effect<AuthoredLookup> =>
					error instanceof DispatchError && error.code === 'unknown_remote'
						? Effect.succeed({ _tag: 'miss' })
						: Effect.succeed({
								_tag: 'hit',
								value: { error: error instanceof Error ? error.message : String(error) }
							})
				)
			);
			if (authored._tag === 'hit') return authored.value;
			// The host-tools funnel, reached by a name the allowlist offered and nothing else resolved.
			// `hostTools` — an opt-in list on the agent declaration, declared by no workspace and read by
			// nothing until it was wired up — is gone with the declaration; a host tool is admitted here
			// because a policy named it, like everything else.
			if (name.startsWith('sandbox_') || declared?.command.startsWith('host:') === true) {
				return yield* executeHostTool(name, input, context);
			}
			return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
		});

		/** The exact tool offer a turn presents, including the collections its grants can reach. */
		const toolsFor = (
			subject: Identity.Subject,
			agent: ResolvedAgent
		): ReadonlyArray<Schema.Json> => {
			return allowedTools(subject, agent).map(({ name, description, command, inputSchema }) => {
				if (name !== 'read_collection' && name !== 'write_collection') {
					return inputSchema === undefined
						? { name, description, command }
						: { name, description, command, inputSchema };
				}
				const allowed = reachableCollections(
					subject,
					name === 'read_collection' ? 'read' : 'write'
				);
				return {
					name,
					description:
						allowed.length === 0
							? description
							: `${description} Allowed collections: ${allowed.join(', ')}.`,
					command
				};
			});
		};

		/**
		 * Replays stored rows through the hard context window used by every ordinary invocation.
		 *
		 * Rows sharing a turn id are one removal unit. The stored assistant row may expand into several
		 * provider messages, but that expansion happens inside the unit, so a tool call and its result
		 * can never be separated by truncation.
		 */
		const promptFor = (
			agent: ResolvedAgent,
			rows: ReadonlyArray<unknown>,
			subject: Identity.Subject,
			conversationId: string,
			contextTokens: number
		): Array<Schema.Json> => {
			const decodedRows = rows.map((row) => decodeMessageRow(row));
			const protectedRows = new Set<number>();
			for (let index = decodedRows.length - 1; index >= 0; index -= 1) {
				const row = decodedRows[index];
				if (row?._tag !== 'Some' || row.value.role !== 'assistant') continue;
				protectedRows.add(index);
				if (protectedRows.size === protectedAssistantTurns) break;
			}
			for (let index = decodedRows.length - 1; index >= 0; index -= 1) {
				const row = decodedRows[index];
				if (row?._tag !== 'Some' || row.value.role !== 'user') continue;
				protectedRows.add(index);
				break;
			}
			const fixed: Array<Schema.Json> = [
				{ role: 'system', content: workspace.definition.prompt },
				...(agent.task === undefined ? [] : [{ role: 'system', content: agent.task }])
			];
			const units = new Map<
				string,
				{ messages: Array<Schema.Json>; protected: boolean; usage?: AIUsage }
			>();
			let openUserTurn: string | undefined;
			for (let index = 0; index < decodedRows.length; index += 1) {
				const decoded = decodedRows[index];
				if (decoded?._tag !== 'Some') continue;
				let messages: ReadonlyArray<Schema.Json> = [];
				let usage: AIUsage | undefined;
				const input = parseStoredChatInput(decoded.value.content);
				if (input !== null) {
					messages = [{ role: 'user', content: chatInputForModel(input) }];
				} else {
					const relayed = parseAgentMessage(decoded.value.content);
					if (relayed !== null) {
						messages = [{ role: 'user', content: agentMessageForModel(relayed) }];
					} else {
						const whole = decodeMessageContent(decoded.value.content);
						if (whole._tag === 'None') continue;
						const isolated =
							conversationId.includes(':group:') &&
							whole.value.subject !== undefined &&
							whole.value.subject.userId !== subject.userId
								? whole.value.parts.filter((part) => part.kind !== 'tool-result')
								: whole.value.parts;
						const denominator = Math.max(decodedRows.length - 1, 1);
						const ageFraction = (decodedRows.length - 1 - index) / denominator;
						messages = replayTurn(pruneToolOutput(isolated, ageFraction, protectedRows.has(index)));
						usage = whole.value.usage;
					}
				}
				const turnId = decoded.value.turn_id;
				if (decoded.value.role === 'user' && !(typeof turnId === 'string' && turnId.length > 0)) {
					openUserTurn = `row:${index}`;
				}
				const key =
					typeof turnId === 'string' && turnId.length > 0
						? turnId
						: decoded.value.role === 'assistant' && openUserTurn !== undefined
							? openUserTurn
							: `row:${index}`;
				const current = units.get(key) ?? { messages: [], protected: false };
				current.messages.push(...messages);
				current.protected ||= protectedRows.has(index);
				if (usage !== undefined) current.usage = usage;
				units.set(key, current);
				if (decoded.value.role === 'assistant') openUserTurn = undefined;
			}
			const replay = truncatePromptWindow(
				[...units.values()] satisfies ReadonlyArray<PromptWindowTurn>,
				contextTokens,
				fixed
			);
			return [...fixed, ...replay];
		};

		/** Adds one usage delta to this session and every parent session above it. */
		const recordUsage = Effect.fn('Agents.recordUsage')(function* (
			effectId: EffectIdType,
			conversationId: string,
			usage: AIUsage | undefined,
			turnsCounted: number,
			turnsUnreported: number
		) {
			const lineage: Array<string> = [];
			let current: string | null = conversationId;
			for (let depth = 0; current !== null && depth <= maxDelegationDepth; depth += 1) {
				const result = yield* executeBuilt(
					EffectId.make(`${effectId}:lineage:${depth}`),
					database,
					composer
						.select({
							conversation_id: chatSession.conversation_id,
							parent_id: chatSession.parent_id
						})
						.from(chatSession)
						.where(eq(chatSession.conversation_id, current))
						.limit(1)
				);
				const decoded = decodeConversationLinkRow(result.rows[0]);
				if (decoded._tag === 'None') break;
				lineage.push(decoded.value.conversation_id);
				current = decoded.value.parent_id;
			}
			const costUsd = usage?.costUsd ?? 0;
			const costMicroUnits = Math.round(usage?.costMicroUnits ?? 0);
			const totalTokens = Math.round(usage?.totalTokens ?? 0);
			yield* syncTransaction(
				effectId,
				lineage.map((id) =>
					composer
						.update(chatSession)
						.set({
							usage_cost_usd: increment(chatSession.usage_cost_usd, costUsd),
							usage_cost_micro_units: increment(chatSession.usage_cost_micro_units, costMicroUnits),
							...(usage?.costCurrency === undefined
								? {}
								: { usage_cost_currency: usage.costCurrency }),
							usage_total_tokens: increment(chatSession.usage_total_tokens, totalTokens),
							usage_turns_counted: increment(chatSession.usage_turns_counted, turnsCounted),
							usage_turns_unreported: increment(chatSession.usage_turns_unreported, turnsUnreported)
						})
						.where(eq(chatSession.conversation_id, id))
				),
				['chat_session']
			);
		});

		let service: Interface;

		/** The host tracks only the exact invocation currently alive; no database row is claimed. */
		const runExactTurn = Effect.fn('Agents.runExactTurn')(function* (
			effectId: EffectIdType,
			conversationId: string,
			turnId: string,
			surface?: TurnSurface
		) {
			const turnEffectId = EffectId.make(turnId);
			return yield* Effect.acquireUseRelease(
				Effect.ignore(
					tasks.execute(EffectId.make(`${effectId}:active`), { _tag: 'Active', taskId: turnId })
				),
				() => service.execute(turnEffectId, conversationId, turnId, surface),
				() =>
					Effect.ignore(
						tasks.execute(EffectId.make(`${effectId}:settled`), {
							_tag: 'Settled',
							taskId: turnId
						})
					)
			);
		});

		/**
		 * Joins one exact child turn without creating durable parent continuation state.
		 *
		 * The parent names the exact child row and waits for that one turn. No queue row, polling lease,
		 * or parent continuation is created.
		 */
		const awaitDelegatedTurn = Effect.fn('Agents.awaitDelegatedTurn')(function* (
			effectId: EffectIdType,
			agentId: string,
			taskId: string
		) {
			let read = 0;
			const target = () =>
				executeBuilt(
					EffectId.make(`${effectId}:target:${(read += 1)}`),
					database,
					composer
						.select({ content: chatMessage.content })
						.from(chatMessage)
						.where(
							and(
								eq(chatMessage.conversation_id, agentId),
								eq(chatMessage.turn_id, taskId),
								eq(chatMessage.role, 'assistant')
							)
						)
						.limit(1)
				);
			const answer = (rows: ReadonlyArray<unknown>) => {
				const decoded = Schema.decodeUnknownOption(SettledTargetRow)(rows[0]);
				return decoded._tag === 'Some'
					? {
							agentId,
							taskId,
							status: decoded.value.content.status,
							output: decoded.value.content.parts
						}
					: undefined;
			};
			let current = yield* target();
			const alreadySettled = answer(current.rows);
			if (alreadySettled !== undefined) return alreadySettled;
			if (current.rows.length === 0) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: taskId,
					reason: 'delegated task does not exist'
				});
			}

			yield* runExactTurn(EffectId.make(`${effectId}:run`), agentId, taskId);
			current = yield* target();
			const settled = answer(current.rows);
			if (settled !== undefined) return settled;
			return yield* new AccessControl.AccessDenied({
				action: 'agent',
				resource: taskId,
				reason: 'delegated turn did not settle'
			});
		});

		type CommitTurn = (
			status: TurnStatus,
			usage: AIUsage | undefined,
			usageUnreported: boolean
		) => Effect.Effect<unknown, Database.FacilityError>;
		type SettleUsage = (
			usage: AIUsage | undefined,
			newlyUnreported: boolean
		) => Effect.Effect<unknown, Database.FacilityError>;

		/** Runs every round of one turn inside the invocation that started it. */
		const continueToolLoop = Effect.fn('Agents.continueToolLoop')(function* (
			namespace: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			depth: number,
			conversationId: string,
			model: AgentModelDescriptor,
			messages: Array<Schema.Json>,
			tools: ReadonlyArray<Schema.Json>,
			parts: Array<TurnPart>,
			initialUsage: AIUsage | undefined,
			initialUsageUnreported: boolean,
			commit: CommitTurn,
			settleUsage: SettleUsage
		) {
			const usage = yield* Ref.make({
				cumulative: initialUsage,
				segment: undefined as AIUsage | undefined,
				unreported: initialUsageUnreported
			});
			const run = Effect.gen(function* () {
				let output: Schema.Json = null;
				let round = 0;
				while (true) {
					const response = yield* ai.execute(EffectId.make(`${namespace}:ai:${round}`), {
						_tag: 'Turn',
						model: model.id,
						messages,
						tools,
						maxOutputTokens: 2048
					});
					output = response.output;
					const reported = readAIUsage(response.usage);
					yield* Ref.update(usage, (current) => ({
						cumulative: addAIUsage(current.cumulative, reported),
						segment: addAIUsage(current.segment, reported),
						unreported: current.unreported || reported === undefined
					}));
					const decoded = Schema.decodeUnknownOption(TurnOutput)(response.output);
					const toolCalls = decoded._tag === 'Some' ? (decoded.value.toolCalls ?? []) : [];
					const text = decoded._tag === 'Some' ? decoded.value.text : undefined;
					if (toolCalls.length === 0) {
						parts.push({ kind: 'text', text: text ?? '' });
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
						return { output, status: 'completed' as const, ...current };
					}
					const calls = toolCalls.map((call, index) => ({
						id: `${namespace}:tool:${round}:${index}`,
						name: call.name,
						input: call.input ?? null
					}));
					if (text !== undefined && text.trim().length > 0) {
						parts.push({ kind: 'text', text });
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
					}
					messages.push({ role: 'assistant', content: response.output });
					for (const call of calls) {
						parts.push({ kind: 'tool', id: call.id, name: call.name, input: call.input });
						const beforeCall = yield* Ref.get(usage);
						yield* commit('running', beforeCall.cumulative, beforeCall.unreported);
						const result = yield* executeTool(
							agent,
							call.name,
							call.input,
							EffectId.make(call.id),
							subject,
							conversationId,
							depth,
							model.id
						).pipe(
							Effect.catch((failure) =>
								failure instanceof ToolNotAllowed ||
								failure instanceof SkillError ||
								failure instanceof McpToolError
									? Effect.succeed({ error: failure.message })
									: Effect.fail(failure)
							),
							Effect.tapError(() =>
								Effect.gen(function* () {
									parts.splice(0, parts.length, ...closeUnpairedToolCalls(parts, 'tool-failed'));
									const current = yield* Ref.get(usage);
									yield* Effect.ignore(commit('failed', current.cumulative, current.unreported));
								})
							)
						);
						const encoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
							JSON.stringify(result)
						).pipe(Effect.catch(() => Effect.succeed({ error: 'invalid-tool-result' })));
						parts.push({ kind: 'tool-result', id: call.id, name: call.name, output: encoded });
						const afterCall = yield* Ref.get(usage);
						yield* commit('running', afterCall.cumulative, afterCall.unreported);
						messages.push({
							role: 'tool',
							name: call.name,
							content: JSON.stringify(encoded)
						});
					}
					round += 1;
				}
			});

			return yield* run.pipe(
				Effect.onError(() =>
					Effect.gen(function* () {
						const current = yield* Ref.get(usage);
						yield* Effect.ignore(commit('failed', current.cumulative, current.unreported));
						yield* Effect.ignore(
							settleUsage(current.segment, current.unreported && !initialUsageUnreported)
						);
					})
				)
			);
		});

		/** Atomically rewrites exact running assistant rows while preserving committed parts. */
		const setTurnStatuses = Effect.fn('Agents.setTurnStatuses')(function* (
			effectId: EffectIdType,
			conversationId: string,
			taskIds: ReadonlyArray<string>,
			status: TurnStatus
		) {
			if (taskIds.length === 0) return;
			const closeCalls = status === 'interrupted' || status === 'stopped';
			yield* database.execute(EffectId.make(`${effectId}:write`), {
				_tag: 'Query',
				sql: `update "chat_message" message
					set "content" = ${
						closeCalls
							? `jsonb_set(
								jsonb_set(message."content", '{status}', to_jsonb($3::text), true),
								'{parts}',
								coalesce(message."content"->'parts', '[]'::jsonb) || coalesce((
									select jsonb_agg(jsonb_build_object(
										'kind', 'tool-result', 'id', call->>'id', 'name', call->>'name',
										'output', jsonb_build_object(
											'terminal', true,
											'error', 'tool interrupted before completion',
											'reason', $4::text
										)
									))
									from jsonb_array_elements(coalesce(message."content"->'parts', '[]'::jsonb)) call
									where call->>'kind' = 'tool' and not exists (
										select 1 from jsonb_array_elements(coalesce(message."content"->'parts', '[]'::jsonb)) result
										where result->>'kind' = 'tool-result' and result->>'id' = call->>'id'
									)
								), '[]'::jsonb), true
							)`
							: `jsonb_set(message."content", '{status}', to_jsonb($3::text), true)`
					}, "updated_at" = now(), "row_version" = message."row_version" + 1
					where message."conversation_id" = $1 and message."turn_id" = any($2::text[])
						and message."role" = 'assistant'
						and message."content"->>'status' = 'running'`,
				parameters: closeCalls
					? [conversationId, [...taskIds], status, status]
					: [conversationId, [...taskIds], status]
			});
		});

		const runningTurnIds = Effect.fn('Agents.runningTurnIds')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const response = yield* executeBuilt(
				effectId,
				database,
				composer
					// The rows are decoded from the driver response, not mapped by the query builder, so
					// the projection has to carry the alias into the emitted SQL rather than only into
					// the builder's own field map.
					.select({ task_id: aliased(chatMessage.turn_id, 'task_id') })
					.from(chatMessage)
					.where(
						and(
							eq(chatMessage.conversation_id, conversationId),
							eq(chatMessage.role, 'assistant'),
							sql`${chatMessage.content}->>'status' = 'running'`
						)
					)
			);
			return response.rows.flatMap((row) => {
				const decoded = decodeTaskIdRow(row);
				return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
			});
		});

		const interruptConversation = Effect.fn('Agents.interruptConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const taskIds = yield* runningTurnIds(EffectId.make(`${effectId}:running`), conversationId);
			yield* setTurnStatuses(
				EffectId.make(`${effectId}:turns`),
				conversationId,
				taskIds,
				'interrupted'
			);
			for (const taskId of taskIds) {
				yield* Effect.ignore(
					tasks.execute(EffectId.make(`${effectId}:interrupt:${taskId}`), {
						_tag: 'Interrupt',
						taskId
					})
				);
			}
			return taskIds;
		});

		const stopConversation = Effect.fn('Agents.stopConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const taskIds = yield* runningTurnIds(EffectId.make(`${effectId}:running`), conversationId);
			yield* executeBuilt(
				EffectId.make(`${effectId}:mailbox`),
				database,
				composer
					.update(agentMailbox)
					.set({ status: 'stopped' })
					.where(eq(agentMailbox.conversation_id, conversationId))
			);
			yield* setTurnStatuses(
				EffectId.make(`${effectId}:turns`),
				conversationId,
				taskIds,
				'stopped'
			);
			for (const taskId of taskIds) {
				yield* Effect.ignore(
					tasks.execute(EffectId.make(`${effectId}:interrupt:${taskId}`), {
						_tag: 'Interrupt',
						taskId
					})
				);
			}
			return taskIds;
		});

		const resumeConversation = Effect.fn('Agents.resumeConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const response = yield* database.execute(EffectId.make(`${effectId}:replay`), {
				_tag: 'Query',
				sql: `with active_mailbox as (
					update "agent_mailbox" mailbox
					set "status" = 'active', "updated_at" = now(),
						"row_version" = mailbox."row_version" + 1
					where mailbox."conversation_id" = $1
				), candidate as (
					select message."id", message."turn_id"
					from "chat_message" message
					where message."conversation_id" = $1
						and message."role" = 'assistant'
						and message."content"->>'status' in ('stopped', 'interrupted')
					order by message."sequence" desc
					limit 1
					for update
				), replayed_turn as (
					update "chat_message" message
					set "content" = jsonb_set(message."content", '{status}', '"running"'::jsonb, true),
						"updated_at" = now(), "row_version" = message."row_version" + 1
					where message."id" in (select "id" from candidate)
					returning message."turn_id" as "task_id"
				)
				select "task_id" from replayed_turn`,
				parameters: [conversationId]
			});
			const taskIds = response.rows.flatMap((row) => {
				const decoded = decodeTaskIdRow(row);
				return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
			});
			if (taskIds[0] !== undefined) {
				yield* runExactTurn(EffectId.make(`${effectId}:run`), conversationId, taskIds[0]);
			}
			return taskIds;
		});

		service = Service.of({
			recover: recoverRunningTurns,
			open: Effect.fn('Agents.open')(function* (effectId, subject, agentName, conversationId) {
				const agent = yield* resolveAgent(agentName);
				yield* access.authorize(subject, 'agent', agentName);
				yield* openConversation(effectId, agent, subject, conversationId);
			}),
			attachFile: Effect.fn('Agents.attachFile')(
				function* (effectId, subject, conversationId, file) {
					yield* requireReadableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					yield* documents.attach(effectId, conversationId, file);
				}
			),
			readMedia: Effect.fn('Agents.readMedia')(
				function* (effectId, subject, conversationId, storageKey) {
					yield* requireReadableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					return yield* documents.media(effectId, conversationId, storageKey);
				}
			),
			removeFile: Effect.fn('Agents.removeFile')(
				function* (effectId, subject, conversationId, storageKey) {
					yield* requireReadableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					yield* documents.remove(effectId, conversationId, storageKey);
				}
			),
			enqueue: Effect.fn('Agents.enqueue')(
				function* (effectId, subject, agentName, conversationId, turnId, message, model) {
					const admitted = yield* admitTurn(
						effectId,
						subject,
						agentName,
						conversationId,
						turnId,
						message,
						model === undefined ? {} : { model }
					);
					const result = yield* runExactTurn(
						EffectId.make(`${effectId}:run`),
						conversationId,
						turnId
					);
					return { ...admitted, status: result.status };
				}
			),
			execute: Effect.fn('Agents.execute')(function* (
				effectId,
				conversationId,
				turnId,
				surface?: TurnSurface
			) {
				const storedResult = yield* executeBuilt(
					EffectId.make(`${effectId}:turn:read`),
					database,
					composer
						.select({ id: chatMessage.id, content: chatMessage.content })
						.from(chatMessage)
						.where(
							and(
								eq(chatMessage.conversation_id, conversationId),
								eq(chatMessage.turn_id, turnId),
								eq(chatMessage.role, 'assistant')
							)
						)
						.limit(1)
				);
				const decoded = decodeStoredTurnMessageRow(storedResult.rows[0]);
				if (decoded._tag === 'None') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'turn does not exist'
					});
				}
				const stored = decoded.value.content;
				if (stored.subject === undefined || stored.agent_name === undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'turn has no execution authority'
					});
				}
				if (
					stored.status === 'completed' ||
					stored.status === 'failed' ||
					stored.status === 'interrupted' ||
					stored.status === 'stopped'
				) {
					return {
						conversationId,
						output: null,
						status: stored.status === 'completed' ? 'completed' : 'failed'
					};
				}
				// Stop/restart replay changes the row back to running before entering this fresh invocation.
				// Terminal rows never become a retry ladder.
				const subject = stored.subject;
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(subject, 'agent', stored.agent_name);
				const transcript = yield* executeBuilt(
					EffectId.make(`${effectId}:transcript`),
					database,
					composer
						.select({
							role: chatMessage.role,
							content: chatMessage.content,
							turn_id: chatMessage.turn_id
						})
						.from(chatMessage)
						.where(eq(chatMessage.conversation_id, conversationId))
						.orderBy(desc(chatMessage.sequence))
				);
				const parts: Array<TurnPart> = [...stored.parts];
				let committed = 0;
				/**
				 * The turn's durable record, kept beside the loop's steps: one commit after every step,
				 * and each commit is the one beat the transport surface is told about.
				 */
				const persistTurn = (
					status: TurnStatus,
					usage: AIUsage | undefined,
					usageUnreported: boolean
				) =>
					syncMutation(
						EffectId.make(`${effectId}:turn:${(committed += 1)}`),
						composer
							.update(chatMessage)
							.set({
								content: JSON.stringify({
									...stored,
									status,
									parts,
									...(usage === undefined ? {} : { usage }),
									usage_unreported: usageUnreported
								})
							})
							.where(
								and(
									eq(chatMessage.id, decoded.value.id),
									sql`${chatMessage.content}->>'status' = 'running'`
								)
							),
						['chat_message']
					);
				const commit: CommitTurn =
					surface === undefined
						? persistTurn
						: (status, usage, usageUnreported) =>
								Effect.gen(function* () {
									const result = yield* persistTurn(status, usage, usageUnreported);
									// Best effort by contract: a surface that cannot post the beat must never
									// fail the turn, and the surface itself owns throttling and the bubble key.
									yield* Effect.catch(surface.observe(parts), () => Effect.void);
									return result;
								});
				const model = yield* resolveModel(stored.model);
				yield* commit('running', stored.usage, stored.usage_unreported ?? false);
				const settleUsage: SettleUsage = (usage, newlyUnreported) =>
					recordUsage(
						EffectId.make(`${effectId}:usage`),
						conversationId,
						usage,
						stored.usage === undefined ? 1 : 0,
						newlyUnreported ? 1 : 0
					);
				const settled = yield* continueToolLoop(
					effectId,
					agent,
					subject,
					stored.depth ?? 0,
					conversationId,
					model,
					promptFor(
						agent,
						transcript.rows.toReversed(),
						subject,
						conversationId,
						model.contextTokens
					),
					toolsFor(subject, agent),
					parts,
					stored.usage,
					stored.usage_unreported ?? false,
					commit,
					settleUsage
				);
				yield* commit(settled.status, settled.cumulative, settled.unreported);
				yield* Effect.ignore(settleUsage(settled.segment, settled.unreported));
				return { conversationId, output: settled.output, status: settled.status };
			}),
			interrupt: Effect.fn('Agents.interrupt')(function* (effectId, subject, conversationId) {
				yield* requireControllableConversation(
					EffectId.make(`${effectId}:authorize`),
					subject,
					conversationId
				);
				yield* interruptConversation(effectId, conversationId);
			}),
			stop: Effect.fn('Agents.stop')(function* (effectId, subject, conversationId) {
				yield* requireControllableConversation(
					EffectId.make(`${effectId}:authorize`),
					subject,
					conversationId
				);
				yield* stopConversation(effectId, conversationId);
			}),
			resume: Effect.fn('Agents.resume')(function* (effectId, subject, conversationId) {
				yield* requireControllableConversation(
					EffectId.make(`${effectId}:authorize`),
					subject,
					conversationId
				);
				yield* resumeConversation(effectId, conversationId);
			}),
			updateVerifier: Effect.fn('Agents.updateVerifier')(
				function* (effectId, conversationId, verifier) {
					yield* syncMutation(
						effectId,
						composer
							.update(chatSession)
							.set({ verifier: JSON.stringify(verifier) })
							.where(eq(chatSession.conversation_id, conversationId)),
						['chat_session']
					);
				}
			),
			listSkills: (subject) => allowedSkills(subject).map(({ name }) => name),
			readSkill: Effect.fn('Agents.readSkill')((subject, name) =>
				readSkillBody(allowedSkills(subject), name)
			)
		});
		return service;
	})
);
