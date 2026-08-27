import { Clock, Context, Effect, Layer, Ref, Schema } from 'effect';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
	addAIUsage,
	AIUsage,
	EffectId,
	readAIUsage,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { ApprovalConflict } from '#lib/runtime/approvals/approvals.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { PendingApproval } from '#lib/runtime/collections/collections.js';
import { AI, Connector, HostTools } from '#lib/runtime/facilities/services.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	composer,
	executeBuilt,
	increment,
	transactionBuilt,
	transactionSql
} from '#lib/runtime/persistence.js';
import * as SyncWake from '#lib/runtime/sync/wake.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import {
	AgentEnqueueResult,
	type AgentEnqueueResult as AgentEnqueueResultValue,
	TurnResult,
	type TurnResult as TurnResultValue
} from './agent-schemas.js';
export { AgentEnqueueResult, TurnResult } from './agent-schemas.js';
import { RemoteRegistry } from '#lib/runtime/remotes.js';
import type { WhereCompileError } from '#lib/runtime/collections/where.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError, WorkspaceLookupError } from '#lib/runtime/workspace.js';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { WEB_AGENT_NAME } from '#lib/authoring/workspace-schema.js';
import { envoyPrincipalId } from '#lib/runtime/identity/static-identity.js';

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
	/** Disabled only by an envoy declaration; absence means delegation is enabled. */
	readonly delegation?: 'enabled' | 'disabled';
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
import { McpToolError, SkillError, ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
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
	isChatDocumentStorageKey,
	parseStoredChatInput,
	type ChatDocumentRef,
	type StoredChatInput
} from '#lib/runtime/agents/chat-messages.js';

const {
	agent_run: agentRun,
	chat_session: chatSession,
	chat_message: chatMessage
} = SYSTEM_MODEL_TABLES;
type BuiltQuery = Parameters<typeof executeBuilt>[2];

export { McpToolError, SkillError, ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
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

const ToolCall = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
const TurnOutput = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(ToolCall))
});
const maxToolRounds = 8;
const recentPromptRows = 64;
const protectedAssistantTurns = 3;
const softToolOutputCharacters = 4_000;
const hardToolOutputCharacters = 50_000;

/**
 * One step of an agent turn. "Step" and "part" name the same thing: what the turn produced next.
 *
 * A turn is one message, so its steps are parts inside that message rather than messages of their
 * own. The log used to hold one `assistant` row per *round* and one `tool` row per answer, which
 * rendered a single turn as several separate agent blocks — the round is an artefact of how the tool
 * loop is driven, not something the reader asked about.
 */
const TurnPart = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('tool'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		input: Schema.Json
	}),
	Schema.Struct({
		kind: Schema.Literal('tool-result'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		output: Schema.Json
	})
]);
type TurnPart = Schema.Schema.Type<typeof TurnPart>;

const TurnStatus = Schema.Literals([
	'queued',
	'running',
	'paused',
	'completed',
	'failed',
	'interrupted',
	'dequeued'
]);
type TurnStatus = Schema.Schema.Type<typeof TurnStatus>;

/**
 * Everything a parked turn needs in order to continue under the authority that started it.
 *
 * The subject is a snapshot, deliberately. A task invocation carries no credential, and rebuilding a
 * subject from `chat_session.user_id` would be both incomplete (there is no team path there)
 * and wrong for envoys (their policies are static authority, not the linked person's authority).
 */
const StoredTurn = Schema.Struct({
	id: Schema.NonEmptyString,
	status: TurnStatus,
	parent_agent_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	parts: Schema.Array(TurnPart),
	resumed: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	),
	subject: Schema.optionalKey(Identity.Subject),
	agent_name: Schema.optionalKey(Schema.NonEmptyString),
	usage: Schema.optionalKey(AIUsage),
	usage_unreported: Schema.optionalKey(Schema.Boolean)
});
type StoredTurn = Schema.Schema.Type<typeof StoredTurn>;

const StoredTurnMessageRow = Schema.Struct({ id: Schema.String, content: StoredTurn });
const decodeStoredTurnMessageRow = Schema.decodeUnknownOption(StoredTurnMessageRow);
const AwaitInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const WaitingAnswer = Schema.Struct({ waiting: Schema.Literal(true) });
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
const SandboxReorderActionInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	orderedTaskIds: Schema.Array(Schema.NonEmptyString)
});
const SandboxAgentActionInput = Schema.Struct({ agentId: Schema.NonEmptyString });

/** A completed delegated turn, returned to the parent as the answer to its await tool call. */
const SettledTarget = Schema.Struct({
	id: Schema.NonEmptyString,
	status: Schema.Literals(['completed', 'failed', 'interrupted', 'dequeued']),
	parts: Schema.Array(TurnPart)
});
const SettledTargetRow = Schema.Struct({ content: SettledTarget });

const maxResumes = 4;

/**
 * Expands one stored turn back into the alternating messages a provider accepts.
 *
 * The store keeps a turn whole because that is what the turn is; a provider instead wants the
 * assistant/tool alternation it emitted. Rebuilding it here is what lets the log hold the reader's
 * model without the prompt losing which answer belongs to which call.
 */
/**
 * A replay of a stored assistant turn: the text and the tool calls a provider needs, in the order
 * they happened, with either half optional — the one shape a provider actually builds a prompt from.
 */
const ReplayContent = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(Schema.Json))
});
type ReplayContent = typeof ReplayContent.Type;

const replayTurn = (parts: ReadonlyArray<TurnPart>): ReadonlyArray<Schema.Json> => {
	const replayed: Array<Schema.Json> = [];
	let text: string | undefined;
	let calls: Array<Schema.Json> = [];
	const flush = () => {
		if (text === undefined && calls.length === 0) return;
		const content: ReplayContent =
			text === undefined
				? { toolCalls: calls }
				: calls.length === 0
					? { text }
					: { text, toolCalls: calls };
		replayed.push({ role: 'assistant', content });
		text = undefined;
		calls = [];
	};
	for (const part of parts) {
		if (part.kind === 'text') {
			flush();
			text = part.text;
		} else if (part.kind === 'tool') {
			calls.push({ name: part.name, input: part.input });
		} else {
			flush();
			replayed.push({ role: 'tool', name: part.name, content: JSON.stringify(part.output) });
		}
	}
	flush();
	return replayed;
};

/**
 * Old tool output is evidence, not an entitlement to consume the prompt forever. The recent three
 * assistant turns remain byte-for-byte intact; older output is trimmed at the two age thresholds
 * used by the runtime's fixed replay window.
 */
const pruneToolOutput = (
	parts: ReadonlyArray<TurnPart>,
	ageFraction: number,
	protectedTurn: boolean
): ReadonlyArray<TurnPart> => {
	if (protectedTurn) return parts;
	return parts.map((part): TurnPart => {
		if (part.kind !== 'tool-result') return part;
		const encoded = JSON.stringify(part.output);
		if (ageFraction >= 0.5 && encoded.length > hardToolOutputCharacters) {
			return {
				...part,
				output: {
					cleared: true,
					originalCharacters: encoded.length,
					reason: 'outside recent prompt window'
				}
			};
		}
		if (ageFraction >= 0.3 && encoded.length > softToolOutputCharacters) {
			return {
				...part,
				output: `${encoded.slice(0, 1_500)}\n… ${encoded.length - 3_000} characters trimmed …\n${encoded.slice(-1_500)}`
			};
		}
		return part;
	});
};

/**
 * What one conversation has cost, counting everything it delegated.
 *
 * Cumulative counters read off the session row rather than a sum taken over the transcript: the
 * figures have to outlive the messages that produced them, and a conversation whose history was
 * compacted is not a conversation that stopped spending money.
 *
 * `turnsUnreported` is what stops a total reading as exact when it is a floor. A host that reports
 * no cost for a turn has not told us the turn was free.
 */
// repository-health:allow EXP1 -- Exported dependent Layer declarations require this cross-module schema name during declaration emit.
export const ConversationUsage = Schema.Struct({
	/** The provider's own charge, kept as the audit figure behind the one below. */
	costUsd: Schema.Number,
	/**
	 * What the host will invoice for this conversation, in millionths of `costCurrency`.
	 *
	 * This is the figure a reader takes for the price, so it is the host's own — a provider charge in
	 * one currency shown to someone invoiced in another understates it silently. Zero with no
	 * currency means the host priced nothing and only the provider figure exists.
	 */
	costMicroUnits: Schema.Number,
	costCurrency: Schema.Union([Schema.String, Schema.Null]),
	totalTokens: Schema.Number,
	turnsCounted: Schema.Number,
	turnsUnreported: Schema.Number
});
// repository-health:allow EXP1 -- Exported dependent Layer declarations require this cross-module row type during declaration emit.
export interface ConversationUsage extends Schema.Schema.Type<typeof ConversationUsage> {}

/**
 * How deep the spend roll-up and the transcript walk follow delegation.
 *
 * Delegation is recursive, but bounded. The limit also makes a cycle written into `parent_id`
 * degrade to a truncated walk rather than a recursive query that never returns.
 */
const maxDelegationDepth = 8;

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
	 * subagent writes while its parent is parked, so its rows sit in the middle of the parent's
	 * sequence and read as messages the person sent.
	 */
	turn_id: Schema.optionalKey(NullableString)
});

/** The stored rows a replay reads; the decoder shapes are built beside the row schema, once. */
const MessageContent = Schema.Struct({
	parts: Schema.Array(TurnPart),
	subject: Schema.optionalKey(Identity.Subject)
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

/** The single column a conversation title lookup reads back. */
const TitleRow = Schema.Struct({ title: Schema.optionalKey(Schema.String) });
const decodeTitleRow = Schema.decodeUnknownOption(TitleRow);

/** One conversation's stored usage counters, as the session row carries them. */
const UsageRow = Schema.Struct({
	usage_cost_usd: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
	usage_cost_micro_units: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	),
	usage_cost_currency: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	usage_total_tokens: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String, Schema.Null])),
	usage_turns_counted: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	),
	usage_turns_unreported: Schema.optionalKey(
		Schema.Union([Schema.Number, Schema.String, Schema.Null])
	)
});
const ConversationLinkRow = Schema.Struct({
	conversation_id: Schema.String,
	parent_id: Schema.Union([Schema.String, Schema.Null])
});
const decodeConversationLinkRow = Schema.decodeUnknownOption(ConversationLinkRow);
const IdRow = Schema.Struct({ id: Schema.String });
const decodeIdRow = Schema.decodeUnknownOption(IdRow);
const TaskIdRow = Schema.Struct({ task_id: Schema.String });
const decodeTaskIdRow = Schema.decodeUnknownOption(TaskIdRow);

/**
 * Reads one counter off a session row.
 *
 * `bigint` and `double precision` come back from some drivers as strings, and a counter silently
 * read as `NaN` would render a conversation as having spent nothing rather than as having spent
 * something this code could not read.
 */
const usageNumber = (value: unknown): number => {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
};

/** The session's cumulative usage, or zeroes for a conversation that has settled no turn yet. */
const conversationUsage = (row: unknown): ConversationUsage => {
	const decoded = Schema.decodeUnknownOption(UsageRow)(row);
	const source = decoded._tag === 'Some' ? decoded.value : {};
	return {
		costUsd: usageNumber(source.usage_cost_usd),
		costMicroUnits: usageNumber(source.usage_cost_micro_units),
		costCurrency:
			typeof source.usage_cost_currency === 'string' ? source.usage_cost_currency : null,
		totalTokens: usageNumber(source.usage_total_tokens),
		turnsCounted: usageNumber(source.usage_turns_counted),
		turnsUnreported: usageNumber(source.usage_turns_unreported)
	};
};

export type Interface = Readonly<{
	/** Opens an empty conversation only when a document must be bound before its first message. */
	readonly open: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string
	) => Effect.Effect<
		void,
		Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError
	>;
	/** Persists the message and queued turn atomically, then returns before inference starts. */
	readonly enqueue: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string,
		turnId: string,
		message: StoredChatInput
	) => Effect.Effect<
		AgentEnqueueResultValue,
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| ChatDocuments.ChatDocumentError
	>;
	/** Executes one already-persisted queued turn. Only task invocations call this. */
	readonly execute: (
		effectId: EffectIdType,
		conversationId: string,
		turnId: string
	) => Effect.Effect<
		TurnResultValue,
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| SkillError
		| ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		| Collections.MutationError
		// A turn runs authored code — its tools reach collections and remotes — so a business rule
		// can refuse it, and a delegated turn can be stopped by the nesting bound. Both were
		// reaching this boundary already; only the declaration did not say so, which is how a
		// refusal here left as something a caller could not name.
		| AuthoredRefusal
		| ChatDocuments.ChatDocumentError
		| Collections.RelationshipPrefetchLimitExceeded
		| InvocationBudget.NestingLimitExceeded
	>;
	readonly bindDocument: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		file: ChatDocumentRef
	) => Effect.Effect<
		void,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly resolveDocument: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		ChatDocumentRef,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly removeDocument: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		void,
		Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError
	>;
	readonly continue: (
		effectId: EffectIdType,
		conversationId: string,
		agentId: string,
		taskId: string
	) => Effect.Effect<
		void,
		| Workspace.WorkspaceLookupError
		| AccessControl.AccessDenied
		| Database.FacilityError
		| SkillError
		| ToolNotAllowed
		| ApprovalConflict
		| PendingApproval
		| WhereCompileError
		| Collections.MutationError
		| AuthoredRefusal
		| Collections.RelationshipPrefetchLimitExceeded
		| InvocationBudget.NestingLimitExceeded
	>;
	readonly dequeue: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		taskId: string
	) => Effect.Effect<void, Database.FacilityError | AccessControl.AccessDenied>;
	readonly reorder: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		orderedTaskIds: ReadonlyArray<string>
	) => Effect.Effect<void, Database.FacilityError | AccessControl.AccessDenied>;
	readonly interrupt: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, Database.FacilityError | AccessControl.AccessDenied>;
	readonly stop: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, Database.FacilityError | AccessControl.AccessDenied>;
	readonly resume: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, Database.FacilityError | AccessControl.AccessDenied>;
	readonly updateVerifier: (
		effectId: EffectIdType,
		conversationId: string,
		verifier: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	readonly title: (
		effectId: EffectIdType,
		conversationId: string
	) => Effect.Effect<string, Database.FacilityError>;
	readonly listConversations: (
		effectId: EffectIdType,
		subject: Identity.Subject
	) => Effect.Effect<
		ReadonlyArray<Schema.Schema.Type<typeof ConversationRow>>,
		Database.FacilityError
	>;
	/**
	 * One conversation as the reader sees it: its own rows, everything it delegated, and what it cost.
	 *
	 * Delegated rows come back here rather than through a second command because they are not a second
	 * conversation — nobody started them and nobody can reply to them. They are what one call in this
	 * transcript did, and the panel nests them under that call.
	 */
	readonly history: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<
		Readonly<{
			readonly conversationId: string;
			readonly title: string;
			readonly messages: ReadonlyArray<Schema.Schema.Type<typeof MessageRow>>;
			readonly usage: ConversationUsage;
		}>,
		Database.FacilityError | AccessControl.AccessDenied
	>;
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
		const syncWake = yield* SyncWake.Service;
		const queue = yield* TaskQueue.Service;
		const collections = yield* Collections.Service;
		const hostTools = yield* HostTools.Service;
		const connector = yield* Connector.Service;
		const documents = yield* ChatDocuments.Service;
		const budget = yield* InvocationBudget.Service;
		const remotes = yield* RemoteRegistry;

		/**
		 * Commits a chat mutation, then nudges the existing replica stream to drain its durable outbox.
		 *
		 * PostgreSQL triggers write the outbox row in the mutation's transaction. The announcement carries
		 * collection names only and is deliberately post-commit, so this is not a second data channel and
		 * cannot turn a delivered write into a reported failure.
		 */
		const syncMutation = Effect.fn('Agents.syncMutation')(function* (
			effectId: EffectIdType,
			query: BuiltQuery,
			collections: ReadonlyArray<'chat_session' | 'chat_message'>
		) {
			const response = yield* executeBuilt(effectId, database, query);
			yield* syncWake.announce(EffectId.make(`${effectId}:sync`), collections);
			return response;
		});
		const syncTransaction = Effect.fn('Agents.syncTransaction')(function* (
			effectId: EffectIdType,
			queries: ReadonlyArray<BuiltQuery>,
			collections: ReadonlyArray<'chat_session' | 'chat_message'>
		) {
			if (queries.length === 0) return;
			yield* transactionBuilt(effectId, database, queries);
			yield* syncWake.announce(EffectId.make(`${effectId}:sync`), collections);
		});

		/**
		 * The rows one signed-in reader may inspect, expressed once for both listing and history.
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
				.filter((tool) => agent.delegation !== 'disabled' || !isSandboxTool(tool.name));
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
			if (agentName === WEB_AGENT_NAME) return { name: WEB_AGENT_NAME } satisfies ResolvedAgent;
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
				...(envoy.delegation === undefined ? {} : { delegation: envoy.delegation })
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

		type QueuedAgentInput = StoredChatInput | StoredAgentMessageValue;
		const admitTurn = Effect.fn('Agents.admitTurn')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			agentName: string,
			conversationId: string,
			turnId: string,
			message: QueuedAgentInput,
			options: Readonly<{ readonly parentId?: string; readonly depth?: number }> = {}
		) {
			const agent = yield* resolveAgent(agentName);
			yield* access.authorize(subject, 'agent', agentName);
			let parentId = options.parentId ?? null;
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
							envoy_key: chatSession.envoy_key,
							parent_id: chatSession.parent_id
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
					const storedParent =
						row !== null && typeof row === 'object' ? Reflect.get(row, 'parent_id') : null;
					parentId = typeof storedParent === 'string' ? storedParent : null;
				}
			}
			if (message.kind === 'user_message') {
				for (const file of message.documents) {
					yield* documents.resolve(
						EffectId.make(`${effectId}:document:${file.storage_key}`),
						conversationId,
						file.storage_key
					);
				}
			}
			const taskInput = {
				conversationId,
				turnId,
				agent: agent.name
			} satisfies Schema.Json;
			const task = {
				command: 'agents.execute',
				input:
					options.depth === undefined
						? taskInput
						: InvocationBudget.stampDepth(taskInput, options.depth),
				effectId: turnId,
				lane: conversationId
			} as const;
			const nowEpochMs = yield* Clock.currentTimeMillis;
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
							status: 'queued',
							parent_agent_id: parentId,
							parts: [],
							resumed: 0,
							subject,
							agent_name: agent.name,
							usage_unreported: false
						})
					})
					.onConflictDoNothing({
						target: [chatMessage.conversation_id, chatMessage.turn_id, chatMessage.role]
					}),
				...queue.statements([task]).map(({ sql, parameters }) => transactionSql(sql, parameters)),
				// A caller owns the turn id so an unknown transport outcome can be retried safely. The
				// immutable user row and private task must both still describe this exact admission; reusing
				// an id for different work rolls the entire transaction back instead of returning a false receipt.
				transactionSql(
					`select case when exists (
						select 1 from "chat_message"
						where "conversation_id" = $1 and "turn_id" = $2 and "role" = 'user'
							and "content" = $3::jsonb
					) and exists (
						select 1 from "chat_message"
						where "conversation_id" = $1 and "turn_id" = $2 and "role" = 'assistant'
					) and exists (
						select 1 from "bolt_task"
						where "effect_id" = $2 and "command" = 'agents.execute'
							and "input"->>'conversationId' = $1
							and "input"->>'turnId' = $2
							and "input"->>'agent' = $4
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[conversationId, turnId, JSON.stringify(message), agent.name]
				)
			]);
			// Durable work exists before the scheduler is announced. An immediate tick can therefore never
			// observe an empty queue and disarm ahead of the commit that asked it to run.
			yield* queue.wake(EffectId.make(`${effectId}:wake`), nowEpochMs);
			yield* syncWake.announce(EffectId.make(`${effectId}:sync`), [
				'chat_session',
				'chat_message',
				'agent_mailbox',
				'agent_run'
			]);
			return { conversationId, taskId: turnId, turnId, status: 'queued' as const };
		});

		const executeTool = Effect.fn('Agents.executeTool')(function* (
			agent: ResolvedAgent,
			name: string,
			input: Schema.Json,
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string
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
			if (isPlatformTool(name)) return yield* executePlatformTool(name, input, context);
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
					budget,
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
									{ kind: 'user_message', text: parsed.task, documents: [] },
									{ parentId: conversationId, depth: parsed.depth }
								);
								return {
									agentId: childId,
									taskId: admitted.taskId,
									status: admitted.status
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
									{ depth: parsed.depth }
								);
								return {
									agentId: parsed.agentId,
									taskId: admitted.taskId,
									status: admitted.status
								};
							})
						),
					dequeue: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxTaskActionInput, value);
								return {
									agentId: parsed.agentId,
									taskId: parsed.taskId,
									dequeued: yield* dequeueConversation(actionId, parsed.agentId, parsed.taskId)
								};
							})
						),
					reorder: (actionId, value) =>
						action(
							Effect.gen(function* () {
								const parsed = yield* decodeAction(SandboxReorderActionInput, value);
								yield* reorderConversation(actionId, parsed.agentId, parsed.orderedTaskIds);
								return { agentId: parsed.agentId, reordered: true };
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
									pausedTaskIds: yield* stopConversation(actionId, parsed.agentId)
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

		/** Replays stored rows into the provider prompt used by both a new and a resumed turn. */
		const promptFor = (
			agent: ResolvedAgent,
			rows: ReadonlyArray<unknown>,
			subject: Identity.Subject,
			conversationId: string
		): Array<Schema.Json> => {
			const decodedRows = rows.map((row) => decodeMessageRow(row));
			const protectedRows = new Set<number>();
			for (let index = decodedRows.length - 1; index >= 0; index -= 1) {
				const row = decodedRows[index];
				if (row?._tag !== 'Some' || row.value.role !== 'assistant') continue;
				protectedRows.add(index);
				if (protectedRows.size === protectedAssistantTurns) break;
			}
			return [
				{ role: 'system', content: workspace.definition.prompt },
				...(agent.task === undefined ? [] : [{ role: 'system', content: agent.task }]),
				...decodedRows.flatMap((decoded, index): ReadonlyArray<Schema.Json> => {
					if (decoded._tag === 'None') return [];
					const input = parseStoredChatInput(decoded.value.content);
					if (input !== null) return [{ role: 'user', content: chatInputForModel(input) }];
					const relayed = parseAgentMessage(decoded.value.content);
					if (relayed !== null) return [{ role: 'user', content: agentMessageForModel(relayed) }];
					const whole = decodeMessageContent(decoded.value.content);
					if (whole._tag === 'None') return [];
					const isolated =
						conversationId.includes(':group:') &&
						whole.value.subject !== undefined &&
						whole.value.subject.userId !== subject.userId
							? whole.value.parts.filter((part) => part.kind !== 'tool-result')
							: whole.value.parts;
					const denominator = Math.max(decodedRows.length - 1, 1);
					const ageFraction = (decodedRows.length - 1 - index) / denominator;
					return replayTurn(pruneToolOutput(isolated, ageFraction, protectedRows.has(index)));
				})
			];
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

		/**
		 * Enqueues the parent continuation only after this delegated session has durably settled.
		 *
		 * Enqueueing from `await_agent` races the child: the queue can run the continuation while
		 * the child is still `running`. Settlement is the event that makes the input actionable, and the
		 * key makes a replay of that settlement one enqueue.
		 */
		const resumeParent = Effect.fn('Agents.resumeParent')(function* (
			effectId: EffectIdType,
			conversationId: string,
			targetTaskId: string
		) {
			const parent = yield* executeBuilt(
				EffectId.make(`${effectId}:read-parent`),
				database,
				composer
					.select({ parent_id: chatSession.parent_id })
					.from(chatSession)
					.where(eq(chatSession.conversation_id, conversationId))
					.limit(1)
			);
			const decoded = Schema.decodeUnknownOption(
				Schema.Struct({ parent_id: Schema.Union([Schema.String, Schema.Null]) })
			)(parent.rows[0]);
			const parentId = decoded._tag === 'Some' ? decoded.value.parent_id : null;
			if (parentId === null) return;
			const enqueueId = EffectId.make(`${effectId}:resume-parent`);
			yield* queue.enqueue(enqueueId, [
				{
					command: 'agents.continue',
					input: {
						conversationId: parentId,
						agentId: conversationId,
						taskId: targetTaskId
					},
					effectId: enqueueId
				}
			]);
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

		/** Runs one bounded segment of a turn, shared by its first invocation and every continuation. */
		const continueToolLoop = Effect.fn('Agents.continueToolLoop')(function* (
			namespace: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			conversationId: string,
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
				// Exhausting the bound is a terminal failure, never another unowned parked turn.
				let status: 'completed' | 'waiting' | 'failed' = 'failed';
				for (let round = 0; round < maxToolRounds; round += 1) {
					const response = yield* ai.execute(EffectId.make(`${namespace}:ai:${round}`), {
						_tag: 'Turn',
						model: 'default',
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
						status = 'completed';
						parts.push({ kind: 'text', text: text ?? '' });
						const current = yield* Ref.get(usage);
						yield* commit('running', current.cumulative, current.unreported);
						break;
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
					let parked = false;
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
							conversationId
						).pipe(
							Effect.catch((failure) =>
								failure instanceof ToolNotAllowed ||
								failure instanceof SkillError ||
								failure instanceof McpToolError
									? Effect.succeed({ error: failure.message })
									: Effect.fail(failure)
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
						const waiting = Schema.decodeUnknownOption(WaitingAnswer)(encoded);
						// `spawn_agent` starts work; only the explicit exact-task join point parks its caller.
						if (call.name === 'await_agent' && waiting._tag === 'Some') {
							output = encoded;
							status = 'waiting';
							parked = true;
							break;
						}
					}
					if (parked) break;
				}
				const current = yield* Ref.get(usage);
				return { output, status, ...current };
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

		/** Rewrites only the durable assistant turns whose task ids a queue lifecycle action changed. */
		const setTurnStatuses = Effect.fn('Agents.setTurnStatuses')(function* (
			effectId: EffectIdType,
			conversationId: string,
			taskIds: ReadonlyArray<string>,
			status: TurnStatus
		) {
			if (taskIds.length === 0) return;
			const candidates = yield* executeBuilt(
				EffectId.make(`${effectId}:read`),
				database,
				composer
					.select({ id: chatMessage.id, content: chatMessage.content })
					.from(chatMessage)
					.where(
						and(
							eq(chatMessage.conversation_id, conversationId),
							eq(chatMessage.role, 'assistant'),
							inArray(chatMessage.turn_id, taskIds)
						)
					)
			);
			const updates = candidates.rows.flatMap((row) => {
				const decoded = decodeStoredTurnMessageRow(row);
				return decoded._tag === 'Some'
					? [
							composer
								.update(chatMessage)
								.set({ content: JSON.stringify({ ...decoded.value.content, status }) })
								.where(eq(chatMessage.id, decoded.value.id))
						]
					: [];
			});
			yield* syncTransaction(EffectId.make(`${effectId}:write`), updates, ['chat_message']);
		});

		const dequeueConversation = Effect.fn('Agents.dequeueConversation')(function* (
			effectId: EffectIdType,
			conversationId: string,
			taskId: string
		) {
			const removed = yield* queue.dequeue(
				EffectId.make(`${effectId}:task`),
				taskId,
				conversationId,
				'agents.execute'
			);
			if (!removed) return false;
			yield* setTurnStatuses(
				EffectId.make(`${effectId}:turns`),
				conversationId,
				[taskId],
				'dequeued'
			);
			yield* resumeParent(EffectId.make(`${effectId}:parent`), conversationId, taskId);
			return true;
		});

		const reorderConversation = Effect.fn('Agents.reorderConversation')(function* (
			effectId: EffectIdType,
			conversationId: string,
			orderedTaskIds: ReadonlyArray<string>
		) {
			const unique = [...new Set(orderedTaskIds)];
			if (unique.length !== orderedTaskIds.length) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: conversationId,
					reason: 'queue order contains the same task more than once'
				});
			}
			const queued = yield* executeBuilt(
				EffectId.make(`${effectId}:queued`),
				database,
				composer
					.select({ task_id: agentRun.task_id })
					.from(agentRun)
					.where(
						and(
							eq(agentRun.conversation_id, conversationId),
							inArray(agentRun.status, ['queued', 'paused', 'resuming'])
						)
					)
			);
			const available = new Set(
				queued.rows.flatMap((row) => {
					const decoded = decodeTaskIdRow(row);
					return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
				})
			);
			if (unique.length !== available.size || unique.some((taskId) => !available.has(taskId))) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: conversationId,
					reason: 'queue order must name every mutable task in this conversation exactly once'
				});
			}
			yield* queue.reorder(
				EffectId.make(`${effectId}:tasks`),
				conversationId,
				'agents.execute',
				unique
			);
		});

		const interruptConversation = Effect.fn('Agents.interruptConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const taskIds = yield* queue.interruptLane(
				EffectId.make(`${effectId}:tasks`),
				conversationId,
				'agents.execute'
			);
			yield* setTurnStatuses(
				EffectId.make(`${effectId}:turns`),
				conversationId,
				taskIds,
				'interrupted'
			);
			for (const taskId of taskIds)
				yield* resumeParent(EffectId.make(`${effectId}:parent:${taskId}`), conversationId, taskId);
			return taskIds;
		});

		const stopConversation = Effect.fn('Agents.stopConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const taskIds = yield* queue.stopLane(
				EffectId.make(`${effectId}:tasks`),
				conversationId,
				'agents.execute'
			);
			yield* setTurnStatuses(EffectId.make(`${effectId}:turns`), conversationId, taskIds, 'paused');
			return taskIds;
		});

		const resumeConversation = Effect.fn('Agents.resumeConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const paused = yield* executeBuilt(
				EffectId.make(`${effectId}:paused`),
				database,
				composer
					.select({ task_id: agentRun.task_id })
					.from(agentRun)
					.where(and(eq(agentRun.conversation_id, conversationId), eq(agentRun.status, 'paused')))
			);
			const taskIds = paused.rows.flatMap((row) => {
				const decoded = decodeTaskIdRow(row);
				return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
			});
			yield* queue.resumeLane(EffectId.make(`${effectId}:tasks`), conversationId, 'agents.execute');
			yield* setTurnStatuses(EffectId.make(`${effectId}:turns`), conversationId, taskIds, 'queued');
			return taskIds;
		});

		return Service.of({
			open: Effect.fn('Agents.open')(function* (effectId, subject, agentName, conversationId) {
				const agent = yield* resolveAgent(agentName);
				yield* access.authorize(subject, 'agent', agentName);
				yield* openConversation(effectId, agent, subject, conversationId);
			}),
			bindDocument: Effect.fn('Agents.bindDocument')(
				function* (effectId, subject, conversationId, file) {
					yield* requireReadableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					if (!isChatDocumentStorageKey(conversationId, file.storage_key)) {
						return yield* new ChatDocuments.ChatDocumentError({
							conversationId,
							message: 'The document key is outside this chat session namespace.'
						});
					}
					yield* documents.bind(effectId, conversationId, file, { source: 'web' });
				}
			),
			resolveDocument: Effect.fn('Agents.resolveDocument')(
				function* (effectId, subject, conversationId, storageKey) {
					yield* requireReadableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					return yield* documents.resolve(effectId, conversationId, storageKey);
				}
			),
			removeDocument: Effect.fn('Agents.removeDocument')(
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
				function* (effectId, subject, agentName, conversationId, turnId, message) {
					return yield* admitTurn(effectId, subject, agentName, conversationId, turnId, message);
				}
			),
			execute: Effect.fn('Agents.execute')(function* (effectId, conversationId, turnId) {
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
						reason: 'queued turn does not exist'
					});
				}
				const stored = decoded.value.content;
				if (stored.subject === undefined || stored.agent_name === undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'queued turn has no execution authority'
					});
				}
				if (
					stored.status === 'completed' ||
					stored.status === 'interrupted' ||
					stored.status === 'dequeued'
				) {
					return {
						conversationId,
						output: null,
						status: stored.status === 'completed' ? 'completed' : 'failed'
					};
				}
				// A failed assistant row is retryable state, not a second terminal authority. The task
				// queue decides whether the failure receives another attempt; when it does, this exact
				// persisted turn must be able to continue. A non-retryable or exhausted queue row is never
				// dispatched again, so it remains failed without inventing a parallel retry flag here.
				const subject = stored.subject;
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(subject, 'agent', stored.agent_name);
				const transcript = yield* executeBuilt(
					EffectId.make(`${effectId}:transcript`),
					database,
					composer
						.select({ role: chatMessage.role, content: chatMessage.content })
						.from(chatMessage)
						.where(eq(chatMessage.conversation_id, conversationId))
						.orderBy(desc(chatMessage.sequence))
						.limit(recentPromptRows)
				);
				const parts: Array<TurnPart> = [...stored.parts];
				let committed = 0;
				const commit: CommitTurn = (status, usage, usageUnreported) =>
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
							.where(eq(chatMessage.id, decoded.value.id)),
						['chat_message']
					);
				yield* commit('running', stored.usage, stored.usage_unreported ?? false);
				const settleUsage: SettleUsage = (usage, newlyUnreported) =>
					recordUsage(
						EffectId.make(`${effectId}:usage`),
						conversationId,
						usage,
						stored.status === 'queued' ? 1 : 0,
						newlyUnreported ? 1 : 0
					);
				const settled = yield* continueToolLoop(
					effectId,
					agent,
					subject,
					conversationId,
					promptFor(agent, transcript.rows.toReversed(), subject, conversationId),
					toolsFor(subject, agent),
					parts,
					stored.usage,
					stored.usage_unreported ?? false,
					commit,
					settleUsage
				);
				if (settled.status !== 'waiting') {
					yield* commit(settled.status, settled.cumulative, settled.unreported);
				}
				yield* Effect.ignore(settleUsage(settled.segment, settled.unreported));
				if (settled.status !== 'waiting') {
					if ('audience' in agent) {
						const completionId = EffectId.make(`${effectId}:envoy-complete`);
						yield* queue.enqueue(completionId, [
							{
								command: 'envoys.complete',
								input: {
									envoy: agent.name,
									conversationId,
									output: settled.output
								},
								effectId: completionId
							}
						]);
					}
					yield* resumeParent(effectId, conversationId, turnId);
				}
				return { conversationId, output: settled.output, status: settled.status };
			}),
			continue: Effect.fn('Agents.continue')(function* (effectId, conversationId, agentId, taskId) {
				/**
				 * Authority is structural first: the target must be this conversation's child and both rows
				 * must belong to the same sandbox. A task carries no credential, so accepting either id by
				 * itself would make the internal command a cross-conversation transcript reader.
				 */
				const parentResult = yield* executeBuilt(
					EffectId.make(`${effectId}:authorize:parent`),
					database,
					composer
						.select({ sandbox_key: chatSession.sandbox_key })
						.from(chatSession)
						.where(eq(chatSession.conversation_id, conversationId))
						.limit(1)
				);
				const targetAgentResult = yield* executeBuilt(
					EffectId.make(`${effectId}:authorize:target`),
					database,
					composer
						.select({ parent_id: chatSession.parent_id, sandbox_key: chatSession.sandbox_key })
						.from(chatSession)
						.where(eq(chatSession.conversation_id, agentId))
						.limit(1)
				);
				const parent = Schema.decodeUnknownOption(Schema.Struct({ sandbox_key: Schema.String }))(
					parentResult.rows[0]
				);
				const targetAgent = Schema.decodeUnknownOption(
					Schema.Struct({
						parent_id: Schema.Union([Schema.String, Schema.Null]),
						sandbox_key: Schema.String
					})
				)(targetAgentResult.rows[0]);
				if (
					parent._tag === 'None' ||
					targetAgent._tag === 'None' ||
					targetAgent.value.parent_id !== conversationId ||
					targetAgent.value.sandbox_key !== parent.value.sandbox_key
				) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: agentId,
						reason: 'target is not a delegated session of this conversation'
					});
				}

				const targetResult = yield* executeBuilt(
					EffectId.make(`${effectId}:target`),
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
						.orderBy(desc(chatMessage.sequence))
				);
				const target = targetResult.rows.flatMap((row) => {
					const decoded = Schema.decodeUnknownOption(SettledTargetRow)(row);
					return decoded._tag === 'Some' ? [decoded.value] : [];
				})[0];
				if (target === undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: agentId,
						reason: 'target session has not settled'
					});
				}

				const parkedResult = yield* executeBuilt(
					EffectId.make(`${effectId}:parked`),
					database,
					composer
						.select({ id: chatMessage.id, content: chatMessage.content })
						.from(chatMessage)
						.where(
							and(
								eq(chatMessage.conversation_id, conversationId),
								eq(chatMessage.role, 'assistant')
							)
						)
						.orderBy(desc(chatMessage.sequence))
				);
				const parked = parkedResult.rows.flatMap((row) => {
					const decoded = decodeStoredTurnMessageRow(row);
					return decoded._tag === 'Some' && decoded.value.content.status === 'running'
						? [decoded.value]
						: [];
				})[0];
				// A replay after the parent settled is an idempotent no-op.
				if (parked === undefined) return;
				const stored = parked.content;
				const parkedMessageId = parked.id;
				if (stored.subject === undefined || stored.agent_name === undefined) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'parked turn has no continuation authority'
					});
				}
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(stored.subject, 'agent', stored.agent_name);

				const parts = [...stored.parts];
				let answerIndex = -1;
				let waiting = false;
				for (let index = parts.length - 1; index >= 0; index -= 1) {
					const answer = parts[index];
					if (answer?.kind !== 'tool-result' || answer.name !== 'await_agent') continue;
					const call = parts.find(
						(part) => part.kind === 'tool' && part.id === answer.id && part.name === answer.name
					);
					if (call?.kind !== 'tool') continue;
					const input = Schema.decodeUnknownOption(AwaitInput)(call.input);
					if (
						input._tag === 'None' ||
						input.value.agentId !== agentId ||
						input.value.taskId !== taskId
					)
						continue;
					answerIndex = index;
					waiting = Schema.decodeUnknownOption(WaitingAnswer)(answer.output)._tag === 'Some';
					break;
				}
				// A stale settlement for a different child cannot wake whichever child is currently awaited.
				if (answerIndex < 0) return;
				const alreadyResumed = stored.resumed ?? 0;
				const resumed = alreadyResumed + (waiting && alreadyResumed < maxResumes ? 1 : 0);
				const namespace = EffectId.make(`${stored.id}:resume:${resumed}`);
				let committed = 0;
				const commit: CommitTurn = (status, usage, usageUnreported) =>
					syncMutation(
						EffectId.make(`${effectId}:turn:${(committed += 1)}`),
						composer
							.update(chatMessage)
							.set({
								content: JSON.stringify({
									...stored,
									status,
									parts,
									resumed,
									...(usage === undefined ? {} : { usage }),
									usage_unreported: usageUnreported
								})
							})
							.where(eq(chatMessage.id, parkedMessageId)),
						['chat_message']
					);

				if (waiting && alreadyResumed >= maxResumes) {
					yield* commit('failed', stored.usage, stored.usage_unreported ?? false);
					yield* resumeParent(namespace, conversationId, stored.id);
					return;
				}
				if (waiting) {
					const previous = parts[answerIndex];
					if (previous?.kind !== 'tool-result') return;
					parts[answerIndex] = {
						...previous,
						output: { waiting: false, output: target.content }
					};
					yield* commit('running', stored.usage, stored.usage_unreported ?? false);
				}

				const transcript = yield* executeBuilt(
					EffectId.make(`${effectId}:read`),
					database,
					composer
						.select({ role: chatMessage.role, content: chatMessage.content })
						.from(chatMessage)
						.where(eq(chatMessage.conversation_id, conversationId))
						.orderBy(desc(chatMessage.sequence))
						.limit(recentPromptRows)
				);
				const settleUsage: SettleUsage = (usage, newlyUnreported) =>
					recordUsage(
						EffectId.make(`${namespace}:usage`),
						conversationId,
						usage,
						0,
						newlyUnreported ? 1 : 0
					);
				const settled = yield* continueToolLoop(
					namespace,
					agent,
					stored.subject,
					conversationId,
					promptFor(agent, transcript.rows.toReversed(), stored.subject, conversationId),
					toolsFor(stored.subject, agent),
					parts,
					stored.usage,
					stored.usage_unreported ?? false,
					commit,
					settleUsage
				);
				if (settled.status !== 'waiting') {
					yield* commit(settled.status, settled.cumulative, settled.unreported);
				}
				yield* Effect.ignore(
					settleUsage(settled.segment, settled.unreported && !(stored.usage_unreported ?? false))
				);
				if (settled.status !== 'waiting') {
					yield* resumeParent(namespace, conversationId, stored.id);
				}
			}),
			dequeue: Effect.fn('Agents.dequeue')(function* (effectId, subject, conversationId, taskId) {
				yield* requireControllableConversation(
					EffectId.make(`${effectId}:authorize`),
					subject,
					conversationId
				);
				yield* dequeueConversation(effectId, conversationId, taskId);
			}),
			reorder: Effect.fn('Agents.reorder')(
				function* (effectId, subject, conversationId, orderedTaskIds) {
					yield* requireControllableConversation(
						EffectId.make(`${effectId}:authorize`),
						subject,
						conversationId
					);
					yield* reorderConversation(effectId, conversationId, orderedTaskIds);
				}
			),
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
			title: Effect.fn('Agents.title')(function* (effectId, conversationId) {
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({ title: chatSession.title })
						.from(chatSession)
						.where(eq(chatSession.conversation_id, conversationId))
						.limit(1)
				);
				const row = result.rows[0];
				const decoded = decodeTitleRow(row);
				if (decoded._tag === 'Some' && decoded.value.title) return decoded.value.title;
				return 'New conversation';
			}),
			listConversations: Effect.fn('Agents.listConversations')(function* (effectId, subject) {
				// Delegated sessions are excluded: nobody started one and nobody can reply to it, and listing
				// them put a subagent's task prompt in the conversation picker as though it were a chat the
				// person had opened. They still reach the reader — inside the turn that spawned them.
				const publicScope =
					subject.admin === true && publicEnvoys.length > 0
						? and(
								inArray(chatSession.visibility, ['envoy_dm', 'envoy_group']),
								inArray(chatSession.envoy_key, publicEnvoys),
								inArray(chatSession.agent_name, publicEnvoys)
							)
						: undefined;
				const readScope =
					publicScope === undefined
						? eq(chatSession.user_id, subject.userId)
						: or(eq(chatSession.user_id, subject.userId), publicScope);
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
						.where(and(readScope, isNull(chatSession.parent_id)))
						.orderBy(desc(chatSession.conversation_id))
				);
				return result.rows.flatMap((row) => {
					const decoded = conversationRow(row);
					if (decoded === undefined || !canReadConversation(subject, decoded)) return [];
					const { sandbox_key: _sandboxKey, ...conversation } = decoded;
					return [conversation];
				});
			}),
			history: Effect.fn('Agents.history')(function* (effectId, subject, conversationId) {
				const owned = yield* executeBuilt(
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
							envoy_key: chatSession.envoy_key,
							usage_cost_usd: chatSession.usage_cost_usd,
							usage_cost_micro_units: chatSession.usage_cost_micro_units,
							usage_cost_currency: chatSession.usage_cost_currency,
							usage_total_tokens: chatSession.usage_total_tokens,
							usage_turns_counted: chatSession.usage_turns_counted,
							usage_turns_unreported: chatSession.usage_turns_unreported
						})
						.from(chatSession)
						.where(eq(chatSession.conversation_id, conversationId))
						.limit(1)
				);
				const conversation = conversationRow(owned.rows[0]);
				if (conversation === undefined || !canReadConversation(subject, conversation)) {
					return yield* new AccessControl.AccessDenied({
						action: 'read',
						resource: conversationId,
						reason: 'unknown conversation'
					});
				}
				const tree = [conversationId];
				let frontier = [conversationId];
				for (let depth = 0; frontier.length > 0 && depth < maxDelegationDepth; depth += 1) {
					const children = yield* executeBuilt(
						EffectId.make(`${effectId}:tree:${depth}`),
						database,
						composer
							.select({ conversation_id: chatSession.conversation_id })
							.from(chatSession)
							.where(inArray(chatSession.parent_id, frontier))
					);
					frontier = children.rows.flatMap((row) => {
						const decoded = Schema.decodeUnknownOption(
							Schema.Struct({ conversation_id: Schema.String })
						)(row);
						return decoded._tag === 'Some' && !tree.includes(decoded.value.conversation_id)
							? [decoded.value.conversation_id]
							: [];
					});
					tree.push(...frontier);
				}
				// `sequence` is table-wide, so one ordered read preserves each session's transcript order.
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
						.where(inArray(chatMessage.conversation_id, tree))
						.orderBy(asc(chatMessage.sequence))
				);
				return {
					conversationId,
					title: conversation.title ?? 'New conversation',
					messages: transcript.rows.flatMap((row) => {
						const decoded = decodeMessageRow(row);
						return decoded._tag === 'Some' ? [decoded.value] : [];
					}),
					usage: conversationUsage(owned.rows[0])
				};
			}),
			listSkills: (subject) => allowedSkills(subject).map(({ name }) => name),
			readSkill: Effect.fn('Agents.readSkill')((subject, name) =>
				readSkillBody(allowedSkills(subject), name)
			)
		});
	})
);
