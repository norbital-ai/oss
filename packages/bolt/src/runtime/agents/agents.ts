import { Context, Effect, Layer, Option, Ref, Schema } from 'effect';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
	addAIUsage,
	AIUsage,
	EffectId,
	readAIUsage,
	type AgentEnqueueResult,
	type ChatDocumentRef,
	type DatabaseResponse,
	type EffectId as EffectIdType,
	type SyncChange
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import { AI, Connector, HostTools, SyncCommit, Tasks } from '#lib/runtime/facilities/services.js';
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

/** The web agent or declared envoy executing a turn. */
type ResolvedAgent = Readonly<{
	readonly name: string;
	/** The envoy's standing instruction, absent for the web agent. */
	readonly task?: string;
	/** `public` on an envoy anyone can message; absent for the web agent, which is never public. */
	readonly audience?: 'public' | 'authenticated';
	/** Whether this agent may create and coordinate delegated sandbox-agent sessions. */
	readonly delegation: 'enabled' | 'disabled';
}>;

/** Selects the subject-owned or envoy-owned sandbox tree for a turn. */
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
	/** The producing turn, when the row belongs to one. */
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
const QueuedInputRow = Schema.Struct({
	id: Schema.NonEmptyString,
	turn_id: Schema.NonEmptyString,
	content: Schema.Json
});
const decodeQueuedInputRow = Schema.decodeUnknownOption(QueuedInputRow);
const CommittedChatRow = Schema.Struct({
	collection: Schema.Literals(['chat_session', 'chat_message']),
	record_id: Schema.NonEmptyString
});
const decodeCommittedChatRow = Schema.decodeUnknownOption(CommittedChatRow);
const CommittedIdRow = Schema.Struct({ id: Schema.NonEmptyString });
const decodeCommittedIdRow = Schema.decodeUnknownOption(CommittedIdRow);
const committedChatChanges = (
	rows: ReadonlyArray<unknown>,
	conversationId: string
): ReadonlyArray<SyncChange> =>
	rows.flatMap((row) => {
		const coordinate = decodeCommittedChatRow(row).pipe(
			Option.map(({ collection, record_id }) => ({ collection, recordId: record_id })),
			Option.orElse(() =>
				decodeCommittedIdRow(row).pipe(
					Option.map(({ id }) => ({ collection: 'chat_message' as const, recordId: id }))
				)
			)
		);
		return coordinate._tag === 'Some'
			? [
					{
						...coordinate.value,
						routing: [{ field: 'conversation_id', value: conversationId }]
					} satisfies SyncChange
				]
			: [];
	});
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

/** Runtime-internal enqueue outcome; dispatch exposes only the lane receipt fields. */
export type AgentEnqueueOutcome = AgentEnqueueResult & Readonly<{ readonly output?: Schema.Json }>;

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
		model?: string,
		surface?: TurnSurface
	) => Effect.Effect<AgentEnqueueOutcome, AgentExecutionError>;
	/** Executes one already-persisted exact turn. */
	readonly execute: (
		effectId: EffectIdType,
		conversationId: string,
		turnId: string,
		/** Optional transport notified after each durable part commit. */
		surface?: TurnSurface
	) => Effect.Effect<TurnResultValue, AgentExecutionError>;
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
	/** Whether this conversation currently has an invocation between admission and settlement. */
	readonly running: (
		effectId: EffectIdType,
		conversationId: string
	) => Effect.Effect<boolean, Database.FacilityError>;
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
	/** Skills are subject capabilities, so callers cannot resolve them by agent name. */
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
		const syncCommit = yield* SyncCommit.Service;

		/** Closes turns left running by a previous host process. */
		const recoverRunningTurns = Effect.fn('Agents.recover')(function* (effectId: EffectIdType) {
			yield* database.execute(effectId, {
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

		const syncMutation = Effect.fn('Agents.syncMutation')(function* (
			effectId: EffectIdType,
			query: BuiltQuery
		) {
			const response = yield* executeBuilt(effectId, database, query);
			return response;
		});
		const syncTransaction = Effect.fn('Agents.syncTransaction')(function* (
			effectId: EffectIdType,
			queries: ReadonlyArray<BuiltQuery>
		) {
			if (queries.length === 0) return;
			yield* transactionBuilt(effectId, database, queries);
		});

		/** Applies owner access plus the administrator view of declared public envoy inboxes. */
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
				if (conversation.user_id !== subject.userId) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'only the owner may control this agent conversation'
					});
				}
				return conversation;
			}
		);

		/** Derives the exact tool offer from subject grants and the envoy delegation boundary. */
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
				(tool) => !authoredNames.has(tool.name) && (tool.name !== 'write_collection' || mayWrite)
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

		/** Whether the subject has any create, update, or delete grant. */
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

		/** Resolves the reserved web agent or an authored envoy without disclosing unknown names. */
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

		/** Opens the owned conversation and records its personal/envoy visibility and sandbox scope. */
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
					.onConflictDoNothing()
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
			const active = yield* executeBuilt(
				EffectId.make(`${effectId}:active-turn`),
				database,
				composer
					.select({ id: chatMessage.id })
					.from(chatMessage)
					.where(
						and(
							eq(chatMessage.conversation_id, conversationId),
							eq(chatMessage.role, 'assistant'),
							sql`${chatMessage.content}->>'status' = 'running'`,
							or(isNull(chatMessage.turn_id), sql`${chatMessage.turn_id} <> ${turnId}`)
						)
					)
					.limit(1)
			);
			const initialStatus: TurnStatus = active.rows.length === 0 ? 'running' : 'queued';
			const title =
				message.kind === 'agent_message' ? undefined : chatInputText(message).slice(0, 48);
			const group = conversationId.includes(':group:');
			const committed = yield* transactionBuilt(effectId, database, [
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
							status: initialStatus,
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
				),
				transactionSql(
					`select 'chat_session'::text as "collection", session."id"::text as "record_id"
					from "chat_session" session where session."conversation_id" = $1
					union all
					select 'chat_message'::text as "collection", message."id"::text as "record_id"
					from "chat_message" message
					where message."conversation_id" = $1 and message."turn_id" = $2
						and message."role" in ('user', 'assistant')`,
					[conversationId, turnId]
				)
			]);
			const changes = committedChatChanges(committed.rows, conversationId);
			yield* syncCommit.publish(EffectId.make(`${effectId}:publish`), { changes });
			const stored = yield* executeBuilt(
				EffectId.make(`${effectId}:admitted-turn`),
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
			const admitted = decodeStoredTurnMessageRow(stored.rows[0]);
			if (admitted._tag === 'None') {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: conversationId,
					reason: 'admitted turn was not readable'
				});
			}
			return { conversationId, taskId: turnId, turnId, status: admitted.value.content.status };
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

		/** Replays complete turn units through the invocation's context window. */
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

		/** Claims queued follow-ups for the next model round without losing late arrivals. */
		const claimQueuedInputs = Effect.fn('Agents.claimQueuedInputs')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const claimed = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `with candidates as (
					select assistant."id", assistant."turn_id", input."content"
					from "chat_message" assistant
					join "chat_message" input
						on input."conversation_id" = assistant."conversation_id"
						and input."turn_id" = assistant."turn_id" and input."role" = 'user'
					where assistant."conversation_id" = $1 and assistant."role" = 'assistant'
						and assistant."content"->>'status' = 'queued'
					order by assistant."sequence"
					for update of assistant skip locked
				), consumed as (
					update "chat_message" assistant
					set "content" = jsonb_set(assistant."content", '{status}', '"completed"'::jsonb, true),
						"updated_at" = now(), "row_version" = assistant."row_version" + 1
					from candidates
					where assistant."id" = candidates."id"
					returning assistant."id"::text as "id", candidates."turn_id", candidates."content"
				)
				select "id", "turn_id", "content" from consumed`,
				parameters: [conversationId]
			});
			const rows = claimed.rows.flatMap((row) => {
				const decoded = decodeQueuedInputRow(row);
				if (decoded._tag === 'None') return [];
				const input = parseStoredChatInput(decoded.value.content);
				if (input !== null) {
					return [{ id: decoded.value.id, text: chatInputForModel(input) }];
				}
				const relayed = parseAgentMessage(decoded.value.content);
				return relayed === null
					? []
					: [{ id: decoded.value.id, text: agentMessageForModel(relayed) }];
			});
			if (rows.length > 0) {
				yield* syncCommit.publish(EffectId.make(`${effectId}:publish`), {
					changes: rows.map(({ id }) => ({
						collection: 'chat_message' as const,
						recordId: id,
						routing: [{ field: 'conversation_id', value: conversationId }]
					}))
				});
			}
			return rows.map(({ text }) => ({ role: 'user', content: text }) satisfies Schema.Json);
		});

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
				)
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

		/** Promotes the oldest follow-up left behind after a turn's final model round. */
		const promoteQueuedTurn = Effect.fn('Agents.promoteQueuedTurn')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const promoted = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `with candidate as (
					select message."id"
					from "chat_message" message
					where message."conversation_id" = $1 and message."role" = 'assistant'
						and message."content"->>'status' = 'queued'
						and exists (
							select 1 from "agent_mailbox" mailbox
							where mailbox."conversation_id" = $1 and mailbox."status" = 'active'
						)
						and not exists (
							select 1 from "chat_message" running
							where running."conversation_id" = $1 and running."role" = 'assistant'
								and running."content"->>'status' = 'running'
						)
					order by message."sequence"
					limit 1
					for update skip locked
				), advanced as (
					update "chat_message" message
					set "content" = jsonb_set(message."content", '{status}', '"running"'::jsonb, true),
						"updated_at" = now(), "row_version" = message."row_version" + 1
					where message."id" in (select "id" from candidate)
					returning message."id"::text as "id", message."turn_id" as "task_id"
				)
				select "id", "task_id" from advanced`,
				parameters: [conversationId]
			});
			const row = promoted.rows[0];
			const decoded = decodeTaskIdRow(row);
			if (decoded._tag === 'None') return undefined;
			const id =
				row !== null && typeof row === 'object' && typeof Reflect.get(row, 'id') === 'string'
					? (Reflect.get(row, 'id') as string)
					: undefined;
			if (id !== undefined) {
				yield* syncCommit.publish(EffectId.make(`${effectId}:publish`), {
					changes: [
						{
							collection: 'chat_message',
							recordId: id,
							routing: [{ field: 'conversation_id', value: conversationId }]
						}
					]
				});
			}
			return decoded.value.task_id;
		});

		const drainQueuedTurns = Effect.fn('Agents.drainQueuedTurns')(function* (
			effectId: EffectIdType,
			conversationId: string,
			surface?: TurnSurface
		) {
			for (let index = 0; ; index += 1) {
				const taskId = yield* promoteQueuedTurn(
					EffectId.make(`${effectId}:promote:${index}`),
					conversationId
				);
				if (taskId === undefined) return;
				yield* runExactTurn(
					EffectId.make(`${effectId}:run:${index}`),
					conversationId,
					taskId,
					surface
				).pipe(Effect.catch(() => Effect.void));
			}
		});

		/** Waits for one exact delegated child turn. */
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
		) => Effect.Effect<DatabaseResponse, Database.FacilityError>;
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
					messages.push(
						...(yield* claimQueuedInputs(
							EffectId.make(`${namespace}:incoming:${round}`),
							conversationId
						))
					);
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
					const reasoning = decoded._tag === 'Some' ? decoded.value.reasoning : undefined;
					const reasoningDetails =
						decoded._tag === 'Some' ? decoded.value.reasoningDetails : undefined;
					if (
						(reasoning !== undefined && reasoning.trim().length > 0) ||
						(reasoningDetails !== undefined && reasoningDetails.length > 0)
					) {
						parts.push({
							kind: 'reasoning',
							text: reasoning ?? '',
							...(reasoningDetails === undefined ? {} : { details: reasoningDetails })
						});
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
					}
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
			const committed = yield* database.execute(EffectId.make(`${effectId}:write`), {
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
						and message."content"->>'status' = 'running'
					returning message."id"::text as "id"`,
				parameters: closeCalls
					? [conversationId, [...taskIds], status, status]
					: [conversationId, [...taskIds], status]
			});
			yield* syncCommit.publish(EffectId.make(`${effectId}:publish`), {
				changes: committedChatChanges(committed.rows, conversationId)
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
					returning message."id"::text as "id", message."turn_id" as "task_id"
				)
				select "id", "task_id" from replayed_turn`,
				parameters: [conversationId]
			});
			const taskIds = response.rows.flatMap((row) => {
				const decoded = decodeTaskIdRow(row);
				return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
			});
			yield* syncCommit.publish(EffectId.make(`${effectId}:publish`), {
				changes: committedChatChanges(response.rows, conversationId)
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
				function* (effectId, subject, agentName, conversationId, turnId, message, model, surface) {
					const admitted = yield* admitTurn(
						effectId,
						subject,
						agentName,
						conversationId,
						turnId,
						message,
						model === undefined ? {} : { model }
					);
					if (admitted.status === 'queued') {
						return { ...admitted, status: 'queued' as const };
					}
					if (admitted.status !== 'running') {
						return {
							...admitted,
							status: admitted.status === 'completed' ? ('completed' as const) : ('failed' as const)
						};
					}
					const result = yield* runExactTurn(
						EffectId.make(`${effectId}:run`),
						conversationId,
						turnId,
						surface
					);
					yield* drainQueuedTurns(EffectId.make(`${effectId}:queued`), conversationId, surface);
					return { ...admitted, status: result.status, output: result.output };
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
				const subject = stored.subject;
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(subject, 'agent', stored.agent_name);
				yield* claimQueuedInputs(EffectId.make(`${effectId}:incoming:initial`), conversationId);
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
				/** Each logical step becomes one durable record and one transport beat. */
				const persistTurn = (
					status: TurnStatus,
					usage: AIUsage | undefined,
					usageUnreported: boolean
				) =>
					Effect.gen(function* () {
						const sequence = (committed += 1);
						const result = yield* syncMutation(
							EffectId.make(`${effectId}:turn:${sequence}`),
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
								)
						);
						yield* syncCommit.publish(EffectId.make(`${effectId}:publish:${sequence}`), {
							changes: [
								{
									collection: 'chat_message',
									recordId: decoded.value.id,
									routing: [{ field: 'conversation_id', value: conversationId }]
								}
							]
						});
						return result;
					});
				const commit: CommitTurn =
					surface === undefined
						? persistTurn
						: (status, usage, usageUnreported) =>
								Effect.gen(function* () {
									const result = yield* persistTurn(status, usage, usageUnreported);
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
				const finalCommit = yield* commit(settled.status, settled.cumulative, settled.unreported);
				yield* Effect.ignore(settleUsage(settled.segment, settled.unreported));
				// The guarded final update loses an interrupt race by affecting zero rows.
				const completed = settled.status === 'completed' && finalCommit.affectedRows > 0;
				if (completed && surface?.complete !== undefined) {
					yield* Effect.catch(surface.complete(settled.output), () => Effect.void);
				}
				return {
					conversationId,
					output: settled.output,
					status: completed ? ('completed' as const) : ('failed' as const)
				};
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
			running: Effect.fn('Agents.running')(function* (effectId, conversationId) {
				return (yield* runningTurnIds(effectId, conversationId)).length > 0;
			}),
			updateVerifier: Effect.fn('Agents.updateVerifier')(
				function* (effectId, conversationId, verifier) {
					yield* syncMutation(
						effectId,
						composer
							.update(chatSession)
							.set({ verifier: JSON.stringify(verifier) })
							.where(eq(chatSession.conversation_id, conversationId))
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
