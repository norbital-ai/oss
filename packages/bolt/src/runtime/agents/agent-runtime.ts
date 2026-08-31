import {
	EventType,
	defineRunStore,
	isRunStatus,
	type AdapterYieldChunk,
	type ChatMiddleware,
	type ChatMiddlewareConfig,
	type JSONSchema,
	type ModelMessage,
	type TextAdapter,
	type TextOptions,
	type RunRecord,
	type RunStore,
	type TokenUsage
} from '@tanstack/ai';
import { Effect, Option, Schema } from 'effect';
import { AIUsage, ChatDocumentRef, EffectId, type SyncChange } from '@norbital-ai/bolt-protocol';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { ToolNotAllowed } from '#lib/runtime/agents/agent-errors.js';
import type { AIInterface } from '#lib/runtime/facilities/services.js';
import type * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';
export type AgentProviderOptions = Readonly<{
	readonly maxOutputTokens?: number;
	readonly webSearch?: Readonly<{
		readonly maxResults: number;
		readonly allowedDomains?: ReadonlyArray<string>;
	}>;
}>;
type AgentTextAdapter = TextAdapter<
	string,
	AgentProviderOptions,
	readonly ['text', 'image', 'audio', 'video', 'document'],
	{
		readonly text: unknown;
		readonly image: unknown;
		readonly audio: unknown;
		readonly video: unknown;
		readonly document: unknown;
	},
	readonly []
>;
export type AppMessageMetadata = Readonly<{
	readonly version: 1;
	readonly kind?: 'input' | 'summary' | 'goal' | 'usage' | 'verifier';
	readonly fold?: 'compact' | 'plan';
	readonly intent?: 'do' | 'plan' | 'compact';
	readonly visibility?: 'model' | 'transcript-only';
}> &
	Readonly<Record<string, unknown>>;
export type CanonicalMessageStorageEnvelope = Readonly<{
	readonly conversationId: string;
	readonly runId?: string;
	readonly iterationIndex?: number;
	readonly appMetadata?: Schema.Json;
}>;
type CanonicalFieldRow = Readonly<{
	readonly field: 'content' | 'toolCalls' | 'thinking' | 'structuredOutput';
	readonly ordinal: number;
	readonly payload: Schema.Json;
}>;
const canonicalJson = (value: unknown): string => {
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `{${Object.keys(value)
			.toSorted()
			.filter((key) => Reflect.get(value, key) !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};
export const semanticHash = (value: unknown): string => {
	let first = 0x81_1c_9d_c5;
	let second = 0x9e_37_79_b9;
	for (const byte of new TextEncoder().encode(canonicalJson(value))) {
		first = Math.imul(first ^ byte, 0x01_00_01_93);
		second = Math.imul(second ^ byte, 0x5b_d1_e9_95);
	}
	return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
		.toString(16)
		.padStart(8, '0')}`;
};
export const safeJson = (value: unknown): string => {
	const decoded = Schema.decodeUnknownOption(Schema.Json)(value);
	return canonicalJson(decoded._tag === 'Some' ? decoded.value : { error: 'invalid-tool-result' });
};
const messageText = (message: ModelMessage): string =>
	typeof message.content === 'string'
		? message.content
		: Array.isArray(message.content)
			? message.content.flatMap((part) => (part.type === 'text' ? [part.content] : [])).join('\n')
			: '';
export const answerPayload = (message: ModelMessage): Schema.Json => {
	if (message.structuredOutput?.status === 'complete') {
		const decoded = Schema.decodeUnknownOption(Schema.Json)(message.structuredOutput.data);
		if (decoded._tag === 'Some') return decoded.value;
	}
	return { text: messageText(message) };
};
export const storageForModelMessage = (
	message: ModelMessage,
	envelope: CanonicalMessageStorageEnvelope
) => {
	const messageId = message.id ?? globalThis.crypto.randomUUID();
	const content =
		message.content === null
			? { kind: 'null' as const, text: null }
			: typeof message.content === 'string'
				? { kind: 'text' as const, text: message.content }
				: { kind: 'parts' as const, text: null };
	const fields: Array<CanonicalFieldRow> = [];
	const repeated = [
		['content', Array.isArray(message.content) ? message.content : []],
		['toolCalls', message.toolCalls ?? []],
		['thinking', message.thinking ?? []]
	] as const;
	for (const [field, values] of repeated) {
		for (const [ordinal, payload] of values.entries())
			fields.push({ field, ordinal, payload: payload as unknown as Schema.Json });
	}
	if (message.structuredOutput !== undefined)
		fields.push({
			field: 'structuredOutput',
			ordinal: 0,
			payload: message.structuredOutput as unknown as Schema.Json
		});
	const semantic = {
		...message,
		id: messageId,
		createdAt: message.createdAt?.toISOString(),
		appMetadata: envelope.appMetadata
	};
	return {
		message: { ...message, id: messageId } as ModelMessage & Readonly<{ id: string }>,
		fields,
		header: {
			message_id: messageId,
			conversation_id: envelope.conversationId,
			role: message.role,
			name: message.name ?? null,
			run_id: envelope.runId ?? null,
			iteration_index: envelope.iterationIndex ?? null,
			content_kind: content.kind,
			content_text: content.text,
			search_text: messageText(message),
			tool_call_id: message.toolCallId ?? null,
			error: message.error ?? null,
			model_metadata: message.metadata === undefined ? null : JSON.stringify(message.metadata),
			app_metadata:
				envelope.appMetadata === undefined ? null : JSON.stringify(envelope.appMetadata),
			semantic_hash: semanticHash(semantic)
		}
	};
};
const planningToolNames = new Set([
	'describe_workspace',
	'list_skills',
	'read_skill',
	'search_envoy_history',
	'load_media',
	'read_collection',
	'list_agents',
	'read_agent'
]);
const keySegment = (value: string): string => {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const extensionOf = (fileName: string): string => {
	const candidate = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : '';
	return /^[a-z0-9]{1,12}$/i.test(candidate) ? `.${candidate.toLowerCase()}` : '';
};
export const chatDocumentStorageKey = (
	conversationId: string,
	documentId: string,
	fileName: string
): string =>
	[
		'chat-sessions',
		keySegment(conversationId),
		`${keySegment(documentId)}${extensionOf(fileName)}`
	].join('/');
export const isChatDocumentStorageKey = (conversationId: string, storageKey: string): boolean =>
	storageKey.startsWith(`chat-sessions/${keySegment(conversationId)}/`) &&
	!storageKey.includes('..') &&
	storageKey.split('/').length === 3;
export const ChatAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	file: ChatDocumentRef
});
export interface ChatAttachment extends Schema.Schema.Type<typeof ChatAttachment> {}
export const InboundBatchMessage = Schema.Struct({
	sender: Schema.Struct({
		id: Schema.optionalKey(Schema.NonEmptyString),
		displayName: Schema.optionalKey(Schema.NonEmptyString)
	}),
	sentAt: Schema.NonEmptyString,
	messageId: Schema.NonEmptyString,
	text: Schema.String,
	attachments: Schema.Array(ChatAttachment),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient'])
});
export interface InboundBatchMessage extends Schema.Schema.Type<typeof InboundBatchMessage> {}
export const DelegatedMessage = Schema.Struct({
	from: Schema.Struct({
		agentId: Schema.String,
		agentName: Schema.String,
		title: Schema.NullOr(Schema.String)
	}),
	text: Schema.String
});
export interface DelegatedMessage extends Schema.Schema.Type<typeof DelegatedMessage> {}
export const claimPendingCtes = `first_candidate as (
	select inbox.* from "agent_inbox" inbox cross join phase
	where inbox."conversation_id" = $1 and inbox."state" = 'pending' and
		(phase.cause = 'input' or inbox."requested_mode" = 'steer')
	order by inbox."receipt_sequence" limit 1 for update of inbox
), candidates as (
	select inbox.* from "agent_inbox" inbox join first_candidate first on
		inbox."conversation_id" = first."conversation_id" cross join phase
	where inbox."state" = 'pending' and inbox."authority_fingerprint" = first."authority_fingerprint"
		and inbox."agent_release_id" = first."agent_release_id" and inbox."resolved_model" = first."resolved_model"
		and inbox."depth" = first."depth"
		and (inbox."source_kind" = first."source_kind" or inbox."source_kind" = 'goal') and (
			(phase.cause = 'input' and not exists (
				select 1 from "agent_inbox" prior where prior."conversation_id" = inbox."conversation_id"
					and prior."state" = 'pending' and prior."receipt_sequence" < inbox."receipt_sequence"
					and (prior."authority_fingerprint" <> first."authority_fingerprint"
						or prior."agent_release_id" <> first."agent_release_id" or prior."resolved_model" <> first."resolved_model"
						or prior."depth" <> first."depth"
						or prior."source_kind" not in (first."source_kind", 'goal'))
			)) or (phase.cause = 'steer' and (inbox."requested_mode" = 'steer'
				or inbox."receipt_sequence" < first."receipt_sequence"))
		) for update of inbox
), next_run as (
	insert into "agent_run" (
		"run_id", "conversation_id", "generation", "status", "started_at", "cause", "input_boundary",
		"subject_snapshot", "authority_fingerprint", "agent_release_id",
		"resolved_model", "depth", "sandbox_key"
	)
	select 'run:' || first."id"::text, $1, case when phase.cause = 'steer' then phase."requested_generation"
			else greatest(phase."active_generation", phase."requested_generation") + 1 end,
		'running', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
		case when phase.cause = 'steer' then 'steer'
			when first."source_kind" = 'goal' then 'goal' else 'input' end,
		(select max("receipt_sequence") from candidates), first."subject_snapshot", first."authority_fingerprint",
		first."agent_release_id", first."resolved_model",
		first."depth", session."sandbox_key"
	from first_candidate first cross join phase
	join "chat_session" session on session."conversation_id" = $1 returning *
), claimed as (
	update "agent_inbox" inbox set "state" = 'claimed', "claimed_by_run_id" = run."run_id",
		"claimed_at" = now(), "updated_at" = now(), "row_version" = inbox."row_version" + 1
	from next_run run where inbox."id" in (select "id" from candidates) returning inbox."id"
)`;
export const canonicalTranscriptSelect = `select message."sequence", message."message_id", message."role",
	message."name", message."run_id", message."iteration_index", message."content_kind",
	message."content_text", message."tool_call_id", message."error", message."model_metadata",
	message."app_metadata", coalesce(jsonb_agg(jsonb_build_object(
		'field', part."field", 'ordinal', part."ordinal", 'payload', part."payload"
	) order by part."field", part."ordinal") filter (where part."id" is not null), '[]'::jsonb) as "fields"
from "chat_message" message left join "chat_message_part" part
	on part."message_id" = message."message_id"`;
export const resolveTool = (
	offered: ReadonlyArray<ToolDeclaration>,
	agentName: string,
	name: string
): ToolDeclaration | ToolNotAllowed =>
	offered.find((tool) => tool.name === name) ??
	new ToolNotAllowed({ agent: agentName, tool: name });
export const mcpToolName = (server: string, tool: string): string =>
	`${server.replaceAll(':', '_')}:${tool.replaceAll(':', '_')}`;
export const parseMcpToolName = (
	name: string
): { readonly server: string; readonly tool: string } | undefined => {
	const separator = name.indexOf(':');
	return separator < 1 || separator === name.length - 1
		? undefined
		: { server: name.slice(0, separator), tool: name.slice(separator + 1) };
};
export const SandboxSpawnActionInput = Schema.Struct({
	task: Schema.NonEmptyString,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
});
export const SandboxAdmitActionInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	agentName: Schema.NonEmptyString,
	message: DelegatedMessage,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	mode: Schema.optionalKey(Schema.Literals(['queue', 'steer']))
});
export const SandboxTaskActionInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
export const SandboxAgentActionInput = Schema.Struct({ agentId: Schema.NonEmptyString });
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
export const decodeAgentModelCatalog = Schema.decodeUnknownOption(AgentModelCatalog);
export type AgentModelDescriptor = Readonly<{
	readonly id: string;
	readonly contextTokens: number;
}>;
const NullableString = Schema.Union([Schema.String, Schema.Null]);
const ConversationVisibility = Schema.Literals(['personal', 'envoy_dm', 'envoy_group']);
const StoredConversationRow = Schema.Struct({
	conversation_id: Schema.String,
	agent_name: Schema.String,
	title: NullableString,
	user_id: Schema.String,
	sandbox_key: Schema.String,
	visibility: ConversationVisibility,
	envoy_key: NullableString
});
const decodeStoredConversationRow = Schema.decodeUnknownOption(StoredConversationRow);
export type AuthorizedConversation = Omit<
	Schema.Schema.Type<typeof StoredConversationRow>,
	'conversation_id'
> &
	Readonly<{ readonly id: string }>;
export const conversationRow = (row: unknown): AuthorizedConversation | undefined => {
	const decoded = decodeStoredConversationRow(row);
	if (decoded._tag === 'None') return undefined;
	const { conversation_id: id, ...fields } = decoded.value;
	return { id, ...fields };
};
const TaskIdRow = Schema.Struct({ task_id: Schema.NonEmptyString });
const decodeTaskIdRow = Schema.decodeUnknownOption(TaskIdRow);
export const taskIds = (rows: ReadonlyArray<unknown>): Array<string> =>
	rows.flatMap((row) => {
		const decoded = decodeTaskIdRow(row);
		return decoded._tag === 'Some' ? [decoded.value.task_id] : [];
	});
const AdmissionResultRow = Schema.Struct({
	message_id: Schema.NonEmptyString,
	claimed_by_run_id: NullableString
});
export const decodeAdmissionResultRow = Schema.decodeUnknownOption(AdmissionResultRow);
export const GoalVerdict = Schema.Struct({
	achieved: Schema.Boolean,
	summary: Schema.NonEmptyString,
	gaps: Schema.Array(Schema.String)
});
export type GoalVerdict = Schema.Schema.Type<typeof GoalVerdict>;
export const goalVerdictJsonSchema: JSONSchema = {
	type: 'object',
	properties: {
		achieved: { type: 'boolean' },
		summary: { type: 'string', minLength: 1 },
		gaps: { type: 'array', items: { type: 'string' } }
	},
	required: ['achieved', 'summary', 'gaps'],
	additionalProperties: false
};
const VerifierConfig = Schema.Struct({ prompt: Schema.NonEmptyString });
export const decodeVerifierConfig = Schema.decodeUnknownOption(VerifierConfig);
const RunExecutionRow = Schema.Struct({
	claimed: Schema.Boolean,
	run_id: Schema.NonEmptyString,
	conversation_id: Schema.NonEmptyString,
	generation: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	status: Schema.Literals(['running', 'interrupted', 'completed', 'failed', 'aborted']),
	driver_epoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	input_boundary: Schema.Union([Schema.Number, Schema.NumberFromString]),
	subject_snapshot: Identity.Subject,
	resolved_model: Schema.Struct({
		id: Schema.NonEmptyString,
		contextTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
	}),
	authority_fingerprint: Schema.NonEmptyString,
	agent_release_id: Schema.NonEmptyString,
	depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	usage: Schema.NullOr(AIUsage),
	usage_unreported: Schema.Boolean,
	agent_name: Schema.NonEmptyString,
	sandbox_key: Schema.NonEmptyString,
	verifier: Schema.Json
});
export const decodeRunExecutionRow = Schema.decodeUnknownOption(RunExecutionRow);
export const decodeAwaitRunRow = Schema.decodeUnknownOption(
	Schema.Struct({
		run_id: Schema.NonEmptyString,
		status: RunExecutionRow.fields.status
	})
);
const RunBoundaryRow = Schema.Struct({
	decision: Schema.Literals(['continue', 'steer', 'stopped', 'stale'])
});
export const decodeRunBoundaryRow = Schema.decodeUnknownOption(RunBoundaryRow);
const CanonicalTranscriptRow = Schema.Struct({
	sequence: Schema.Union([Schema.Number, Schema.NumberFromString]),
	message_id: Schema.NonEmptyString,
	role: Schema.Literals(['user', 'assistant', 'tool']),
	name: NullableString,
	run_id: NullableString,
	iteration_index: Schema.NullOr(Schema.Number),
	content_kind: Schema.Literals(['null', 'text', 'parts']),
	content_text: NullableString,
	tool_call_id: NullableString,
	error: NullableString,
	model_metadata: Schema.Json,
	app_metadata: Schema.Json,
	fields: Schema.Array(
		Schema.Struct({
			field: Schema.Literals(['content', 'toolCalls', 'thinking', 'structuredOutput']),
			ordinal: Schema.Number,
			payload: Schema.Json
		})
	)
});
export const decodeCanonicalTranscriptRow = Schema.decodeUnknownOption(CanonicalTranscriptRow);
type CanonicalTranscript = Schema.Schema.Type<typeof CanonicalTranscriptRow>;
const modelMessageFromStorage = (stored: CanonicalTranscript): ModelMessage => {
	const field = (name: CanonicalTranscript['fields'][number]['field']) =>
		stored.fields.filter((part) => part.field === name).map(({ payload }) => payload);
	const content =
		stored.content_kind === 'null'
			? null
			: stored.content_kind === 'text'
				? (stored.content_text ?? '')
				: field('content');
	const toolCalls = field('toolCalls');
	const thinking = field('thinking');
	const structuredOutput = field('structuredOutput')[0];
	return {
		id: stored.message_id,
		role: stored.role,
		content,
		...(stored.name === null ? {} : { name: stored.name }),
		...(stored.tool_call_id === null ? {} : { toolCallId: stored.tool_call_id }),
		...(stored.error === null ? {} : { error: stored.error }),
		...(stored.model_metadata === null ? {} : { metadata: stored.model_metadata }),
		...(toolCalls.length === 0 ? {} : { toolCalls }),
		...(thinking.length === 0 ? {} : { thinking }),
		...(structuredOutput === undefined ? {} : { structuredOutput })
	} as unknown as ModelMessage;
};
export const appMetadataFromStorage = (
	stored: CanonicalTranscript
): AppMessageMetadata | undefined =>
	stored.app_metadata !== null &&
	typeof stored.app_metadata === 'object' &&
	!Array.isArray(stored.app_metadata) &&
	Reflect.get(stored.app_metadata, 'version') === 1
		? (stored.app_metadata as AppMessageMetadata)
		: undefined;
export const canonicalPrompt = (rows: ReadonlyArray<unknown>): Array<ModelMessage> =>
	rows.flatMap((row) => {
		const stored = decodeCanonicalTranscriptRow(row);
		return stored._tag === 'Some' ? [modelMessageFromStorage(stored.value)] : [];
	});
const SettlementResultRow = Schema.Struct({
	settled_status: Schema.Literals(['completed', 'failed', 'aborted'])
});
export const decodeSettlementResultRow = Schema.decodeUnknownOption(SettlementResultRow);
const CommittedChatRow = Schema.Struct({
	collection: Schema.Literals([
		'chat_session',
		'chat_message',
		'chat_message_part',
		'agent_run',
		'agent_lane',
		'agent_inbox'
	]),
	record_id: Schema.NonEmptyString
});
const decodeCommittedChatRow = Schema.decodeUnknownOption(CommittedChatRow);
export const committedChatChanges = (
	rows: ReadonlyArray<unknown>,
	conversationId: string
): ReadonlyArray<SyncChange> =>
	rows.flatMap((row) => {
		const coordinate = decodeCommittedChatRow(row).pipe(
			Option.map(({ collection, record_id }) => ({ collection, recordId: record_id }))
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
export type AgentInput = Readonly<{
	readonly message: ModelMessage;
	readonly title: string;
	readonly attribution?: Readonly<{
		readonly inbound?: ReadonlyArray<InboundBatchMessage>;
		readonly delegated?: DelegatedMessage;
	}>;
}>;
export const userAgentInput = (text: string): AgentInput => ({
	message: { role: 'user', content: text },
	title: text
});
export const inboundAgentInput = (messages: ReadonlyArray<InboundBatchMessage>): AgentInput => ({
	message: {
		role: 'user',
		content: [
			'INBOUND BATCH',
			...messages.flatMap((message) => {
				const sender = message.sender.displayName ?? message.sender.id ?? 'unidentified sender';
				const address =
					message.sender.id === undefined || message.sender.id === sender
						? ''
						: ` (${message.sender.id})`;
				return [
					`[${message.sentAt}] ${sender}${address} · ${message.invocation} · ${message.messageId}`,
					...(message.text.length === 0 ? [] : [message.text]),
					...message.attachments.map(
						({ provider, attachmentId, file }) =>
							`[document ${file.file_name} · ${file.mime_type} · ${file.file_size} bytes] provider=${provider} attachment=${attachmentId}`
					)
				];
			})
		].join('\n')
	},
	title: messages
		.map(({ text }) => text.trim())
		.filter(Boolean)
		.join(' · '),
	attribution: { inbound: messages }
});
export const delegatedAgentInput = (message: DelegatedMessage): AgentInput => {
	const { agentName, title, agentId } = message.from;
	const label = title === null || title.trim().length === 0 ? agentName : `${agentName} · ${title}`;
	return {
		message: {
			role: 'user',
			content: `[message from agent ${label} (${agentId})]\n${message.text}`
		},
		title: message.text,
		attribution: { delegated: message }
	};
};
export type AgentRunSeed = Readonly<{
	readonly generation: number;
	readonly cause: 'input' | 'steer' | 'resume';
	readonly inputBoundary: number;
	readonly subjectSnapshot: Schema.Json;
	readonly authorityFingerprint: string;
	readonly agentReleaseId: string;
	readonly resolvedModel: Schema.Json;
	readonly depth: number;
	readonly sandboxKey?: string;
}>;
const runJson = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
};
const storedRun = (value: unknown): RunRecord | null => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	const row = value as Readonly<Record<string, unknown>>;
	if (
		typeof row.run_id !== 'string' ||
		typeof row.conversation_id !== 'string' ||
		!isRunStatus(row.status) ||
		typeof row.started_at !== 'number'
	)
		return null;
	const error = runJson(row.error);
	const usage = runJson(row.usage);
	return {
		runId: row.run_id,
		threadId: row.conversation_id,
		status: row.status,
		startedAt: row.started_at,
		...(typeof row.finished_at === 'number' ? { finishedAt: row.finished_at } : {}),
		...(error !== null && typeof error === 'object' && !Array.isArray(error)
			? { error: error as NonNullable<RunRecord['error']> }
			: {}),
		...(usage !== null && typeof usage === 'object' && !Array.isArray(usage)
			? { usage: usage as TokenUsage }
			: {}),
		...(typeof row.sandbox_key === 'string' ? { sandboxKey: row.sandbox_key } : {}),
		...(typeof row.cancel_requested === 'boolean' ? { cancelRequested: row.cancel_requested } : {}),
		...(typeof row.driver_epoch === 'number' ? { driverEpoch: row.driver_epoch } : {})
	};
};
export const AgentRunStore = (
	database: Database.Interface,
	namespace: EffectId,
	seedFor: (input: {
		readonly runId: string;
		readonly threadId: string;
		readonly startedAt: number;
	}) => AgentRunSeed
): RunStore => {
	let operation = 0;
	const query = async (sql: string, parameters: ReadonlyArray<Schema.Json> = []) =>
		Effect.runPromise(
			database.execute(EffectId.make(`${namespace}:run-store:${operation++}`), {
				_tag: 'Query',
				sql,
				parameters
			})
		);
	const get = async (runId: string): Promise<RunRecord | null> => {
		const result = await query('select * from "agent_run" where "run_id" = $1 limit 1', [runId]);
		return storedRun(result.rows[0]);
	};
	const list = async (sql: string, parameters: ReadonlyArray<Schema.Json>) => {
		const result = await query(sql, parameters);
		return result.rows.flatMap((row) => {
			const decoded = storedRun(row);
			return decoded === null ? [] : [decoded];
		});
	};
	return defineRunStore({
		createOrResume: async (input) => {
			const existing = await get(input.runId);
			if (existing !== null) return existing;
			const seed = seedFor(input);
			await query(
				`insert into "agent_run" ("run_id", "conversation_id", "generation", "status",
					"started_at", "sandbox_key", "driver_epoch", "cause", "input_boundary",
					"subject_snapshot", "authority_fingerprint", "agent_release_id", "resolved_model", "depth")
				 values ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13)
				 on conflict ("run_id") do nothing`,
				[
					input.runId,
					input.threadId,
					seed.generation,
					input.status ?? 'running',
					input.startedAt,
					seed.sandboxKey ?? null,
					seed.cause,
					seed.inputBoundary,
					JSON.stringify(seed.subjectSnapshot),
					seed.authorityFingerprint,
					seed.agentReleaseId,
					JSON.stringify(seed.resolvedModel),
					seed.depth
				]
			);
			const created = await get(input.runId);
			if (created === null) throw new Error(`AgentRunStore could not create ${input.runId}`);
			return created;
		},
		update: async (runId, patch) => {
			const columns: Array<string> = [];
			const values: Array<Schema.Json> = [];
			const set = (column: string, value: Schema.Json, cast = '') => {
				values.push(value);
				columns.push(`"${column}" = $${values.length + 1}${cast}`);
			};
			if (Object.hasOwn(patch, 'status')) set('status', patch.status ?? null);
			if (Object.hasOwn(patch, 'finishedAt')) set('finished_at', patch.finishedAt ?? null);
			if (Object.hasOwn(patch, 'error'))
				set('error', patch.error === undefined ? null : JSON.stringify(patch.error), '::jsonb');
			if (Object.hasOwn(patch, 'usage'))
				set('usage', patch.usage === undefined ? null : JSON.stringify(patch.usage), '::jsonb');
			if (Object.hasOwn(patch, 'sandboxKey')) set('sandbox_key', patch.sandboxKey ?? null);
			if (Object.hasOwn(patch, 'cancelRequested'))
				set('cancel_requested', patch.cancelRequested ?? false);
			if (Object.hasOwn(patch, 'driverEpoch')) set('driver_epoch', patch.driverEpoch ?? 0);
			if (columns.length === 0) return;
			await query(
				`update "agent_run" set ${columns.join(', ')}, "updated_at" = now(),
					"row_version" = "row_version" + 1 where "run_id" = $1`,
				[runId, ...values]
			);
		},
		get,
		listByThread: (threadId) =>
			list('select * from "agent_run" where "conversation_id" = $1 order by "started_at" asc', [
				threadId
			]),
		findActiveRun: async (threadId) =>
			(
				await list(
					`select * from "agent_run" where "conversation_id" = $1 and "status" = 'running'
					 order by "started_at" desc limit 1`,
					[threadId]
				)
			)[0] ?? null
	});
};
const compactToolResult = (message: ModelMessage, age: number): ModelMessage => {
	if (message.role !== 'tool' || typeof message.content !== 'string') return message;
	const limit = age >= 0.5 ? 50_000 : age >= 0.3 ? 4_000 : Number.POSITIVE_INFINITY;
	if (message.content.length <= limit) return message;
	return {
		...message,
		content:
			age >= 0.5
				? JSON.stringify({
						cleared: true,
						originalCharacters: message.content.length,
						reason: 'outside recent prompt window'
					})
				: `${message.content.slice(0, 1_500)}\n… ${message.content.length - 3_000} characters trimmed …\n${message.content.slice(-1_500)}`
	};
};
type ContextPolicyOptions = Readonly<{
	contextTokens: number;
	metadata: ReadonlyMap<string, AppMessageMetadata>;
	intent: 'do' | 'plan' | 'compact';
}>;

/** Pure provider projection shared by normal, planning, and goal-verifier calls. */
export const projectAgentContext = (
	options: ContextPolicyOptions,
	config: Pick<ChatMiddlewareConfig, 'messages' | 'systemPrompts' | 'tools'>
): Pick<ChatMiddlewareConfig, 'providerMessages'> &
	Partial<Pick<ChatMiddlewareConfig, 'systemPrompts' | 'tools'>> => {
	const metadataFor = (message: ModelMessage) =>
		message.id === undefined ? undefined : options.metadata.get(message.id);
	const visible = config.messages.filter((message) => {
		const metadata = metadataFor(message);
		return (
			metadata?.visibility !== 'transcript-only' &&
			metadata?.kind !== 'usage' &&
			metadata?.kind !== 'verifier'
		);
	});
	const checkpoint = visible.findLastIndex((message) => metadataFor(message)?.kind === 'summary');
	const checkpointed = checkpoint < 0 ? visible : visible.slice(checkpoint);
	const units: Array<{ messages: Array<ModelMessage>; protected: boolean }> = [];
	for (const message of checkpointed) {
		if (message.role === 'tool' && units.at(-1)?.messages[0]?.role === 'assistant') {
			units.at(-1)!.messages.push(message);
		} else {
			units.push({ messages: [message], protected: false });
		}
	}
	let assistants = 3;
	let user = true;
	for (const unit of units.toReversed()) {
		if (assistants > 0 && unit.messages[0]?.role === 'assistant') {
			unit.protected = true;
			assistants -= 1;
		}
		if (user && unit.messages[0]?.role === 'user') {
			unit.protected = true;
			user = false;
		}
	}
	const denominator = Math.max(units.length - 1, 1);
	for (const [index, unit] of units.entries()) {
		if (!unit.protected)
			unit.messages = unit.messages.map((message) =>
				compactToolResult(message, (units.length - 1 - index) / denominator)
			);
	}
	const tokens = (unit: (typeof units)[number]) =>
		unit.messages.reduce(
			(sum, message) =>
				sum + Math.ceil(new TextEncoder().encode(JSON.stringify(message)).byteLength / 4),
			0
		);
	let estimate = units.reduce((total, unit) => total + tokens(unit), 0);
	const retained = units.map(() => true);
	for (let index = 0; index < units.length && estimate > options.contextTokens * 0.6; index += 1) {
		const unit = units[index]!;
		if (unit.protected) continue;
		retained[index] = false;
		estimate -= tokens(unit);
	}
	const providerMessages = units.flatMap((unit, index) => (retained[index] ? unit.messages : []));
	if (options.intent === 'plan') {
		return {
			providerMessages,
			tools: config.tools.filter((tool) => planningToolNames.has(tool.name)),
			systemPrompts: [
				...config.systemPrompts,
				{
					content:
						'Planning mode is active. Research and reason, but do not make changes. Return a complete, executable plan. This plan becomes the context checkpoint for later agent turns.'
				}
			]
		};
	}
	if (options.intent === 'compact') {
		return {
			providerMessages,
			tools: [],
			systemPrompts: [
				...config.systemPrompts,
				{
					content:
						"Compaction mode is active. Do not perform work or call tools. Produce a concise, durable context summary focused on the person's compaction instruction. Preserve decisions, constraints, unresolved work, and evidence needed by later turns."
				}
			]
		};
	}
	return { providerMessages };
};

export const contextPolicyMiddleware = (options: ContextPolicyOptions): ChatMiddleware => ({
	name: 'norbital-context-policy',
	onConfig: (_context, config) => projectAgentContext(options, config)
});
const jsonRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
const modelMessage = (value: unknown): ModelMessage => {
	const candidate = jsonRecord(value);
	if (candidate === undefined || candidate.role !== 'assistant' || !('content' in candidate)) {
		throw new TypeError('AI facility returned no canonical assistant ModelMessage');
	}
	return candidate as unknown as ModelMessage;
};
const jsonValue = (value: unknown): Schema.Json => {
	let wire: unknown;
	try {
		const encoded = JSON.stringify(value);
		wire = encoded === undefined ? undefined : JSON.parse(encoded);
	} catch {
		throw new TypeError('AI adapter received a non-JSON value');
	}
	const decoded = Schema.decodeUnknownOption(Schema.Json)(wire);
	if (decoded._tag === 'None') throw new TypeError('AI adapter received a non-JSON value');
	return decoded.value;
};
const tokenUsage = (usage: AIUsage | undefined): TokenUsage | undefined => {
	if (usage === undefined) return undefined;
	return {
		promptTokens: usage.inputTokens ?? 0,
		completionTokens: usage.outputTokens ?? 0,
		totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
		...(usage.cachedInputTokens === undefined
			? {}
			: { promptTokensDetails: { cachedTokens: usage.cachedInputTokens } }),
		...(usage.reasoningTokens === undefined
			? {}
			: { completionTokensDetails: { reasoningTokens: usage.reasoningTokens } }),
		...(usage.costUsd === undefined ? {} : { cost: usage.costUsd }),
		providerUsageDetails: {
			norbital: {
				...(usage.costMicroUnits === undefined ? {} : { costMicroUnits: usage.costMicroUnits }),
				...(usage.costCurrency === undefined ? {} : { costCurrency: usage.costCurrency })
			}
		}
	};
};
const toolJson = (tool: NonNullable<TextOptions['tools']>[number]): Schema.Json =>
	jsonValue({
		name: tool.name,
		description: tool.description,
		...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema })
	});
const timestamp = () => Date.now();
const event = (value: AdapterYieldChunk): AdapterYieldChunk => value;
export const facilityTextAdapter = (
	ai: AIInterface,
	model: string,
	namespace: string,
	onUsage?: (usage: AIUsage | undefined) => void | Promise<void>
): AgentTextAdapter => {
	let requestIndex = 0;
	const invoke = async (
		options: TextOptions<AgentProviderOptions>,
		responseSchema?: JSONSchema
	) => {
		const providerOptions = options.modelOptions;
		const response = await Effect.runPromise(
			ai.execute(EffectId.make(`${namespace}:provider:${requestIndex++}`), {
				_tag: 'Turn',
				model,
				messages: [
					...(options.systemPrompts ?? []).map((prompt) =>
						jsonValue({
							role: 'system',
							content: typeof prompt === 'string' ? prompt : prompt.content
						})
					),
					...options.messages.map(jsonValue)
				],
				tools: (options.tools ?? []).map(toolJson),
				maxOutputTokens: providerOptions?.maxOutputTokens ?? 2_048,
				...(providerOptions?.webSearch === undefined
					? {}
					: {
							webSearch: {
								maxResults: providerOptions.webSearch.maxResults,
								...(providerOptions.webSearch.allowedDomains === undefined
									? {}
									: { allowedDomains: [...providerOptions.webSearch.allowedDomains] })
							}
						}),
				...(responseSchema === undefined ? {} : { responseSchema: jsonValue(responseSchema) })
			})
		);
		await onUsage?.(response.usage);
		return response;
	};
	return {
		kind: 'text',
		name: 'colony',
		model,
		'~types': undefined as never,
		chatStream: async function* (options) {
			const response = await invoke(options);
			const message = modelMessage(response.output);
			const messageId = message.id ?? globalThis.crypto.randomUUID();
			const runId = options.runId ?? `${namespace}:run`;
			const threadId = options.threadId ?? options.conversationId ?? `${namespace}:thread`;
			yield event({ type: EventType.RUN_STARTED, runId, threadId, timestamp: timestamp() });
			for (const [index, thinking] of (message.thinking ?? []).entries()) {
				const stepName = `thinking-${index}`;
				yield event({ type: EventType.STEP_STARTED, stepName, timestamp: timestamp() });
				yield event({
					type: EventType.REASONING_MESSAGE_CONTENT,
					messageId,
					delta: thinking.content,
					timestamp: timestamp()
				});
				yield event({
					type: EventType.STEP_FINISHED,
					stepName,
					...(thinking.signature === undefined ? {} : { signature: thinking.signature }),
					timestamp: timestamp()
				});
			}
			yield event({
				type: EventType.TEXT_MESSAGE_START,
				messageId,
				role: 'assistant',
				timestamp: timestamp()
			});
			const content =
				typeof message.content === 'string'
					? message.content
					: message.content === null
						? ''
						: message.content
								.flatMap((part) => (part.type === 'text' ? [part.content] : []))
								.join('');
			if (content !== '') {
				yield event({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId,
					delta: content,
					timestamp: timestamp()
				});
			}
			for (const call of message.toolCalls ?? []) {
				const callMetadata = jsonRecord(call.metadata);
				yield event({
					type: EventType.TOOL_CALL_START,
					toolCallId: call.id,
					toolCallName: call.function.name,
					parentMessageId: messageId,
					...(callMetadata === undefined ? {} : { metadata: callMetadata }),
					timestamp: timestamp()
				});
				yield event({
					type: EventType.TOOL_CALL_ARGS,
					toolCallId: call.id,
					delta: call.function.arguments,
					timestamp: timestamp()
				});
				yield event({
					type: EventType.TOOL_CALL_END,
					toolCallId: call.id,
					timestamp: timestamp()
				});
			}
			yield event({
				type: EventType.TEXT_MESSAGE_END,
				messageId,
				timestamp: timestamp()
			});
			yield event({
				type: EventType.RUN_FINISHED,
				runId,
				threadId,
				finishReason: (message.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
				...(response.usage === undefined ? {} : { usage: tokenUsage(response.usage) }),
				timestamp: timestamp()
			});
		},
		structuredOutput: async ({ chatOptions, outputSchema }) => {
			const response = await invoke(chatOptions, outputSchema);
			const usage = tokenUsage(response.usage);
			return {
				data: response.output,
				rawText: JSON.stringify(response.output),
				...(usage === undefined ? {} : { usage })
			};
		}
	};
};
