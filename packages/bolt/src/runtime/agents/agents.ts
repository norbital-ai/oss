import { Context, Effect, Layer, Option, Ref, Result, Schema } from 'effect';
import {
	chat,
	maxIterations,
	toolDefinition,
	type ChatMiddleware,
	type JSONSchema,
	type ModelMessage
} from '@tanstack/ai';
import { InternalLogger } from '@tanstack/ai/adapter-internals';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import {
	addAIUsage,
	AIUsage,
	EffectId,
	readAIUsage,
	type AgentEnqueueResult,
	type ChatDocumentRef,
	type DatabaseResponse,
	type EffectId as EffectIdType
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
export type AgentSurface = Readonly<{
	readonly observe: (messages: ReadonlyArray<ModelMessage>) => Effect.Effect<void, unknown>;
	readonly currentKey: () => string | null;
	readonly complete?: (output: Schema.Json) => Effect.Effect<void, unknown>;
}>;
type ResolvedAgent = Readonly<{
	readonly name: string;
	readonly task?: string;
	readonly audience?: 'public' | 'authenticated';
	readonly delegation: 'enabled' | 'disabled';
}>;
const workbenchKeyFor = (conversationId: string): string => conversationId;
const MAX_GOAL_ATTEMPTS = 3;
const silentTanStackLogger = new InternalLogger(
	{ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
	{
		provider: false,
		output: false,
		middleware: false,
		tools: false,
		agentLoop: false,
		config: false,
		errors: false,
		request: false,
		sandbox: false
	}
);
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
	executeSandboxTool,
	isSandboxTool,
	sandboxToolSpecs
} from '#lib/runtime/agents/sandbox-tools.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as ChatDocuments from '#lib/runtime/agents/documents.js';
import {
	appMetadataFromStorage,
	answerPayload,
	canonicalPrompt,
	canonicalTranscriptSelect,
	claimPendingCtes,
	committedChatChanges,
	conversationRow,
	contextPolicyMiddleware,
	decodeAdmissionResultRow,
	decodeAgentModelCatalog,
	decodeAwaitRunRow,
	decodeCanonicalTranscriptRow,
	decodeRunBoundaryRow,
	decodeRunExecutionRow,
	decodeSettlementResultRow,
	decodeVerifierConfig,
	delegatedAgentInput,
	facilityTextAdapter,
	GoalVerdict,
	goalVerdictJsonSchema,
	projectAgentContext,
	safeJson,
	SandboxAdmitActionInput,
	SandboxAgentActionInput,
	SandboxSpawnActionInput,
	SandboxTaskActionInput,
	semanticHash,
	storageForModelMessage,
	taskIds,
	userAgentInput,
	type AgentInput,
	type AgentModelDescriptor,
	type AppMessageMetadata,
	type AuthorizedConversation,
	type CanonicalMessageStorageEnvelope
} from './agent-runtime.js';
export { mcpToolName, parseMcpToolName, resolveTool, userAgentInput } from './agent-runtime.js';
const {
	agent_inbox: agentInbox,
	agent_lane: agentLane,
	chat_session: chatSession,
	chat_message: chatMessage
} = SYSTEM_MODEL_TABLES;
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
type GoalContinuation = Readonly<{
	readonly subject: Identity.Subject;
	readonly authorityFingerprint: string;
	readonly agentReleaseId: string;
	readonly resolvedModel: AgentModelDescriptor;
	readonly depth: number;
}>;
type CanonicalMessageEnvelope = CanonicalMessageStorageEnvelope &
	Readonly<{ readonly goalContinuation?: GoalContinuation }>;
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
export type AgentEnqueueOutcome = AgentEnqueueResult & Readonly<{ readonly output?: Schema.Json }>;
export type AgentInputMode = 'queue' | 'steer';
export type AgentInputSource = 'web' | 'envoy' | 'delegated';
type AdmissionOptions = Readonly<{
	readonly parentId?: string;
	readonly workbenchKey?: string;
	readonly depth?: number;
	readonly model?: string;
	readonly mode?: AgentInputMode;
	readonly source?: AgentInputSource;
	readonly intent?: 'do' | 'plan' | 'compact';
	readonly verifierPrompt?: string;
}>;
type DocumentError =
	Database.FacilityError | AccessControl.AccessDenied | ChatDocuments.ChatDocumentError;
export type Interface = Readonly<{
	open: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string
	) => Effect.Effect<
		void,
		Workspace.WorkspaceLookupError | AccessControl.AccessDenied | Database.FacilityError
	>;
	enqueue: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		agentName: string,
		conversationId: string,
		turnId: string,
		message: AgentInput,
		model?: string,
		surface?: AgentSurface,
		mode?: AgentInputMode,
		source?: AgentInputSource,
		intent?: 'do' | 'plan' | 'compact',
		verifierPrompt?: string
	) => Effect.Effect<AgentEnqueueOutcome, AgentExecutionError>;
	execute: (
		effectId: EffectIdType,
		conversationId: string,
		turnId: string,
		surface?: AgentSurface
	) => Effect.Effect<TurnResultValue, AgentExecutionError>;
	attachFile: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		file: ChatDocumentRef
	) => Effect.Effect<void, DocumentError>;
	readMedia: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<
		Readonly<{ readonly file: ChatDocumentRef; readonly bytes: Uint8Array }>,
		DocumentError
	>;
	removeFile: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string,
		storageKey: string
	) => Effect.Effect<void, DocumentError>;
	running: (
		effectId: EffectIdType,
		conversationId: string
	) => Effect.Effect<boolean, Database.FacilityError>;
	stop: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, AgentExecutionError>;
	resume: (
		effectId: EffectIdType,
		subject: Identity.Subject,
		conversationId: string
	) => Effect.Effect<void, AgentExecutionError>;
	updateVerifier: (
		effectId: EffectIdType,
		conversationId: string,
		verifier: Schema.Json
	) => Effect.Effect<void, Database.FacilityError>;
	listSkills: (subject: Identity.Subject) => ReadonlyArray<string>;
	readSkill: (subject: Identity.Subject, name: string) => Effect.Effect<string, SkillError>;
}>;
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
		const publishRows = (
			effectId: EffectIdType,
			rows: ReadonlyArray<unknown>,
			conversationId: string
		) => syncCommit.publish(effectId, { changes: committedChatChanges(rows, conversationId) });
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
		type RunFence = Readonly<{
			readonly runId: string;
			readonly generation: number;
			readonly driverEpoch: number;
		}>;
		const appendModelMessage = Effect.fn('Agents.appendModelMessage')(function* (
			effectId: EffectIdType,
			message: ModelMessage,
			envelope: CanonicalMessageEnvelope & RunFence & Readonly<{ readonly iterationIndex: number }>
		) {
			const stored = storageForModelMessage(message, envelope);
			const committed = yield* transactionBuilt(effectId, database, [
				transactionSql(
					`select case when exists (
						select 1 from "agent_run" run join "agent_lane" lane
							on lane."conversation_id" = run."conversation_id"
						where run."run_id" = $1 and run."generation" = $2
							and run."driver_epoch" = $3 and run."status" = 'running'
							and lane."active_run_id" = run."run_id"
							and lane."active_generation" = run."generation"
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[envelope.runId, envelope.generation, envelope.driverEpoch]
				),
				composer
					.insert(chatMessage)
					.values(stored.header)
					.onConflictDoNothing({ target: chatMessage.message_id }),
				...(stored.fields.length === 0
					? []
					: [
							transactionSql(
								`insert into "chat_message_part" ("message_id", "field", "ordinal", "payload")
								select $1, value->>'field', (value->>'ordinal')::integer, value->'payload'
								from jsonb_array_elements($2::jsonb) value
								on conflict ("message_id", "field", "ordinal") do nothing`,
								[stored.message.id!, JSON.stringify(stored.fields)]
							)
						]),
				transactionSql(
					`select case when exists (
						select 1 from "chat_message" where "message_id" = $1 and "semantic_hash" = $2
					) and (select count(*) from "chat_message_part" where "message_id" = $1) = $3
					then 1 else 1 / ((random() * 0)::integer) end`,
					[stored.message.id!, stored.header.semantic_hash, stored.fields.length]
				),
				...(envelope.goalContinuation === undefined
					? []
					: [
							transactionSql(
								`insert into "agent_inbox" (
							"tenant_id", "conversation_id", "message_id", "receipt_sequence",
							"source_kind", "source_message_id", "requested_mode", "state",
							"subject_snapshot", "authority_fingerprint", "agent_release_id",
							"resolved_model", "depth"
						)
						select $1, $2, message."message_id", message."sequence", 'goal', $3, 'queue', 'pending',
							$4::jsonb, $5, $6, $7::jsonb, $8
						from "chat_message" message where message."message_id" = $3
						on conflict ("tenant_id", "conversation_id", "source_kind", "source_message_id")
						do nothing`,
								[
									envelope.goalContinuation.subject.tenantId,
									envelope.conversationId,
									stored.message.id!,
									JSON.stringify(envelope.goalContinuation.subject),
									envelope.goalContinuation.authorityFingerprint,
									envelope.goalContinuation.agentReleaseId,
									JSON.stringify(envelope.goalContinuation.resolvedModel),
									envelope.goalContinuation.depth
								]
							)
						]),
				transactionSql(
					`select 'chat_message'::text as "collection", message."id"::text as "record_id"
					from "chat_message" message where message."message_id" = $1
					union all
					select 'chat_message_part', part."id"::text from "chat_message_part" part
					where part."message_id" = $1
					union all
					select 'agent_inbox', inbox."id"::text from "agent_inbox" inbox
					where inbox."conversation_id" = $2 and inbox."source_kind" = 'goal'
						and inbox."source_message_id" = $1`,
					[stored.message.id!, envelope.conversationId]
				)
			]);
			yield* publishRows(
				EffectId.make(`${effectId}:publish`),
				committed.rows,
				envelope.conversationId
			);
			return stored.message;
		});
		const runBoundary = Effect.fn('Agents.runBoundary')(function* (
			effectId: EffectIdType,
			conversationId: string,
			fence: RunFence
		) {
			const response = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `select case
					when lane."conversation_id" is null or run."run_id" is null then 'stale'
					when lane."active_run_id" <> run."run_id"
						or lane."active_generation" <> run."generation"
						or run."generation" <> $3 or run."driver_epoch" <> $4
						or run."status" <> 'running' then 'stale'
					when lane."state" = 'stopped' then 'stopped'
					when lane."requested_generation" > lane."active_generation" then 'steer'
					else 'continue' end as "decision"
				from "agent_lane" lane
				join "agent_run" run on run."run_id" = $2
				where lane."conversation_id" = $1`,
				parameters: [conversationId, fence.runId, fence.generation, fence.driverEpoch]
			});
			const decoded = decodeRunBoundaryRow(response.rows[0]);
			return decoded._tag === 'Some' ? decoded.value.decision : ('stale' as const);
		});
		const publicEnvoys = workspace.definition.envoys
			.filter(({ audience }) => audience === 'public')
			.map(({ name }) => name);
		const canReadConversation = (
			subject: Identity.Subject,
			conversation: AuthorizedConversation
		): boolean =>
			conversation.user_id === subject.userId ||
			(subject.admin === true &&
				(conversation.visibility === 'envoy_dm' || conversation.visibility === 'envoy_group') &&
				conversation.envoy_key !== null &&
				publicEnvoys.includes(conversation.envoy_key) &&
				conversation.agent_name === conversation.envoy_key);
		const requireReadableConversation = Effect.fn('Agents.requireReadableConversation')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string
		) {
			const result = yield* executeBuilt(
				effectId,
				database,
				composer
					.select()
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
		const authoritySnapshot = (subject: Identity.Subject, agent: ResolvedAgent) => ({
			authorityFingerprint: semanticHash({
				subject,
				agent: agent.name,
				tools: allowedTools(subject, agent)
					.map(({ name }) => name)
					.toSorted()
			}),
			agentReleaseId: semanticHash({
				name: agent.name,
				task: agent.task,
				prompt: workspace.definition.prompt
			})
		});
		const writesForSubject = (subject: Identity.Subject): boolean =>
			workspace.definition.collections.some((collection) =>
				(['create', 'update', 'delete'] as const).some(
					(action) => access.explain(subject, action, collection.name).allowed
				)
			);
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
		const sessionValues = (
			subject: Identity.Subject,
			agent: ResolvedAgent,
			conversationId: string,
			parentId: string | null = null,
			title?: string,
			workbenchKey: string = workbenchKeyFor(conversationId)
		) => ({
			conversation_id: conversationId,
			agent_name: agent.name,
			user_id: subject.userId,
			sandbox_key: workbenchKey,
			parent_id: parentId,
			...(title === undefined ? {} : { title }),
			visibility:
				parentId !== null || agent.name === WEB_AGENT_NAME
					? ('personal' as const)
					: conversationId.includes(':group:')
						? ('envoy_group' as const)
						: ('envoy_dm' as const),
			envoy_key: parentId !== null || agent.name === WEB_AGENT_NAME ? null : agent.name
		});
		const openConversation = Effect.fn('Agents.openConversation')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			agentName: string,
			conversationId: string
		) {
			const agent = yield* resolveAgent(agentName);
			yield* access.authorize(subject, 'agent', agentName);
			yield* executeBuilt(
				effectId,
				database,
				composer
					.insert(chatSession)
					.values(sessionValues(subject, agent, conversationId))
					.onConflictDoNothing()
			);
		});
		const admitTurn = Effect.fn('Agents.admitTurn')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			agentName: string,
			conversationId: string,
			turnId: string,
			input: AgentInput,
			options: AdmissionOptions = {}
		) {
			const agent = yield* resolveAgent(agentName);
			yield* access.authorize(subject, 'agent', agentName);
			const resolvedModel = yield* resolveModel(options.model);
			const title = input.title.slice(0, 48);
			const source =
				options.source ??
				(options.parentId !== undefined
					? 'delegated'
					: agent.audience === undefined
						? 'web'
						: 'envoy');
			const verifierPrompt = options.verifierPrompt;
			const mode = options.mode ?? 'queue';
			const appMetadata: Schema.Json = {
				version: 1,
				kind: 'input',
				source,
				taskId: conversationId,
				intent: options.intent ?? 'do',
				...input.attribution
			};
			const canonical = storageForModelMessage(
				{ ...input.message, id: `input:${turnId}` },
				{ conversationId, appMetadata }
			);
			const { authorityFingerprint, agentReleaseId } = authoritySnapshot(subject, agent);
			const modelSnapshot = { id: resolvedModel.id, contextTokens: resolvedModel.contextTokens };
			const committed = yield* transactionBuilt(effectId, database, [
				composer
					.insert(chatSession)
					.values(
						sessionValues(
							subject,
							agent,
							conversationId,
							options.parentId ?? null,
							title,
							options.workbenchKey ?? workbenchKeyFor(conversationId)
						)
					)
					.onConflictDoNothing(),
				...(verifierPrompt === undefined
					? []
					: [
							composer
								.update(chatSession)
								.set({ verifier: JSON.stringify({ prompt: verifierPrompt }) })
								.where(eq(chatSession.conversation_id, conversationId))
						]),
				transactionSql(
					`select case when exists (select 1 from "chat_session" where
						"conversation_id" = $1 and "user_id" = $2 and "agent_name" = $3
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[conversationId, subject.userId, agent.name]
				),
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
					),
				composer
					.insert(agentLane)
					.values({ conversation_id: conversationId })
					.onConflictDoNothing({ target: agentLane.conversation_id }),
				composer
					.insert(chatMessage)
					.values(canonical.header)
					.onConflictDoNothing({ target: chatMessage.message_id })
					.returning({ id: chatMessage.id }),
				transactionSql(
					`select case when exists (select 1 from "chat_message" where
						"message_id" = $1 and "semantic_hash" = $2
					) then 1 else 1 / ((random() * 0)::integer) end`,
					[canonical.message.id, canonical.header.semantic_hash]
				),
				transactionSql(
					`insert into "agent_inbox" (
						"tenant_id", "conversation_id", "message_id", "receipt_sequence",
						"source_kind", "source_message_id", "requested_mode", "state",
						"subject_snapshot", "authority_fingerprint", "agent_release_id",
						"resolved_model", "depth"
					)
					select $1, $2, message."message_id", message."sequence", $3, $4, $5, 'pending',
						$6::jsonb, $7, $8, $9::jsonb, $10
					from "chat_message" message where message."message_id" = $11
					on conflict ("tenant_id", "conversation_id", "source_kind", "source_message_id")
					do nothing`,
					[
						subject.tenantId,
						conversationId,
						source,
						turnId,
						mode,
						JSON.stringify(subject),
						authorityFingerprint,
						agentReleaseId,
						JSON.stringify(modelSnapshot),
						options.depth ?? 0,
						canonical.message.id
					]
				),
				transactionSql(
					`update "agent_lane" lane set "requested_generation" = greatest(
						lane."requested_generation", lane."active_generation" + 1), "updated_at" = now(),
						"row_version" = lane."row_version" + 1
					where lane."conversation_id" = $1 and $2 = 'steer'
						and lane."state" = 'active' and lane."active_run_id" is not null
					returning 'agent_lane'::text as "collection", lane."id"::text as "record_id"`,
					[conversationId, mode]
				),
				transactionSql(
					`with locked_lane as (select lane.* from "agent_lane" lane where lane."conversation_id" = $1 for update),
					phase as (select lane.*, case when lane."requested_generation" > lane."active_generation"
						then 'steer' else 'input' end as cause from locked_lane lane where lane."state" = 'active'
						and lane."active_run_id" is null
					), ${claimPendingCtes}, advanced as (
					update "agent_lane" lane set "active_run_id" = run."run_id",
						"active_generation" = run."generation", "requested_generation" = case
							when (select cause from phase) = 'steer' and exists (
								select 1 from "agent_inbox" pending
								where pending."conversation_id" = $1 and pending."state" = 'pending'
									and pending."requested_mode" = 'steer'
									and pending."id" not in (select "id" from candidates)
							) then run."generation" + 1 else run."generation" end,
							"updated_at" = now(), "row_version" = lane."row_version" + 1
						from next_run run where lane."conversation_id" = $1
						returning lane."id"
					)
					select 'agent_run'::text as "collection", run."id"::text as "record_id" from next_run run
					union all select 'agent_inbox', claimed."id"::text from claimed
					union all select 'agent_lane', advanced."id"::text from advanced`,
					[conversationId]
				),
				transactionSql(
					`select 'chat_session'::text as "collection", session."id"::text as "record_id" from "chat_session" session
					where session."conversation_id" = $1 union all select 'chat_message', message."id"::text from "chat_message" message
					where message."message_id" = $2
					union all select 'agent_lane', lane."id"::text from "agent_lane" lane
					where lane."conversation_id" = $1
					union all select 'agent_inbox', inbox."id"::text from "agent_inbox" inbox
						where inbox."tenant_id" = $3 and inbox."conversation_id" = $1
							and inbox."source_kind" = $4 and inbox."source_message_id" = $5`,
					[conversationId, canonical.message.id, subject.tenantId, source, turnId]
				),
				transactionSql(
					`select "message_id", "claimed_by_run_id" from "agent_inbox"
						where "tenant_id" = $1 and "conversation_id" = $2
							and "source_kind" = $3 and "source_message_id" = $4 limit 1`,
					[subject.tenantId, conversationId, source, turnId]
				)
			]);
			yield* publishRows(EffectId.make(`${effectId}:publish`), committed.rows, conversationId);
			const admitted = committed.rows
				.map((row) => decodeAdmissionResultRow(row))
				.find(Option.isSome);
			if (admitted === undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: conversationId,
					reason: 'admitted turn was not readable'
				});
			}
			const runId = admitted.value.claimed_by_run_id ?? undefined;
			return {
				conversationId,
				taskId: conversationId,
				turnId,
				messageId: admitted.value.message_id,
				...(runId === undefined ? {} : { runId }),
				status: runId === undefined ? ('pending' as const) : ('running' as const)
			};
		});
		const executeTool = Effect.fn('Agents.executeTool')(function* (
			agent: ResolvedAgent,
			name: string,
			input: Schema.Json,
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string,
			workbenchKey: string,
			depth: number,
			modelId: string
		) {
			const allowlist = allowedTools(subject, agent);
			const declared = allowlist.find((tool) => tool.name === name);
			if (declared === undefined)
				return yield* new ToolNotAllowed({ agent: agent.name, tool: name });
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
					if (decoded._tag === 'None')
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: no storageKey` });
					const media = yield* documents
						.media(EffectId.make(`${effectId}:media`), conversationId, decoded.value.storageKey)
						.pipe(Effect.catch((failure) => Effect.succeed({ error: failure.message })));
					if ('error' in media) return media;
					if (!media.file.mime_type.startsWith('image/'))
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: not an image` });
					if (media.bytes.byteLength > 20 * 1024 * 1024)
						return yield* new ToolNotAllowed({ agent: agent.name, tool: `${name}: > 20 MiB` });
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
				const sandboxAction =
					<S extends Schema.Top & { readonly DecodingServices: never }, B>(
						schema: S,
						perform: (actionId: EffectIdType, parsed: S['Type']) => Effect.Effect<B, unknown>
					) =>
					(actionId: EffectIdType, value: Schema.Json) =>
						action(
							Effect.try({
								try: () => Schema.decodeUnknownSync(schema)(value),
								catch: () => new ToolNotAllowed({ agent: agent.name, tool: name })
							}).pipe(Effect.flatMap((parsed) => perform(actionId, parsed)))
						);
				return yield* executeSandboxTool(name, input, {
					effectId,
					subject,
					workbenchKey,
					agentName: agent.name,
					conversationId,
					database,
					budget: InvocationBudget.make(depth),
					spawn: sandboxAction(SandboxSpawnActionInput, (actionId, parsed) =>
						Effect.gen(function* () {
							const childId = `agent:${String(actionId)}`;
							const admitted = yield* admitTurn(
								actionId,
								subject,
								agent.name,
								childId,
								String(actionId),
								userAgentInput(parsed.task),
								{ parentId: conversationId, workbenchKey, depth: parsed.depth, model: modelId }
							);
							return {
								agentId: childId,
								taskId: admitted.taskId,
								status: 'running'
							};
						})
					),
					admit: sandboxAction(SandboxAdmitActionInput, (actionId, parsed) =>
						Effect.gen(function* () {
							const admitted = yield* admitTurn(
								actionId,
								subject,
								parsed.agentName,
								parsed.agentId,
								String(actionId),
								delegatedAgentInput(parsed.message),
								{
									depth: parsed.depth,
									model: modelId,
									...(parsed.mode === undefined ? {} : { mode: parsed.mode }),
									source: 'delegated'
								}
							);
							return {
								agentId: parsed.agentId,
								taskId: admitted.taskId,
								status: 'running'
							};
						})
					),
					awaitTarget: sandboxAction(SandboxTaskActionInput, (actionId, parsed) =>
						awaitDelegatedTurn(EffectId.make(`${actionId}:await`), parsed.agentId, parsed.taskId)
					),
					stop: sandboxAction(SandboxAgentActionInput, (actionId, parsed) =>
						Effect.gen(function* () {
							return {
								agentId: parsed.agentId,
								stoppedTaskIds: yield* stopConversation(actionId, parsed.agentId)
							};
						})
					),
					resume: sandboxAction(SandboxAgentActionInput, (actionId, parsed) =>
						Effect.gen(function* () {
							return {
								agentId: parsed.agentId,
								resumedTaskIds: yield* resumeConversation(actionId, subject, parsed.agentId)
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
		const toolsFor = (
			subject: Identity.Subject,
			agent: ResolvedAgent
		): ReadonlyArray<ToolDeclaration> =>
			allowedTools(subject, agent).map(({ name, description, ...tool }) => {
				if (name !== 'read_collection' && name !== 'write_collection') {
					return { name, description, ...tool };
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
					...tool
				};
			});
		let service: Interface;
		const runExactTurn = Effect.fn('Agents.runExactTurn')(function* (
			effectId: EffectIdType,
			conversationId: string,
			turnId: string,
			surface?: AgentSurface
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
		const drainLane = Effect.fn('Agents.drainLane')(function* (
			effectId: EffectIdType,
			conversationId: string,
			firstRunId: string,
			surface?: AgentSurface
		) {
			let runId = firstRunId;
			let result: TurnResultValue = {
				conversationId,
				output: null,
				status: 'failed'
			};
			for (let index = 0; ; index += 1) {
				result = yield* runExactTurn(
					EffectId.make(`${effectId}:run:${index}`),
					conversationId,
					runId,
					surface
				);
				const active = yield* runningRunIds(
					EffectId.make(`${effectId}:active:${index}`),
					conversationId
				);
				const next = active[0];
				if (next === undefined || next === runId) return result;
				runId = next;
			}
		});
		const awaitDelegatedTurn = Effect.fn('Agents.awaitDelegatedTurn')(function* (
			effectId: EffectIdType,
			agentId: string,
			taskId: string
		) {
			if (taskId !== agentId) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: taskId,
					reason: 'task does not belong to the requested agent'
				});
			}
			let read = 0;
			const target = () =>
				database.execute(EffectId.make(`${effectId}:target:${(read += 1)}`), {
					_tag: 'Query',
					sql: `select run."run_id", run."status" from "agent_run" run
						where run."conversation_id" = $1 order by run."generation" desc limit 1`,
					parameters: [agentId]
				});
			const answer = Effect.fn('Agents.delegatedAnswer')(function* (
				settledRunId: string,
				settledStatus: 'interrupted' | 'completed' | 'failed' | 'aborted'
			) {
				const output = yield* database.execute(EffectId.make(`${effectId}:output`), {
					_tag: 'Query',
					sql: `${canonicalTranscriptSelect}
						where message."run_id" = $1 and message."role" = 'assistant'
						group by message."id" order by message."iteration_index"`,
					parameters: [settledRunId]
				});
				return {
					agentId,
					taskId,
					status: settledStatus,
					output: canonicalPrompt(output.rows) as unknown as Schema.Json
				};
			});
			let current = yield* target();
			const initial = decodeAwaitRunRow(current.rows[0]);
			if (initial._tag === 'None') {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: taskId,
					reason: 'delegated task does not exist'
				});
			}
			if (initial.value.status !== 'running') {
				return yield* answer(initial.value.run_id, initial.value.status);
			}
			yield* drainLane(EffectId.make(`${effectId}:run`), agentId, initial.value.run_id);
			current = yield* target();
			const settled = decodeAwaitRunRow(current.rows[0]);
			if (settled._tag === 'Some' && settled.value.status !== 'running') {
				return yield* answer(settled.value.run_id, settled.value.status);
			}
			return yield* new AccessControl.AccessDenied({
				action: 'agent',
				resource: taskId,
				reason: 'delegated turn did not settle'
			});
		});
		type CommitRun = (
			status: 'running' | 'failed',
			usage: AIUsage | undefined,
			usageUnreported: boolean
		) => Effect.Effect<DatabaseResponse, Database.FacilityError>;
		const runTanStackLoop = Effect.fn('Agents.runTanStackLoop')(function* (
			namespace: EffectIdType,
			agent: ResolvedAgent,
			subject: Identity.Subject,
			depth: number,
			conversationId: string,
			workbenchKey: string,
			fence: RunFence,
			model: AgentModelDescriptor,
			messages: Array<ModelMessage>,
			systemPrompts: Array<string>,
			messageMetadata: ReadonlyMap<string, AppMessageMetadata>,
			intent: 'do' | 'plan' | 'compact',
			verifierPrompt: string | undefined,
			authorityFingerprint: string,
			agentReleaseId: string,
			tools: ReadonlyArray<ToolDeclaration>,
			observed: Array<ModelMessage>,
			initialUsage: AIUsage | undefined,
			initialUsageUnreported: boolean,
			commit: CommitRun
		) {
			const usage = yield* Ref.make({
				cumulative: initialUsage,
				segment: undefined as AIUsage | undefined,
				unreported: initialUsageUnreported
			});
			const recordUsage = async (reported: AIUsage | undefined) => {
				await Effect.runPromise(
					Ref.update(usage, (current) => ({
						cumulative: addAIUsage(current.cumulative, reported),
						segment: addAIUsage(current.segment, reported),
						unreported: current.unreported || reported === undefined
					}))
				);
			};
			const run = Effect.tryPromise({
				try: async () => {
					let persistedThrough = messages.length;
					const committedCallIds = new Set<string>();
					let nextIterationIndex = 0;
					let output: Schema.Json = null;
					const boundary = () =>
						Effect.runPromise(
							runBoundary(
								EffectId.make(`${namespace}:boundary:${nextIterationIndex}`),
								conversationId,
								fence
							)
						);
					const persist = async (current: ReadonlyArray<ModelMessage>, completion = false) => {
						let changed = false;
						for (const message of current.slice(persistedThrough)) {
							if (message.role !== 'assistant') continue;
							observed.push(message);
							output = answerPayload(message);
							for (const call of message.toolCalls ?? []) committedCallIds.add(call.id);
							const iterationIndex = nextIterationIndex++;
							await Effect.runPromise(
								appendModelMessage(
									EffectId.make(`${namespace}:message:${iterationIndex}`),
									message,
									{
										conversationId,
										...fence,
										iterationIndex,
										appMetadata:
											completion && intent !== 'do' && (message.toolCalls?.length ?? 0) === 0
												? {
														version: 1,
														kind: 'summary',
														fold: intent,
														intent,
														runId: fence.runId,
														iterationIndex
													}
												: { version: 1, intent, runId: fence.runId, iterationIndex }
									}
								)
							);
							changed = true;
						}
						persistedThrough = current.length;
						if (!changed) return;
						const state = await Effect.runPromise(Ref.get(usage));
						await Effect.runPromise(commit('running', state.cumulative, state.unreported));
					};
					const configuredTools = tools.map(({ name, description, inputSchema }) =>
						toolDefinition({
							name,
							description,
							inputSchema:
								(inputSchema as JSONSchema | undefined) ??
								({
									type: 'object',
									properties: {},
									additionalProperties: true
								} satisfies JSONSchema)
						}).server(async (input, context) => {
							const callId = context?.toolCallId ?? `${namespace}:tool:${name}`;
							return Effect.runPromise(
								executeTool(
									agent,
									name,
									input as Schema.Json,
									EffectId.make(callId),
									subject,
									conversationId,
									workbenchKey,
									depth,
									model.id
								).pipe(
									Effect.catch((failure) =>
										failure instanceof ToolNotAllowed ||
										failure instanceof SkillError ||
										failure instanceof McpToolError
											? Effect.succeed({ error: failure.message })
											: Effect.fail(failure)
									)
								)
							);
						})
					);
					const middleware: ChatMiddleware = {
						name: 'norbital-durable-boundaries',
						onBeforeToolCall: async (context) => {
							const decision = await boundary();
							if (decision !== 'continue') {
								return {
									type: 'skip',
									result: {
										terminal: true,
										status: 'not-executed',
										reason: decision
									}
								};
							}
							await persist(context.messages);
						},
						onAfterToolCall: async (context, info) => {
							if (!committedCallIds.has(info.toolCallId)) return;
							const toolMessage: ModelMessage = {
								id: `${fence.runId}:tool-result:${info.toolCallId}`,
								role: 'tool',
								name: info.toolName,
								toolCallId: info.toolCallId,
								content: safeJson(
									info.ok
										? info.result
										: {
												error: info.error instanceof Error ? info.error.message : String(info.error)
											}
								)
							};
							observed.push(toolMessage);
							await Effect.runPromise(
								appendModelMessage(
									EffectId.make(`${namespace}:tool-result:${info.toolCallId}`),
									toolMessage,
									{
										conversationId,
										...fence,
										iterationIndex: context.iteration,
										appMetadata: {
											version: 1,
											runId: fence.runId,
											iterationIndex: context.iteration
										}
									}
								)
							);
							const state = await Effect.runPromise(Ref.get(usage));
							await Effect.runPromise(commit('running', state.cumulative, state.unreported));
						},
						onShouldContinue: async () => (await boundary()) === 'continue',
						onFinish: async (context) => {
							if ((await boundary()) === 'continue') await persist(context.messages, true);
						}
					};
					if ((await boundary()) !== 'continue') {
						return {
							output,
							goalVerdict: undefined,
							goalExhausted: false,
							...(await Effect.runPromise(Ref.get(usage)))
						};
					}
					for await (const _chunk of chat({
						adapter: facilityTextAdapter(ai, model.id, String(namespace), recordUsage),
						messages,
						systemPrompts,
						tools: configuredTools,
						middleware: [
							contextPolicyMiddleware({
								contextTokens: model.contextTokens,
								metadata: messageMetadata,
								intent
							}),
							middleware
						],
						agentLoopStrategy: maxIterations(24),
						threadId: conversationId,
						runId: String(namespace),
						modelOptions: { maxOutputTokens: 2_048 }
					})) {
					}
					let goalVerdict: GoalVerdict | undefined;
					let goalExhausted = false;
					if (
						intent !== 'compact' &&
						verifierPrompt !== undefined &&
						(await boundary()) === 'continue'
					) {
						const verifierMessages = [...messages, ...observed];
						const verifierPrompts = [
							'You are an independent completion verifier. Judge observable task completion only.',
							'If any durable directive is incomplete, set achieved to false and enumerate concrete gaps.',
							`Completion contract:\n${verifierPrompt}`
						];
						const projection = projectAgentContext(
							{ contextTokens: model.contextTokens, metadata: messageMetadata, intent: 'do' },
							{ messages: verifierMessages, systemPrompts: [], tools: [] }
						);
						const verifier = facilityTextAdapter(
							ai,
							model.id,
							`${String(namespace)}:goal-verifier`,
							recordUsage
						).structuredOutput;
						if (verifier === undefined)
							throw new TypeError('AI adapter does not support goal verification');
						const verified = await verifier({
							chatOptions: {
								model: model.id,
								messages: projection.providerMessages ?? verifierMessages,
								systemPrompts: [...(projection.systemPrompts ?? []), ...verifierPrompts],
								threadId: conversationId,
								runId: `${fence.runId}:goal-verifier`,
								modelOptions: { maxOutputTokens: 1_024 },
								logger: silentTanStackLogger
							},
							outputSchema: goalVerdictJsonSchema
						});
						goalVerdict = Schema.decodeUnknownSync(GoalVerdict)(verified.data);
						const goalAttempt =
							[...messageMetadata.values()].filter((metadata) => metadata.kind === 'goal').length +
							1;
						goalExhausted = !goalVerdict.achieved && goalAttempt >= MAX_GOAL_ATTEMPTS;
						const iterationIndex = nextIterationIndex++;
						const goalMessage: ModelMessage = {
							id: `${fence.runId}:goal:${iterationIndex}`,
							role: 'user',
							content: safeJson({ resultType: 'goal_verdict', ...goalVerdict })
						};
						await Effect.runPromise(
							appendModelMessage(
								EffectId.make(`${namespace}:goal:${iterationIndex}`),
								goalMessage,
								{
									conversationId,
									...fence,
									iterationIndex,
									appMetadata: {
										version: 1,
										kind: 'goal',
										taskId: conversationId,
										runId: fence.runId,
										iterationIndex,
										attempt: goalAttempt,
										maxAttempts: MAX_GOAL_ATTEMPTS,
										exhausted: goalExhausted
									},
									...(!goalVerdict.achieved && !goalExhausted
										? {
												goalContinuation: {
													subject,
													authorityFingerprint,
													agentReleaseId,
													resolvedModel: model,
													depth
												}
											}
										: {})
								}
							)
						);
						observed.push(goalMessage);
						const state = await Effect.runPromise(Ref.get(usage));
						await Effect.runPromise(commit('running', state.cumulative, state.unreported));
					}
					const current = await Effect.runPromise(Ref.get(usage));
					return { output, goalVerdict, goalExhausted, ...current };
				},
				catch: (cause) =>
					cause instanceof Database.FacilityError
						? cause
						: new Database.FacilityError({
								operation: 'agents.chat',
								code: 'agent_loop_failure',
								message: Workspace.describeCause(cause),
								retryable: false,
								outcome: 'unknown'
							})
			});
			return yield* run.pipe(
				Effect.onError(() =>
					Effect.gen(function* () {
						const current = yield* Ref.get(usage);
						yield* Effect.ignore(commit('failed', current.cumulative, current.unreported));
					})
				)
			);
		});
		const runningRunIds = Effect.fn('Agents.runningRunIds')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const response = yield* executeBuilt(
				effectId,
				database,
				composer
					.select({ task_id: aliased(agentLane.active_run_id, 'task_id') })
					.from(agentLane)
					.where(eq(agentLane.conversation_id, conversationId))
					.limit(1)
			);
			return taskIds(response.rows);
		});
		const stopConversation = Effect.fn('Agents.stopConversation')(function* (
			effectId: EffectIdType,
			conversationId: string
		) {
			const committed = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: `with locked_lane as (
					select lane.* from "agent_lane" lane where lane."conversation_id" = $1 for update
				), stopped as (
					update "agent_lane" lane set "state" = 'stopped',
						"requested_generation" = case when lane."active_run_id" is null
							then lane."requested_generation"
							else greatest(lane."requested_generation", lane."active_generation" + 1) end,
						"updated_at" = now(), "row_version" = lane."row_version" + 1
					from locked_lane where lane."conversation_id" = $1 returning lane.*
				), cancelled as (
					update "agent_run" run set "cancel_requested" = true,
						"updated_at" = now(), "row_version" = run."row_version" + 1
					from stopped lane where run."run_id" = lane."active_run_id"
						and run."status" = 'running' returning run.*
				)
				select 'agent_lane'::text as "collection", lane."id"::text as "record_id",
					lane."active_run_id" as "task_id" from stopped lane
				union all select 'agent_run', run."id"::text, run."run_id" from cancelled run`,
				parameters: [conversationId]
			});
			yield* publishRows(EffectId.make(`${effectId}:publish`), committed.rows, conversationId);
			return taskIds(committed.rows);
		});
		const resumeConversation = Effect.fn('Agents.resumeConversation')(function* (
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string
		) {
			const conversation = yield* requireControllableConversation(
				EffectId.make(`${effectId}:conversation`),
				subject,
				conversationId
			);
			const agent = yield* resolveAgent(conversation.agent_name);
			yield* access.authorize(subject, 'agent', agent.name);
			const { authorityFingerprint, agentReleaseId } = authoritySnapshot(subject, agent);
			const response = yield* database.execute(EffectId.make(`${effectId}:resume`), {
				_tag: 'Query',
				sql: `with recursive locked_lane as (
						select lane.* from "agent_lane" lane where lane."conversation_id" = $1 for update
					), aborted_active as (
						update "agent_run" run set "status" = 'aborted', "disposition" = 'stopped',
							"finished_at" = floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
							"updated_at" = now(), "row_version" = run."row_version" + 1
						from locked_lane lane where lane."state" = 'stopped'
							and run."run_id" = lane."active_run_id" and run."status" = 'running'
						returning run.*
					), resume_source as (
						select run.* from aborted_active run
						union all
						select run.* from "agent_run" run join locked_lane lane
							on lane."resume_from_run_id" = run."run_id"
						where lane."state" = 'stopped' and lane."active_run_id" is null
							and not exists (select 1 from aborted_active)
					), lineage as (
						select session."conversation_id", session."parent_id" from "chat_session" session
						where session."conversation_id" = $1
						union all select parent."conversation_id", parent."parent_id" from "chat_session" parent
						join lineage child on parent."conversation_id" = child."parent_id"
					), accounted as (
						update "chat_session" session set
							"usage_cost_usd" = session."usage_cost_usd" + coalesce((run."usage"->>'costUsd')::double precision, 0),
							"usage_cost_micro_units" = session."usage_cost_micro_units" + case
								when run."usage"->>'costMicroUnits' is null then 0
								when run."usage"->>'costCurrency' is not null and (session."usage_cost_currency" is null
									or session."usage_cost_currency" = run."usage"->>'costCurrency')
								then (run."usage"->>'costMicroUnits')::bigint
								else 1 / ((random() * 0)::bigint) end,
							"usage_cost_currency" = case when run."usage"->>'costMicroUnits' is null
								then session."usage_cost_currency"
								else coalesce(run."usage"->>'costCurrency', session."usage_cost_currency") end,
							"usage_total_tokens" = session."usage_total_tokens" + coalesce((run."usage"->>'totalTokens')::bigint, 0),
							"usage_turns_counted" = session."usage_turns_counted" + 1,
							"usage_turns_unreported" = session."usage_turns_unreported" + case when run."usage_unreported" then 1 else 0 end,
							"updated_at" = now(), "row_version" = session."row_version" + 1
						from aborted_active run where session."conversation_id" in (select "conversation_id" from lineage)
						returning session."id"
					), first_pending as (
						select inbox.* from "agent_inbox" inbox cross join locked_lane lane
						where lane."state" = 'stopped'
							and inbox."conversation_id" = $1 and inbox."state" = 'pending'
						order by inbox."receipt_sequence" limit 1 for update of inbox
						), expected as (
							select first."source_kind",
								case when source."run_id" is null then first."authority_fingerprint" else $4 end as authority_fingerprint,
								case when source."run_id" is null then first."agent_release_id" else $5 end as agent_release_id,
								coalesce(source."resolved_model", first."resolved_model") as resolved_model,
								coalesce(source."depth", first."depth") as depth
							from first_pending first left join resume_source source on true
						), candidates as (
							select inbox.* from "agent_inbox" inbox cross join expected
							where inbox."conversation_id" = $1 and inbox."state" = 'pending'
								and inbox."source_kind" = expected."source_kind"
								and inbox."authority_fingerprint" = expected.authority_fingerprint
								and inbox."agent_release_id" = expected.agent_release_id
								and inbox."resolved_model" = expected.resolved_model
								and inbox."depth" = expected.depth
								and not exists (
									select 1 from "agent_inbox" prior
									where prior."conversation_id" = inbox."conversation_id"
										and prior."state" = 'pending'
										and prior."receipt_sequence" < inbox."receipt_sequence"
										and (prior."source_kind" <> expected."source_kind"
											or prior."authority_fingerprint" <> expected.authority_fingerprint
											or prior."agent_release_id" <> expected.agent_release_id
											or prior."resolved_model" <> expected.resolved_model
											or prior."depth" <> expected.depth)
							)
						for update of inbox
					), seed as (
						select 'resume'::text as cause,
							greatest(source."input_boundary", coalesce((select max("receipt_sequence") from candidates), source."input_boundary")) as input_boundary,
							$3::jsonb as subject_snapshot,
							$4::text as authority_fingerprint, $5::text as agent_release_id,
							source."resolved_model", source."depth"
						from resume_source source
						union all
						select 'input', (select max("receipt_sequence") from candidates), inbox."subject_snapshot",
							inbox."authority_fingerprint", inbox."agent_release_id", inbox."resolved_model",
							inbox."depth" from first_pending inbox
						where not exists (select 1 from resume_source)
				), created as (
					insert into "agent_run" (
						"run_id", "conversation_id", "generation", "status", "started_at", "cause",
						"input_boundary", "subject_snapshot", "authority_fingerprint", "agent_release_id",
						"resolved_model", "depth", "sandbox_key"
					)
					select $2, $1, greatest(lane."active_generation", lane."requested_generation") + 1,
						'running', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
						seed.cause, seed.input_boundary, seed.subject_snapshot, seed.authority_fingerprint,
						seed.agent_release_id, seed.resolved_model, seed.depth, session."sandbox_key"
					from seed cross join locked_lane lane join "chat_session" session
						on session."conversation_id" = $1 returning *
					), claimed as (
						update "agent_inbox" inbox set "state" = 'claimed',
							"claimed_by_run_id" = run."run_id", "claimed_at" = now(),
							"updated_at" = now(), "row_version" = inbox."row_version" + 1
						from created run where inbox."id" in (select "id" from candidates) returning inbox."id"
				), activated as (
					update "agent_lane" lane set "state" = 'active',
						"active_run_id" = run."run_id", "active_generation" = run."generation",
						"requested_generation" = run."generation", "resume_from_run_id" = null,
						"updated_at" = now(), "row_version" = lane."row_version" + 1
					from created run where lane."conversation_id" = $1 returning lane.*
				), idle_activated as (
					update "agent_lane" lane set "state" = 'active', "resume_from_run_id" = null,
						"updated_at" = now(), "row_version" = lane."row_version" + 1
					where lane."conversation_id" = $1 and lane."state" = 'stopped'
						and lane."active_run_id" is null and not exists (select 1 from created)
					returning lane.*
				)
					select run."run_id" as "task_id", 'agent_run'::text as "collection", run."id"::text as "record_id" from created run
					union all select null, 'agent_run', run."id"::text from aborted_active run
					union all select null, 'chat_session', session."id"::text from accounted session
					union all select null, 'agent_inbox', claimed."id"::text from claimed
				union all select null, 'agent_lane', lane."id"::text from activated lane
				union all select null, 'agent_lane', lane."id"::text from idle_activated lane`,
				parameters: [
					conversationId,
					`run:resume:${String(effectId)}`,
					JSON.stringify(subject),
					authorityFingerprint,
					agentReleaseId
				]
			});
			const resumed = taskIds(response.rows);
			yield* publishRows(EffectId.make(`${effectId}:publish`), response.rows, conversationId);
			if (resumed[0] !== undefined) {
				yield* drainLane(EffectId.make(`${effectId}:run`), conversationId, resumed[0]);
			}
			return resumed;
		});
		const readableDocument = <A, E>(
			effectId: EffectIdType,
			subject: Identity.Subject,
			conversationId: string,
			operation: Effect.Effect<A, E>
		) =>
			requireReadableConversation(
				EffectId.make(`${effectId}:authorize`),
				subject,
				conversationId
			).pipe(Effect.andThen(operation));
		service = Service.of({
			open: Effect.fn('Agents.open')(openConversation),
			attachFile: Effect.fn('Agents.attachFile')((effectId, subject, conversationId, file) =>
				readableDocument(
					effectId,
					subject,
					conversationId,
					documents.attach(effectId, conversationId, file)
				)
			),
			readMedia: Effect.fn('Agents.readMedia')((effectId, subject, conversationId, storageKey) =>
				readableDocument(
					effectId,
					subject,
					conversationId,
					documents.media(effectId, conversationId, storageKey)
				)
			),
			removeFile: Effect.fn('Agents.removeFile')((effectId, subject, conversationId, storageKey) =>
				readableDocument(
					effectId,
					subject,
					conversationId,
					documents.remove(effectId, conversationId, storageKey)
				)
			),
			enqueue: Effect.fn('Agents.enqueue')(
				function* (
					effectId,
					subject,
					agentName,
					conversationId,
					turnId,
					message,
					model,
					surface,
					mode,
					source,
					intent,
					verifierPrompt
				) {
					const admitted = yield* admitTurn(
						effectId,
						subject,
						agentName,
						conversationId,
						turnId,
						message,
						{
							...(model === undefined ? {} : { model }),
							...(mode === undefined ? {} : { mode }),
							...(source === undefined ? {} : { source }),
							...(intent === undefined ? {} : { intent }),
							...(verifierPrompt === undefined ? {} : { verifierPrompt })
						}
					);
					if (admitted.status !== 'running' || admitted.runId === undefined) return admitted;
					const result = yield* drainLane(
						EffectId.make(`${effectId}:run`),
						conversationId,
						admitted.runId,
						surface
					);
					return { ...admitted, status: result.status, output: result.output };
				}
			),
			execute: Effect.fn('Agents.execute')(function* (
				effectId,
				conversationId,
				runId,
				surface?: AgentSurface
			) {
				const storedResult = yield* database.execute(
					EffectId.make(`${effectId}:run:claim-driver`),
					{
						_tag: 'Query',
						sql: `with locked_lane as (
							select lane.* from "agent_lane" lane
							where lane."conversation_id" = $1 for update
						), claimed_run as (
							update "agent_run" run set "driver_epoch" = run."driver_epoch" + 1,
								"updated_at" = now(),
								"row_version" = run."row_version" + 1
							from locked_lane lane
							where run."run_id" = $2 and run."conversation_id" = $1
								and run."status" = 'running' and lane."state" = 'active'
								and lane."active_run_id" = run."run_id"
								and lane."active_generation" = run."generation"
							returning run.*
						), selected as (
							select true as "claimed", run.* from claimed_run run
							union all
							select false as "claimed", run.* from "agent_run" run
							where run."run_id" = $2 and run."conversation_id" = $1
								and not exists (select 1 from claimed_run)
						)
						select selected."claimed", selected."run_id", selected."conversation_id",
							selected."generation", selected."status", selected."driver_epoch",
							selected."input_boundary", selected."subject_snapshot",
							selected."resolved_model", selected."authority_fingerprint",
							selected."agent_release_id", selected."depth", selected."usage",
							selected."usage_unreported", selected."sandbox_key", session."agent_name",
							session."verifier"
						from selected join "chat_session" session
							on session."conversation_id" = selected."conversation_id"`,
						parameters: [conversationId, runId]
					}
				);
				const decoded = decodeRunExecutionRow(storedResult.rows[0]);
				if (decoded._tag === 'None') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'run does not exist'
					});
				}
				const stored = decoded.value;
				if (stored.status !== 'running' || !stored.claimed) {
					return {
						conversationId,
						output: null,
						status: stored.status === 'completed' ? 'completed' : 'failed'
					};
				}
				const subject = stored.subject_snapshot;
				const agent = yield* resolveAgent(stored.agent_name);
				yield* access.authorize(subject, 'agent', stored.agent_name);
				const transcript = yield* database.execute(EffectId.make(`${effectId}:transcript`), {
					_tag: 'Query',
					sql: `${canonicalTranscriptSelect}
							where message."conversation_id" = $1
							and (message."sequence" <= $2 or message."run_id" = $3)
						group by message."id" order by message."sequence"`,
					parameters: [conversationId, stored.input_boundary, runId]
				});
				const observed: Array<ModelMessage> = [];
				let committed = 0;
				const checkpoint = (
					_status: 'running' | 'failed',
					usage: AIUsage | undefined,
					usageUnreported: boolean
				) =>
					Effect.gen(function* () {
						const sequence = (committed += 1);
						const result = yield* database.execute(
							EffectId.make(`${effectId}:checkpoint:${sequence}`),
							{
								_tag: 'Query',
								sql: `update "agent_run" set "usage" = $5::jsonb, "usage_unreported" = $6,
									"updated_at" = now(), "row_version" = "row_version" + 1
								where "run_id" = $1 and "generation" = $2 and "driver_epoch" = $3
									and "status" = 'running' and "conversation_id" = $4
								returning 'agent_run'::text as "collection", "id"::text as "record_id"`,
								parameters: [
									runId,
									stored.generation,
									stored.driver_epoch,
									conversationId,
									usage === undefined ? null : JSON.stringify(usage),
									usageUnreported
								]
							}
						);
						yield* publishRows(
							EffectId.make(`${effectId}:publish:${sequence}`),
							result.rows,
							conversationId
						);
						return result;
					});
				const commit: CommitRun =
					surface === undefined
						? checkpoint
						: (status, usage, usageUnreported) =>
								Effect.gen(function* () {
									const result = yield* checkpoint(status, usage, usageUnreported);
									yield* Effect.catch(surface.observe(observed), () => Effect.void);
									return result;
								});
				const model = stored.resolved_model;
				yield* commit('running', stored.usage ?? undefined, stored.usage_unreported);
				const prompt = canonicalPrompt(transcript.rows);
				const messageMetadata = new Map<string, AppMessageMetadata>();
				for (const row of transcript.rows) {
					const decodedRow = decodeCanonicalTranscriptRow(row);
					if (decodedRow._tag === 'None') continue;
					const metadata = appMetadataFromStorage(decodedRow.value);
					if (metadata !== undefined) {
						messageMetadata.set(decodedRow.value.message_id, metadata);
					}
				}
				const storedIntent = [...messageMetadata.values()].findLast(
					(metadata) => metadata.kind === 'input'
				)?.intent;
				const intent =
					storedIntent === 'plan' || storedIntent === 'compact' ? storedIntent : ('do' as const);
				const verifierPrompt = decodeVerifierConfig(stored.verifier).pipe(
					Option.map(({ prompt }) => prompt),
					Option.getOrUndefined
				);
				const fence: RunFence = {
					runId,
					generation: stored.generation,
					driverEpoch: stored.driver_epoch
				};
				const attempted = yield* Effect.result(
					runTanStackLoop(
						effectId,
						agent,
						subject,
						stored.depth,
						conversationId,
						stored.sandbox_key,
						fence,
						model,
						prompt,
						[
							workspace.definition.prompt,
							...(agent.task === undefined ? [] : [agent.task]),
							...(verifierPrompt === undefined
								? []
								: [`Task completion contract:\n${verifierPrompt}`])
						],
						messageMetadata,
						intent,
						verifierPrompt,
						stored.authority_fingerprint,
						stored.agent_release_id,
						toolsFor(subject, agent),
						observed,
						stored.usage ?? undefined,
						stored.usage_unreported,
						commit
					)
				);
				const settled = Result.isSuccess(attempted)
					? attempted.success
					: {
							output: null as Schema.Json,
							cumulative: undefined,
							segment: undefined,
							unreported: true,
							goalExhausted: false,
							goalVerdict: undefined
						};
				const settlement = yield* database.execute(EffectId.make(`${effectId}:settle`), {
					_tag: 'Query',
					sql: `with recursive locked_lane as (select lane.* from "agent_lane" lane
							where lane."conversation_id" = $1 for update), settled as (
							update "agent_run" run set "status" = case when lane."state" = 'stopped' then 'aborted'
								when lane."requested_generation" > lane."active_generation" then 'aborted'
								when $7 then 'failed' else 'completed' end,
								"disposition" = case when lane."state" = 'stopped' then 'stopped'
								when lane."requested_generation" > lane."active_generation" then 'superseded' else null end,
								"finished_at" = floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
								"usage" = coalesce($5::jsonb, run."usage"), "usage_unreported" = case when $5::jsonb is null
								then run."usage_unreported" or $6 else $6 end,
								"error" = case when $7 then $8::jsonb else null end,
								"updated_at" = now(), "row_version" = run."row_version" + 1
							from locked_lane lane where run."run_id" = $2 and run."generation" = $3 and run."driver_epoch" = $4
								and run."status" = 'running' and lane."active_run_id" = run."run_id"
							returning run.*
						), lineage as (
							select session."conversation_id", session."parent_id" from "chat_session" session where session."conversation_id" = $1
							union all select parent."conversation_id", parent."parent_id" from "chat_session" parent
							join lineage child on parent."conversation_id" = child."parent_id"
						), accounted as (
						update "chat_session" session set
							"usage_cost_usd" = session."usage_cost_usd" + coalesce((run."usage"->>'costUsd')::double precision, 0),
							"usage_cost_micro_units" = session."usage_cost_micro_units" + case
								when run."usage"->>'costMicroUnits' is null then 0
								when run."usage"->>'costCurrency' is not null and (session."usage_cost_currency" is null
									or session."usage_cost_currency" = run."usage"->>'costCurrency')
								then (run."usage"->>'costMicroUnits')::bigint
								else 1 / ((random() * 0)::bigint) end,
							"usage_cost_currency" = case when run."usage"->>'costMicroUnits' is null
								then session."usage_cost_currency"
								else coalesce(run."usage"->>'costCurrency', session."usage_cost_currency") end,
							"usage_total_tokens" = session."usage_total_tokens" + coalesce((run."usage"->>'totalTokens')::bigint, 0),
								"usage_turns_counted" = session."usage_turns_counted" + 1, "usage_turns_unreported" =
									session."usage_turns_unreported" + case when run."usage_unreported" then 1 else 0 end,
								"updated_at" = now(), "row_version" = session."row_version" + 1
							from settled run where session."conversation_id" in (select "conversation_id" from lineage)
							returning session."id"
						), phase as (select lane.*, case when lane."requested_generation" > lane."active_generation"
							then 'steer' else 'input' end as cause from locked_lane lane cross join settled
							where lane."state" = 'active'), ${claimPendingCtes}, advanced as (
					update "agent_lane" lane set "active_run_id" = run."run_id",
						"active_generation" = coalesce(run."generation", lane."active_generation"),
						"requested_generation" = case
								when run."run_id" is null then case when lane."state" = 'active' then lane."active_generation"
									else lane."requested_generation" end
								when (select cause from phase) = 'steer' and exists (
									select 1 from "agent_inbox" pending where pending."conversation_id" = $1
										and pending."state" = 'pending' and pending."requested_mode" = 'steer'
									and pending."id" not in (select "id" from candidates)
							) then run."generation" + 1 else run."generation" end,
							"resume_from_run_id" = case when lane."state" = 'stopped' then $2 else null end,
							"updated_at" = now(), "row_version" = lane."row_version" + 1
						from settled left join next_run run on true
						where lane."conversation_id" = $1 returning lane."id"
					)
						select settled."status" as "settled_status", null::text as "collection", null::text as "record_id"
						from settled left join advanced on true
						union all select null, 'chat_session', accounted."id"::text from accounted
						union all select null, 'agent_run', settled."id"::text from settled
						union all select null, 'agent_run', run."id"::text from next_run run
						union all select null, 'agent_inbox', claimed."id"::text from claimed
						union all select null, 'agent_lane', advanced."id"::text from advanced`,
					parameters: [
						conversationId,
						runId,
						stored.generation,
						stored.driver_epoch,
						settled.cumulative === undefined ? null : JSON.stringify(settled.cumulative),
						settled.unreported,
						Result.isFailure(attempted),
						Result.isFailure(attempted)
							? JSON.stringify({ message: Workspace.describeCause(attempted.failure) })
							: null
					]
				});
				const outcome = decodeSettlementResultRow(settlement.rows[0]);
				const runCompleted =
					outcome._tag === 'Some' && outcome.value.settled_status === 'completed';
				const goalContinues = settled.goalVerdict?.achieved === false && !settled.goalExhausted;
				const taskStatus =
					runCompleted && settled.goalExhausted
						? ('needs_attention' as const)
						: runCompleted
							? ('completed' as const)
							: ('failed' as const);
				yield* publishRows(
					EffectId.make(`${effectId}:settled-publish`),
					settlement.rows,
					conversationId
				);
				if (taskStatus === 'completed' && !goalContinues && surface?.complete !== undefined) {
					yield* Effect.catch(surface.complete(settled.output), () => Effect.void);
				}
				return {
					conversationId,
					output: settled.output,
					status: taskStatus
				};
			}),
			stop: Effect.fn('Agents.stop')(function* (effectId, subject, conversationId) {
				yield* requireControllableConversation(
					EffectId.make(`${effectId}:authorize`),
					subject,
					conversationId
				);
				yield* stopConversation(effectId, conversationId);
			}),
			resume: Effect.fn('Agents.resume')(resumeConversation),
			running: Effect.fn('Agents.running')(function* (effectId, conversationId) {
				return (yield* runningRunIds(effectId, conversationId)).length > 0;
			}),
			updateVerifier: Effect.fn('Agents.updateVerifier')(
				function* (effectId, conversationId, verifier) {
					yield* executeBuilt(
						effectId,
						database,
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
