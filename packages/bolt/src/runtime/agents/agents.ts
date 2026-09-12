import { Cause, Clock, Context, Effect, ExecutionPlan, Exit, Layer, Schema, Stream } from 'effect';
import { AiError, Prompt, Tool, Toolkit } from 'effect/unstable/ai';
import { EffectId, ReleaseId, type AIMessageProgress } from '@norbital-ai/bolt-protocol';
import { getErrorMessage } from '@norbital-ai/std';
import {
	AgentId,
	HostToolCatalog,
	DirectiveMode,
	DirectivePriority,
	ExactCharge,
	ImageAsset,
	FileAsset,
	MessageId,
	ModelId,
	PlanId,
	type PlanVerdict,
	ProviderCallId,
	type ProviderObservation,
	TurnId,
	RunPhase,
	RunStatus,
	SubjectId,
	ConversationAudience,
	ConversationId,
	ConversationStatus,
	UsageObservation,
	WorkbenchId
} from '@norbital-ai/bolt-protocol/facilities';
import {
	attachmentAssetsFromMessage,
	stripImageFileParts,
	taskAssetKeyPrefix,
	conversationAssetStorageKey as taskScopedImageKey,
	userMessageWithImages
} from './image-descriptors.js';
import {
	type ConversationControlRequest,
	type ConversationControlResult,
	type ConversationEditMessageRequest,
	type ConversationEditMessageResult,
	type ConversationSendRequest,
	type ConversationSendResult,
	type TaskModelCatalog
} from '@norbital-ai/bolt-protocol/system';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { PLATFORM_SKILLS } from './platform-skills.js';
import { WEB_AGENT_NAME, type WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { RemoteRegistry } from '#lib/runtime/collections/authored.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import * as Database from '#lib/runtime/facilities/database.js';
import {
	AI,
	Connector,
	HostTools,
	Tasks,
	type AIInterface
} from '#lib/runtime/facilities/services.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { workspaceSubject } from '#lib/runtime/identity/static-identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import {
	AgentModelUnavailable,
	InvalidToolInput,
	McpToolError,
	SkillError,
	ToolNotAllowed,
	SUBAGENT_TOOL_NAME,
	callMcpTool,
	executeHostTool,
	executeSystemTool,
	executeSubagentTool,
	invalidToolInput,
	isSystemTool,
	systemToolSpecs,
	subagentToolSpec,
	TodoList,
	type TodoList as TodoListValue,
	type SubagentContext,
	type ToolExecutionContext
} from './capability-catalog.js';

export {
	AgentModelUnavailable,
	InvalidToolInput,
	McpToolError,
	SkillError,
	ToolNotAllowed
} from './capability-catalog.js';

const encodeSubject = Schema.encodeSync(Identity.Subject);

class TaskRuntimeError extends Schema.TaggedError<TaskRuntimeError>()('Bolt.TaskRuntime.Error', {
	operation: Schema.NonEmptyString,
	message: Schema.NonEmptyString
}) {
	readonly category = 'task-runtime' as const;
	readonly retryable = false;
}

const CapabilityId = Schema.String.check(
	// MCP tool declarations are named `server:tool`, so the id body admits the colon.
	Schema.isPattern(/^(?:system|host|tenant|personal)\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
).pipe(Schema.brand('AgentCapabilityId'));
const CapabilitySnapshot = Schema.Struct({
	releaseId: ReleaseId,
	authorityDigest: Schema.NonEmptyString,
	capabilities: Schema.Array(
		Schema.Struct({
			id: CapabilityId,
			kind: Schema.Literals(['tool', 'skill', 'mcp']),
			digest: Schema.NonEmptyString
		})
	)
});
type CapabilitySnapshot = typeof CapabilitySnapshot.Type;

/**
 * `origin` is the durable difference between the two Compact checkpoints. `/compact <instruction>`
 * runs in `compact` mode against a user directive; TaskRuntime's automatic checkpoint runs inside the
 * Agent turn it is making room for. Both project identically — the projection reads `cutoff` and
 * `retainedMessageIds` and nothing else — so provenance has to be recorded rather than inferred from
 * the owning run, which is the mode of the turn, not of the checkpoint.
 */
const MessageAnnotation = Schema.Union([
	/**
	 * Where a queued input landed in the transcript, which is the input boundary and has no column.
	 *
	 * `priority` and `cancelled` used to live here too, beside the `priority` and `state` columns that
	 * hold the same facts — two sources of truth the runtime and the panel each read a different half
	 * of. The columns won.
	 */
	Schema.Struct({
		tag: Schema.Literal('input'),
		consumedAfterSequence: Schema.optionalKey(Schema.Natural)
	}),
	Schema.Struct({
		tag: Schema.Literal('generation'),
		callId: ProviderCallId,
		sequence: Schema.Natural,
		activeParts: Schema.Array(Schema.Natural)
	}),
	Schema.Struct({
		tag: Schema.Literal('compact'),
		origin: Schema.Literals(['manual', 'automatic', 'requested']),
		cutoff: Schema.Natural,
		retainedMessageIds: Schema.Array(MessageId)
	}),
	Schema.Struct({
		tag: Schema.Literal('plan-verdict'),
		planId: PlanId,
		complete: Schema.Boolean,
		gaps: Schema.Array(Schema.String)
	})
]);
type MessageAnnotation = typeof MessageAnnotation.Type;

export const ConversationRow = Schema.Struct({
	id: ConversationId,
	workbench_id: WorkbenchId,
	subject_id: SubjectId,
	agent_id: AgentId,
	audience: ConversationAudience,
	parent_id: Schema.optionalKey(Schema.NullOr(ConversationId)),
	status: ConversationStatus,
	active_plan_id: Schema.optionalKey(Schema.NullOr(PlanId)),
	active_turn_id: Schema.optionalKey(Schema.NullOr(TurnId)),
	/** The agent's current checklist, set and read through the `todo` tool. */
	todos: Schema.optionalKey(Schema.NullOr(TodoList))
});
type Conversation = typeof ConversationRow.Type;

export const PlanRow = Schema.Struct({
	id: PlanId,
	conversation_id: ConversationId,
	revision: Schema.Natural,
	checkpoint_sequence: Schema.Natural,
	body: Schema.NonEmptyString,
	status: Schema.Literals(['active', 'verified', 'stalled', 'superseded'])
});
type Plan = typeof PlanRow.Type;

export const ConversationMessageRow = Schema.Struct({
	id: MessageId,
	conversation_id: ConversationId,
	sequence: Schema.Natural,
	turn_id: Schema.optionalKey(Schema.NullOr(TurnId)),
	author: Schema.Struct({
		kind: Schema.Literals(['human', 'agent', 'parent-agent', 'tool', 'system']),
		id: Schema.optionalKey(Schema.NonEmptyString)
	}),
	message: Schema.toEncoded(Prompt.Message),
	semantic_hash: Schema.NonEmptyString,
	/**
	 * The queue, on the message. `queued` while somebody is waiting for an answer to it, then
	 * `consumed` by the turn that answers it, or `cancelled` when the conversation is stopped.
	 * Absent on every message nobody is waiting on: replies, tool results, system notes.
	 */
	state: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
	mode: Schema.optionalKey(Schema.NullOr(DirectiveMode)),
	priority: Schema.optionalKey(Schema.NullOr(DirectivePriority)),
	model_id: Schema.optionalKey(Schema.NullOr(ModelId)),
	annotation: Schema.optionalKey(Schema.NullOr(MessageAnnotation)),
	supersedes_id: Schema.optionalKey(Schema.NullOr(MessageId))
});
export type ConversationMessage = typeof ConversationMessageRow.Type;

export const TurnRow = Schema.Struct({
	id: TurnId,
	conversation_id: ConversationId,
	input_message_id: MessageId,
	mode: DirectiveMode,
	phase: RunPhase,
	input_through_sequence: Schema.Natural,
	model_id: ModelId,
	/** The model's context window as the catalog stated it when this turn was claimed. */
	context_window_tokens: Schema.Natural,
	status: RunStatus
});
type Turn = typeof TurnRow.Type;

export const TurnUsageRow = Schema.Struct({
	id: Schema.NonEmptyString,
	call_id: ProviderCallId,
	turn_id: TurnId,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	operation: Schema.Literals(['language', 'embedding']),
	usage: Schema.optionalKey(Schema.NullOr(UsageObservation)),
	charge: Schema.optionalKey(Schema.NullOr(Schema.toEncoded(ExactCharge))),
	charge_source: Schema.optionalKey(Schema.NullOr(Schema.Literals(['provider', 'price-table']))),
	pricing_version: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
	settlement_id: Schema.NonEmptyString,
	settlement_state: Schema.Literals(['pending', 'settled', 'attention'])
});

export const decodeRows = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	rows: ReadonlyArray<unknown>
) => Effect.forEach(rows, (row) => Schema.decodeUnknownEffect(schema)(row));

const canonicalJson = (value: unknown): string => {
	if (value instanceof Date) return JSON.stringify(value.toISOString()) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isObjectLike(value)) {
		return `{${Object.keys(value)
			.toSorted()
			.filter((key) => Reflect.get(value, key) !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
};

const semanticHash = (value: unknown): string => {
	const state = [0x81_1c_9d_c5, 0x9e_37_79_b9, 0x85_eb_ca_6b, 0xc2_b2_ae_35];
	const primes = [0x01_00_01_93, 0x5b_d1_e9_95, 0x27_d4_eb_2d, 0x16_56_67_b1];
	for (const byte of new TextEncoder().encode(canonicalJson(value))) {
		for (let index = 0; index < state.length; index += 1) {
			state[index] = Math.imul((state[index] ?? 0) ^ byte, primes[index] ?? 0x01_00_01_93);
		}
	}
	return state.map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
};

const deterministicId = (scope: string): string => {
	const hex = semanticHash(scope).slice(0, 32).split('');
	hex[12] = '4';
	hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
	return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)]
		.map((part) => part.join(''))
		.join('-');
};

export const conversationIdFor = (scope: string): ConversationId => ConversationId.make(deterministicId(`task:${scope}`));
const planIdFor = (scope: string): PlanId => PlanId.make(deterministicId(`plan:${scope}`));
const messageIdFor = (scope: string): MessageId =>
	MessageId.make(deterministicId(`message:${scope}`));
const runIdFor = (scope: string): TurnId => TurnId.make(deterministicId(`run:${scope}`));
const providerCallIdFor = (scope: string): ProviderCallId =>
	ProviderCallId.make(`call:${semanticHash(scope)}`);

const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const conversationAssetStorageKey = (conversationId: ConversationId, documentId: string, fileName: string): string =>
	taskScopedImageKey(conversationId, documentId, fileName);
const validateAttachments = (conversationId: ConversationId, assets: ReadonlyArray<ImageAsset>) =>
	Effect.gen(function* () {
		const prefix = taskAssetKeyPrefix(conversationId);
		if (
			assets.length > MAX_IMAGE_COUNT ||
			assets.reduce((sum, asset) => sum + asset.size, 0) > MAX_IMAGE_SOURCE_BYTES
		) {
			return yield* new TaskRuntimeError({
				operation: 'attachments',
				message: 'The attachment count or source bytes exceed the provider boundary.'
			});
		}
		for (const asset of assets) {
			if (
				!asset.key.startsWith(prefix) ||
				asset.key.includes('..') ||
				asset.key.split('/').length !== 3 ||
				!/^(image\/[\w.+-]+|text\/[\w.+-]+|application\/(pdf|json|(?:[\w.-]+\+)?xml))$/.test(
					asset.mimeType
				) ||
				asset.size <= 0
			) {
				return yield* new TaskRuntimeError({
					operation: 'attachments',
					message: 'An attachment descriptor is outside this conversation or malformed.'
				});
			}
		}
	});

const generationAssets = (assets: ReadonlyArray<ImageAsset>) => {
	const imageAssets = assets.filter((asset) => asset.mimeType.startsWith('image/'));
	const fileAssets = assets.filter((asset) => !asset.mimeType.startsWith('image/'));
	return {
		...(imageAssets.length === 0 ? {} : { imageAssets }),
		...(fileAssets.length === 0 ? {} : { fileAssets })
	};
};

const encodePromptMessage = Schema.encodeSync(Prompt.Message);
export const messageText = (message: Prompt.MessageEncoded): string =>
	isString(message.content)
		? message.content
		: message.content
				.flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
				.join('\n');
const systemMessage = (content: string): Prompt.MessageEncoded =>
	encodePromptMessage(Prompt.systemMessage({ content }));
export const userAgentInput = (text: string): Prompt.MessageEncoded =>
	encodePromptMessage(Prompt.userMessage({ content: [Prompt.textPart({ text })] }));
const parentAgentInput = (parentConversationId: ConversationId, text: string): Prompt.MessageEncoded =>
	userAgentInput(`[Parent agent ${parentConversationId}]\n${text}`);

export const InboundAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.NonEmptyString,
	asset: ImageAsset
});
export type InboundAttachment = typeof InboundAttachment.Type;
export const InboundBatchMessage = Schema.Struct({
	sender: Schema.Struct({
		id: Schema.optionalKey(Schema.NonEmptyString),
		displayName: Schema.optionalKey(Schema.NonEmptyString)
	}),
	sentAt: Schema.NonEmptyString,
	messageId: Schema.NonEmptyString,
	text: Schema.String,
	attachments: Schema.Array(InboundAttachment),
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient'])
});
export type InboundBatchMessage = typeof InboundBatchMessage.Type;
export const inboundAgentInput = (messages: ReadonlyArray<InboundBatchMessage>) =>
	userMessageWithImages(
		[
			'INBOUND BATCH',
			...messages.flatMap((message) => [
				`[${message.sentAt}] ${message.sender.displayName ?? message.sender.id ?? 'unidentified sender'} · ${message.invocation} · ${message.messageId}`,
				...(message.text === '' ? [] : [message.text]),
				...message.attachments.map(
					({ provider, attachmentId, asset }) =>
						`[image ${asset.name} · ${asset.mimeType} · ${asset.size} bytes] provider=${provider} attachment=${attachmentId} key=${asset.key}`
				)
			])
		].join('\n'),
		messages.flatMap(({ attachments }) => attachments.map(({ asset }) => asset))
	);

/**
 * Drops every message a later revision supersedes, keeping only the newest revision of each.
 *
 * A revision is an ordinary appended row, so it carries the newest sequence in the Task and the
 * conversation continues from it. Everything that was appended between the original and its revision
 * — the agent's answer to the superseded wording included — stays in the projection in sequence
 * order: it happened, it is durable, and hiding it would need a cutoff, which is Compact's job and
 * not supersession's.
 */
const supersessionProjection = (messages: ReadonlyArray<ConversationMessage>) => {
	const superseded = new Set(
		messages.flatMap(({ supersedes_id }) =>
			supersedes_id === undefined || supersedes_id === null ? [] : [supersedes_id]
		)
	);
	if (superseded.size === 0) return messages;
	return messages.filter(({ id }) => !superseded.has(id));
};

const compactProjection = (messages: ReadonlyArray<ConversationMessage>) => {
	const checkpoint = messages.findLast(({ annotation }) => annotation?.tag === 'compact');
	const annotation = checkpoint?.annotation;
	if (checkpoint === undefined || annotation?.tag !== 'compact') return messages;
	const retained = new Set(annotation.retainedMessageIds);
	return messages.filter(
		(message) =>
			contextSequence(message) > annotation.cutoff ||
			message.id === checkpoint.id ||
			retained.has(message.id)
	);
};

// A queued input can precede a checkpoint in storage but be delivered afterwards.
/**
 * The turn's own copy of its transcript.
 *
 * A turn used to re-read every message row on every token boundary — up to 500 rows, twice per
 * streamed part — to recover two facts it already had: the highest sequence in use, and the row it
 * wrote on the part before. Both live here. It is built once from one read, and every write records
 * itself as it lands, so what the ledger holds and what the table holds cannot diverge within a
 * turn.
 *
 * It is **not** a substitute for reading, and the difference is where the two facts come from. A row
 * is found here by an id this run derives deterministically, so nobody else can be writing it and a
 * cached answer stays true for as long as the run does. A *sequence* is the opposite: it is the
 * highest in the whole conversation, and admission writes a follow-up message into a conversation
 * whose turn is still running — that is what queueing a message is. A sequence taken from this
 * ledger and used after a provider call has returned is a sequence that was true before the call
 * and collides with `conversation_message_sequence` after it. So a row that needs a new sequence
 * still reads for one, close to its write; a row continuing one it already holds does not read at
 * all, which is the whole of the streaming path.
 */
export type Transcript = Readonly<{
	rows: () => ReadonlyArray<ConversationMessage>;
	/** The highest sequence in use, which is what the next appended row counts from. */
	lastSequence: () => number;
	byId: (id: MessageId) => ConversationMessage | undefined;
	/** Within-turn idempotency: the same content written twice is the same row. */
	bySemanticHash: (hash: string) => ConversationMessage | undefined;
	/** Insert, or replace in place when the row is one this turn already wrote. */
	record: (row: ConversationMessage) => void;
}>;

export const makeTranscript = (initial: ReadonlyArray<ConversationMessage>): Transcript => {
	const rows: Array<ConversationMessage> = [...initial];
	return {
		// A copy: a caller holding the ledger's own array would see it change under them.
		rows: () => [...rows],
		lastSequence: () => rows.reduce((highest, { sequence }) => Math.max(highest, sequence), 0),
		byId: (id) => rows.find((row) => row.id === id),
		bySemanticHash: (hash) => rows.find((row) => row.semantic_hash === hash),
		record: (row) => {
			const at = rows.findIndex((candidate) => candidate.id === row.id);
			if (at >= 0) rows[at] = row;
			else {
				// Sequence order is the transcript's order, and a streamed part can land while an
				// earlier row is still being written, so position is found rather than assumed.
				const before = rows.findIndex((candidate) => candidate.sequence > row.sequence);
				if (before < 0) rows.push(row);
				else rows.splice(before, 0, row);
			}
		}
	};
};

const contextSequence = (message: ConversationMessage): number =>
	message.annotation?.tag === 'input' && message.annotation.consumedAfterSequence !== undefined
		? Math.max(message.sequence, message.annotation.consumedAfterSequence + 1)
		: message.sequence;

const promptMessages = (messages: ReadonlyArray<ConversationMessage>, activePlan?: Plan) => {
	const projected = compactProjection(
		supersessionProjection(
			messages.filter(
				(row) =>
					row.annotation?.tag !== 'generation' &&
					(row.annotation?.tag !== 'input' || row.annotation.consumedAfterSequence !== undefined)
			)
		)
	);
	return activePlan === undefined
		? projected
		: projected.filter((message) => contextSequence(message) > activePlan.checkpoint_sequence);
};

const projectPrompt = (input: {
	readonly workspacePrompt: string;
	readonly agentInstruction?: string;
	readonly mode: DirectiveMode;
	readonly messages: ReadonlyArray<ConversationMessage>;
	readonly activePlan?: Plan;
}): ReadonlyArray<Prompt.MessageEncoded> => {
	const system = [input.workspacePrompt, input.agentInstruction]
		.filter((part): part is string => part !== undefined && part.trim() !== '')
		.join('\n\n');
	const activePlan = input.activePlan;
	const messages = promptMessages(input.messages, activePlan);
	return [
		...(system === '' ? [] : [systemMessage(system)]),
		...(activePlan === undefined
			? []
			: [systemMessage(`Active Plan revision ${activePlan.revision}:\n${activePlan.body}`)]),
		...(input.mode === 'plan'
			? [
					systemMessage(
						'Plan mode: produce the complete replacement plan, including the objective, implementation approach, and verification contract. Incorporate the latest request and preserve unchanged requirements from the active plan. Return the whole revised plan, never a diff or a partial amendment. Do not execute implementation tools.'
					)
				]
			: input.mode === 'compact'
				? [
						systemMessage(
							'Compact mode: summarize durable context without performing work or calling tools.'
						)
					]
				: []),
		...messages.map(({ message }) => stripImageFileParts(message))
	];
};

type EncodedToolCall = Readonly<{ id: string; name: string; params: unknown }>;
const toolCalls = (message: Prompt.MessageEncoded): ReadonlyArray<EncodedToolCall> =>
	isString(message.content)
		? []
		: message.content.flatMap((part) =>
				part.type === 'tool-call' ? [{ id: part.id, name: part.name, params: part.params }] : []
			);
const unresolvedToolCalls = (
	messages: ReadonlyArray<ConversationMessage>
): ReadonlyArray<EncodedToolCall> => {
	const resolved = new Set(
		messages.flatMap(({ message }) =>
			isString(message.content)
				? []
				: message.content.flatMap((part) => (part.type === 'tool-result' ? [part.id] : []))
		)
	);
	return messages.flatMap(({ message, annotation }) =>
		annotation?.tag === 'generation' ? [] : toolCalls(message).filter(({ id }) => !resolved.has(id))
	);
};
const toolResultMessage = (call: EncodedToolCall, result: unknown, isFailure: boolean) =>
	encodePromptMessage(
		Prompt.toolMessage({
			content: [
				Prompt.toolResultPart({
					id: call.id,
					name: call.name,
					result,
					isFailure,
					providerExecuted: false
				})
			]
		})
	);

const generateMessage = Effect.fn('Agents.generateMessage')(function* <ProgressError = never>(
	ai: AIInterface,
	effectId: EffectId,
	input: {
		callId: ProviderCallId;
		modelId: ModelId;
		messages: ReadonlyArray<Prompt.MessageEncoded>;
		maxOutputTokens: number;
		imageAssets?: ReadonlyArray<ImageAsset>;
		fileAssets?: ReadonlyArray<FileAsset>;
		tools?: ReadonlyArray<ToolDeclaration>;
		onProgress?: (progress: AIMessageProgress) => Effect.Effect<void, ProgressError>;
	}
) {
	const response = yield* ai.generate(
		effectId,
		{
			_tag: 'Generate',
			callId: input.callId,
			modelId: input.modelId,
			messages: [...input.messages],
			maxOutputTokens: input.maxOutputTokens,
			output: {
				_tag: 'Message',
				...(input.tools === undefined || input.tools.length === 0
					? {}
					: {
							tools: input.tools.map(({ name, description, inputSchema }) => ({
								name,
								description,
								inputSchema: inputSchema ?? EmptyToolInput
							}))
						})
			},
			...(input.imageAssets === undefined ? {} : { imageAssets: [...input.imageAssets] }),
			...(input.fileAssets === undefined ? {} : { fileAssets: [...input.fileAssets] })
		},
		input.onProgress
	);
	if (
		response.observation.callId !== input.callId ||
		response.observation.operation !== 'language' ||
		response.result._tag !== 'Message' ||
		response.result.message.role !== 'assistant'
	) {
		return yield* new TaskRuntimeError({
			operation: 'generate',
			message: 'The AI facility returned an invalid generation result.'
		});
	}
	return { message: response.result.message, observation: response.observation };
});

const generatePlanVerdict = Effect.fn('Agents.generatePlanVerdict')(function* (
	ai: AIInterface,
	effectId: EffectId,
	input: {
		callId: ProviderCallId;
		modelId: ModelId;
		messages: ReadonlyArray<Prompt.MessageEncoded>;
		maxOutputTokens: number;
	}
) {
	const response = yield* ai.generate(effectId, {
		_tag: 'Generate',
		callId: input.callId,
		modelId: input.modelId,
		messages: [...input.messages],
		maxOutputTokens: input.maxOutputTokens,
		output: { _tag: 'PlanVerdict' }
	});
	if (
		response.observation.callId !== input.callId ||
		response.observation.operation !== 'language' ||
		response.result._tag !== 'PlanVerdict'
	) {
		return yield* new TaskRuntimeError({
			operation: 'verify',
			message: 'The AI facility returned an invalid Plan verdict.'
		});
	}
	return {
		verdict: response.result.verdict satisfies PlanVerdict,
		observation: response.observation
	};
});

const usageMutation = Effect.fn('Agents.usageMutation')(function* (
	runId: TurnId,
	observation: ProviderObservation
) {
	const complete =
		observation.usage !== undefined &&
		observation.charge !== undefined &&
		observation.chargeSource !== undefined &&
		observation.pricingVersion !== undefined;
	const charge =
		observation.charge === undefined
			? undefined
			: yield* Schema.encodeUnknownEffect(ExactCharge)(observation.charge).pipe(
					Effect.mapError(
						() =>
							new TaskRuntimeError({
								operation: 'usage',
								message: 'The exact provider charge could not be encoded.'
							})
					)
				);
	return yield* Schema.decodeUnknownEffect(TurnUsageRow)({
		id: deterministicId(`usage:${observation.callId}`),
		call_id: observation.callId,
		turn_id: runId,
		provider: observation.provider,
		model: observation.model,
		operation: observation.operation,
		...(observation.usage === undefined ? {} : { usage: observation.usage }),
		...(charge === undefined ? {} : { charge }),
		...(observation.chargeSource === undefined ? {} : { charge_source: observation.chargeSource }),
		...(observation.pricingVersion === undefined
			? {}
			: { pricing_version: observation.pricingVersion }),
		settlement_id: `ai:${observation.callId}`,
		settlement_state: complete ? 'pending' : 'attention'
	}).pipe(
		Effect.mapError(
			() =>
				new TaskRuntimeError({
					operation: 'usage',
					message: 'The exact provider observation is malformed.'
				})
		)
	);
});

const releaseIdFor = (workspaceIdentity: unknown): ReleaseId =>
	ReleaseId.make(`release:${semanticHash(workspaceIdentity)}`);

type ResolvedAgent = Readonly<{
	id: AgentId;
	instruction?: string;
	audience: ConversationAudience;
	delegation: 'enabled' | 'disabled';
}>;
type TurnResult = Readonly<{
	conversationId: ConversationId;
	status: 'idle' | 'running' | 'done' | 'failed' | 'attention';
	output?: Prompt.MessageEncoded;
}>;

/**
 * Everything running a turn can fail with.
 *
 * Named because a parent now runs its children, so the recursion `execute → childBarrier →
 * runChild → answerQueued → execute` is real and inference has no fixed point to find. One written
 * union gives it one, and the three signatures that used to spell it out share it.
 */
type TurnFailure =
	| TaskRuntimeError
	| AccessControl.AccessDenied
	| AgentModelUnavailable
	| ToolNotAllowed
	| McpToolError
	| SkillError
	| Collections.QueryError
	| Collections.BatchMutationError
	| Schema.SchemaError
	| DispatchError
	| Workspace.WorkspaceLookupError
	| InvocationBudget.NestingLimitExceeded
	| AuthoredRefusal
	// Effect's `Toolkit` dispatch, which is how a tool call reaches its handler.
	| AiError.AiError;

/**
 * Who runs the admitted turn. `host` (the default, and the only shape the wire can express) hands
 * the host a claimed occurrence to run at once. `inline` is for a runtime caller that executes the
 * turn itself in the same invocation, the Envoy drain: no row, no wake, nothing for the host to race
 * the caller's own `execute` for the run claim.
 */

export type Interface = Readonly<{
	readonly models: (
		effectId: EffectId,
		subject: Identity.Subject,
		agentId: AgentId
	) => Effect.Effect<
		TaskModelCatalog,
		AccessControl.AccessDenied | Workspace.WorkspaceLookupError | Database.FacilityError
	>;
	readonly submit: (
		effectId: EffectId,
		subject: Identity.Subject,
		request: ConversationSendRequest
	) => Effect.Effect<
		ConversationSendResult,
		| TaskRuntimeError
		| AccessControl.AccessDenied
		| AgentModelUnavailable
		| ToolNotAllowed
		| McpToolError
		| SkillError
		| Collections.QueryError
		| Collections.BatchMutationError
		| Schema.SchemaError
		| DispatchError
		| Workspace.WorkspaceLookupError
		| InvocationBudget.NestingLimitExceeded
		| AuthoredRefusal
	>;
	readonly editMessage: (
		effectId: EffectId,
		subject: Identity.Subject,
		request: ConversationEditMessageRequest
	) => Effect.Effect<
		ConversationEditMessageResult,
		| TaskRuntimeError
		| AccessControl.AccessDenied
		| AgentModelUnavailable
		| ToolNotAllowed
		| McpToolError
		| SkillError
		| Collections.QueryError
		| Collections.BatchMutationError
		| Schema.SchemaError
		| DispatchError
		| Workspace.WorkspaceLookupError
		| InvocationBudget.NestingLimitExceeded
		| AuthoredRefusal
	>;
	readonly control: (
		effectId: EffectId,
		subject: Identity.Subject,
		request: ConversationControlRequest
	) => Effect.Effect<
		ConversationControlResult,
		| TaskRuntimeError
		| AccessControl.AccessDenied
		| AgentModelUnavailable
		| ToolNotAllowed
		| McpToolError
		| SkillError
		| Collections.QueryError
		| Collections.BatchMutationError
		| Schema.SchemaError
		| DispatchError
		| Workspace.WorkspaceLookupError
		| InvocationBudget.NestingLimitExceeded
		| AuthoredRefusal
	>;
	/**
	 * Answers one message. The primitive: an envoy or a schedule runs exactly the turn it came for.
	 */
	readonly execute: (
		effectId: EffectId,
		subject: Identity.Subject,
		conversationId: ConversationId
	) => Effect.Effect<TurnResult, TurnFailure>;
	/**
	 * Answers the message just sent, then everything else the conversation has waiting. What a person
	 * holding a response open needs, and what replaced the durable work occurrence between turns.
	 */
	readonly answerQueued: (
		effectId: EffectId,
		subject: Identity.Subject,
		conversationId: ConversationId
	) => Effect.Effect<TurnResult, TurnFailure>;
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Agents');

const ToolFailure = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	phase: Schema.optionalKey(Schema.Literals(['prepare', 'commit', 'settle'])),
	committed: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
});
interface ToolFailure extends Schema.Schema.Type<typeof ToolFailure> {}

const describeFailure = (failure: unknown): ToolFailure => {
	if (failure instanceof Collections.MutationPhaseFailure) {
		const underlying = describeFailure(failure.underlying);
		return {
			...underlying,
			phase: failure.phase,
			committed: failure.committed,
			message:
				failure.phase === 'settle'
					? `The write committed; do not retry it. ${underlying.message}`
					: underlying.message
		};
	}
	if (failure instanceof InvalidToolInput) return { code: failure._tag, message: failure.detail };
	if (failure instanceof Error) {
		const tag = Reflect.get(failure, '_tag');
		return {
			code: isString(tag) && tag !== '' ? tag : failure.name || 'tool_error',
			message: failure.message.trim() || 'Tool execution failed.'
		};
	}
	if (isObjectLike(failure)) {
		const tag = Reflect.get(failure, '_tag');
		const message = Reflect.get(failure, 'message');
		return {
			code: isString(tag) && tag !== '' ? tag : 'tool_error',
			message: isString(message) && message !== '' ? message : 'Tool execution failed.'
		};
	}
	return { code: 'tool_error', message: String(failure) };
};

/** The agents a `subagent` spawn may name in this workspace: the web agent plus every envoy. */
export const spawnableAgentIds = (
	definition: Pick<WorkspaceDefinition, 'envoys'>
): ReadonlyArray<string> => [WEB_AGENT_NAME, ...definition.envoys.map(({ name }) => name)];

/**
 * The content a Compact checkpoint stores: the model's prose and nothing else.
 *
 * The summary generation runs without tools and never asked for reasoning, yet a model answers it
 * with whatever it likes: a reasoning part (B2 applies to this message as to any other), or a tool
 * call it cannot make, in a part or as its native markup inside the text. Parts that are not text
 * are dropped here so the checkpoint the panel's Summary tab shows is the summary, and a call the
 * loop could otherwise pick up as unresolved work never enters the transcript. When no prose is
 * left the checkpoint still has to exist (one per run, or the next iteration would compact again),
 * so it carries a sentence saying so rather than an empty message.
 */
export const CHECKPOINT_WITHOUT_SUMMARY =
	'Automatic Compact produced no summary for this checkpoint; the messages retained after it carry the context that continues this Task.';
export const checkpointContent = (message: Prompt.MessageEncoded): Prompt.MessageEncoded => {
	if (message.role !== 'assistant') return message;
	if (isString(message.content)) {
		return message.content.trim() === ''
			? { ...message, content: CHECKPOINT_WITHOUT_SUMMARY }
			: message;
	}
	const prose = message.content.filter(
		(part): part is Prompt.TextPartEncoded => part.type === 'text' && part.text.trim() !== ''
	);
	return prose.length === 0
		? { ...message, content: CHECKPOINT_WITHOUT_SUMMARY }
		: { ...message, content: prose };
};

const EmptyToolInput: Schema.JsonObject = {
	type: 'object',
	properties: {},
	additionalProperties: false
};

const writeActions: ReadonlyArray<'create' | 'update' | 'delete'> = ['create', 'update', 'delete'];
const isString = Schema.is(Schema.String);

/** A conversation nobody is still working on. `attention` is terminal: it is waiting on a person. */
const isSettled = (status: Conversation['status']) =>
	status !== 'ready' && status !== 'running';
const isObjectLike = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

const MAX_CHILD_CONSUME_NUDGES = 2;
const MAX_PLAN_VERIFICATION_ATTEMPTS = 3;
const PLAN_VERIFICATION_OUTPUT_TOKENS = 768;
/**
 * How full a model's context may get before the turn compacts, as a fraction of its own window.
 *
 * A fraction, not a constant. This used to be 64 KiB of encoded projection: one number for every
 * model, measured in the wrong unit. It compacted a 1M-token model at six percent of its capacity
 * and a 32k model too late, and no arithmetic on byte lengths could tell the two apart, because the
 * quantity that matters is the model's window and the byte count does not know it. The window is
 * now a required field on `ModelCatalogEntry` — a host registering a model knows it — and is stamped
 * onto the turn at claim, so the bound is per-model and auditable after the fact.
 *
 * The tokens are the provider's own count from the previous call's observation, not an estimate:
 * `inputTokens + outputTokens` is what the next call's input will be, plus whatever tool results
 * were appended in between. Three quarters leaves room for that plus the reply, and leaves the
 * checkpoint landing while the conversation still fits comfortably rather than at the edge where one
 * large tool result decides whether the turn survives. It is deliberately host-side: a workspace
 * author cannot raise it into a provider's hard failure.
 */
const COMPACT_AT_FRACTION_OF_WINDOW = 0.75;
/** How many checkpoints an agent may ask for in one turn. The runtime's own budget is one. */
const MAX_REQUESTED_COMPACTIONS_PER_TURN = 3;
const AUTO_COMPACT_OUTPUT_TOKENS = 1_536;
const planVerificationExecutionPlan = ExecutionPlan.make({
	provide: Context.empty(),
	attempts: 2
});
/**
 * What the last provider call actually cost in context, or zero before the first one.
 *
 * `total`, not `uncached`: a cached input token still occupies the window. An adapter that reports
 * only `billableUnits` has no token counts at all, which reads as zero — and the estimate below
 * then carries the decision on its own, which is the honest answer for a provider that will not say.
 */
const observedTokens = (usage: UsageObservation | null | undefined): number => {
	if (usage === undefined || usage === null || !('inputTokens' in usage)) return 0;
	return (usage.inputTokens?.total ?? 0) + (usage.outputTokens?.total ?? 0);
};

/**
 * What the projection about to be sent is worth in tokens, roughly.
 *
 * Four bytes to the token is the usual rule of thumb, and it is only ever a rule of thumb: the true
 * count belongs to a provider's tokenizer, which costs a round trip to ask. It is used *beside* the
 * measurement rather than instead of it — the measurement says what the last call actually cost, the
 * estimate covers everything appended since, and a first call has only the estimate. The larger of
 * the two decides, so neither a long history nor one enormous tool result slips past.
 */
const estimatedTokens = (messages: ReadonlyArray<Prompt.MessageEncoded>): number =>
	Math.ceil(new TextEncoder().encode(JSON.stringify(messages)).byteLength / 4);
const ConsumedChildResult = Schema.Struct({
	state: Schema.Literals(['done', 'failed']),
	conversationId: ConversationId
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const access = yield* AccessControl.Service;
		const collections = yield* Collections.Service;
		const ai = yield* AI.Service;
		const database = yield* Database.Service;
		const hostTools = yield* HostTools.Service;
		const connector = yield* Connector.Service;
		const remotes = yield* RemoteRegistry;


		const resolveAgent = Effect.fn('Agents.resolveAgent')(function* (agentId: AgentId) {
			if (agentId === WEB_AGENT_NAME) {
				return {
					id: agentId,
					audience: ConversationAudience.make('personal'),
					delegation: 'enabled'
				} satisfies ResolvedAgent;
			}
			const envoy = workspace.definition.envoys.find(({ name }) => name === agentId);
			if (envoy === undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: agentId,
					reason: 'unknown agent'
				});
			}
			return {
				id: agentId,
				instruction: envoy.task,
				audience: ConversationAudience.make('workbench'),
				delegation: envoy.delegation
			} satisfies ResolvedAgent;
		});

		const allowedSkills = (subject: Identity.Subject) => {
			const held = workspace.definition.skills.filter(({ name }) =>
				access.capabilities(subject).skills.has(name)
			);
			const names = new Set(held.map(({ name }) => name));
			// Host skills are always available; an authored skill of the same name wins.
			return [...held, ...PLATFORM_SKILLS.filter(({ name }) => !names.has(name))];
		};

		const writesForSubject = (subject: Identity.Subject): boolean =>
			workspace.definition.collections.some((collection) =>
				writeActions.some((action) => access.explain(subject, action, collection.name).allowed)
			);

		const reachableCollections = (
			subject: Identity.Subject,
			action: 'read' | 'write'
		): ReadonlyArray<string> =>
			workspace.definition.collections
				.filter(({ name }) =>
					action === 'read'
						? access.explain(subject, 'read', name).allowed
						: writeActions.some((write) => access.explain(subject, write, name).allowed)
				)
				.map(({ name }) => name);

		const allowedTools = Effect.fn('Agents.allowedTools')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			agent: ResolvedAgent
		) {
			const granted = access.capabilities(subject);
			const authored = workspace.definition.tools.filter((tool) =>
				tool.mcp === undefined ? granted.tools.has(tool.name) : granted.mcp.has(tool.mcp.server)
			);
			const authoredNames = new Set(authored.map(({ name }) => name));
			const host =
				agent.id !== WEB_AGENT_NAME || subject.system === true || subject.policies.length > 0
					? []
					: yield* hostTools.execute(effectId, { tool: 'capability_catalog', input: {} }).pipe(
							Effect.provideService(Identity.CurrentSubject, subject),
							Effect.flatMap(({ output }) => Schema.decodeUnknownEffect(HostToolCatalog)(output)),
							Effect.map(({ tools }) => tools),
							Effect.catch((error) =>
								error instanceof Database.FacilityError && error.code === 'facility_unavailable'
									? Effect.succeed([])
									: Effect.fail(
											new TaskRuntimeError({
												operation: 'host-capabilities',
												message: getErrorMessage(error)
											})
										)
							)
						);
			const tools: ReadonlyArray<ToolDeclaration & { readonly hostReadOnly?: boolean }> = [
				...systemToolSpecs.filter(
					(tool) =>
						!authoredNames.has(tool.name) &&
						(tool.name !== 'write_collection' || writesForSubject(subject))
				),
				...(agent.delegation === 'enabled' && !authoredNames.has(SUBAGENT_TOOL_NAME)
					? [subagentToolSpec(spawnableAgentIds(workspace.definition))]
					: []),
				...host
					.filter(
						({ name }) =>
							!authoredNames.has(name) &&
							!systemToolSpecs.some((tool) => tool.name === name) &&
							name !== SUBAGENT_TOOL_NAME
					)
					.map(({ readOnly, ...tool }) => ({
						...tool,
						command: `host:${tool.name}`,
						hostReadOnly: readOnly
					})),
				...authored
			];
			return tools;
		});

		const capabilitySnapshot = (
			subject: Identity.Subject,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>
		): CapabilitySnapshot => {
			const capabilities = [
				...tools.map((tool) => ({
					id: CapabilityId.make(
						`${tool.command.startsWith('host:') ? 'host' : tool.mcp === undefined ? (systemToolSpecs.some(({ name }) => name === tool.name) || tool.name === SUBAGENT_TOOL_NAME ? 'system' : 'tenant') : 'tenant'}/${tool.name}`
					),
					kind: tool.mcp === undefined ? ('tool' as const) : ('mcp' as const),
					digest: semanticHash(tool)
				})),
				...allowedSkills(subject).map((skill) => ({
					id: CapabilityId.make(`tenant/${skill.name}`),
					kind: 'skill' as const,
					digest: semanticHash(skill)
				}))
			];
			return {
				releaseId: releaseIdFor({
					name: workspace.definition.name,
					version: workspace.definition.version,
					prompt: workspace.definition.prompt
				}),
				authorityDigest: semanticHash({ subject, agent: agent.id, capabilities }),
				capabilities
			};
		};

		const models = Effect.fn('Agents.models')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			agentId: AgentId
		) {
			const agent = yield* resolveAgent(agentId);
			yield* access.authorize(subject, 'agent', agent.id);
			const { languageModels, defaultLanguageModelId } = yield* ai.catalog(effectId, {
				_tag: 'Catalog'
			});
			return { languageModels, defaultLanguageModelId };
		});

		const selectModel = Effect.fn('Agents.selectModel')(function* (
			effectId: EffectId,
			requested?: ModelId
		) {
			const response = yield* ai.catalog(effectId, { _tag: 'Catalog' });
			const selected = response.languageModels.find(
				({ id }) => id === (requested ?? response.defaultLanguageModelId)
			);
			if (selected === undefined) {
				return yield* new AgentModelUnavailable({
					model: requested ?? 'catalog',
					reason: requested === undefined ? 'invalid-catalog' : 'not-found'
				});
			}
			// The entry, not the id: the turn needs the window as much as the name.
			return selected;
		});

		const conversationById = Effect.fn('Agents.conversationById')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'conversation',
				where: { id: { eq: conversationId } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(ConversationRow)(row).pipe(
				Effect.mapError(
					() =>
						new TaskRuntimeError({
							operation: 'read-task',
							message: 'The durable Task row is malformed.'
						})
				)
			);
		});

		const requireOwnedConversation = Effect.fn('Agents.requireOwnedConversation')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			const task = yield* conversationById(effectId, subject, conversationId);
			if (task === undefined || task.subject_id !== subject.userId) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: conversationId,
					reason: 'unknown Task'
				});
			}
			return task;
		});

		const messageRows = Effect.fn('Agents.messageRows')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'conversation_message',
				where: { conversation_id: { eq: conversationId } },
				orderBy: { sequence: 'asc' },
				limit: 500
			});
			const messages = yield* decodeRows(ConversationMessageRow, rows);
			return messages;
		});

		type RelatedMutation = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;

		const writeConversation = (
			effectId: EffectId,
			subject: Identity.Subject,
			mutation: Readonly<Record<string, unknown>> & Readonly<{ id: ConversationId }>,
			action: 'create' | 'update' = 'update'
		) =>
			// The task row is the runtime's own bookkeeping, written as the workspace: no grant, no route.
			collections.mutate(effectId, workspaceSubject(subject), 'conversation', [mutation], 0, {
				roots: [{ id: mutation.id, action }]
			});

		/**
		 * Rows written where they live, rather than as passengers on the conversation.
		 *
		 * Every one of these writes used to travel nested under the task row, with the conversation's
		 * own columns restated as the values they already held. The nesting is what made the mutate a
		 * *replacement* — a sibling left out of the payload would be deleted — so each write first read
		 * back up to 500 rows to restate the ids of rows nothing was changing. That read is
		 * O(conversation) and it stood in front of a write per streamed part.
		 *
		 * A row addressed by its own collection has no siblings to restate and nothing to read first.
		 * Where the conversation genuinely changed too, it is written on its own; where it did not —
		 * `recordUsage`, steering delivery, a recall — the passenger write is simply gone.
		 */
		type GraphWrite = Readonly<{
			collection: string;
			row: RelatedMutation;
			action?: 'create' | 'update';
		}>;

		/**
		 * Rows written together, whatever collections they belong to, as one commit.
		 *
		 * A mutate is one transaction and publishes one commit, and a commit crosses to the host — so
		 * the unit that matters is the call, not the collection. The engine has always grouped roots
		 * by collection and compiled every group into a single statement plan; only the public root
		 * type withheld the field that says which collection a root is in.
		 *
		 * That is what keeps a turn's start at one write: the `turn` row is created, its input
		 * message is marked answered and the conversation is moved to `running`, in one statement,
		 * with no sibling read in front of any of it.
		 */
		const writeGraph = (
			effectId: EffectId,
			subject: Identity.Subject,
			writes: ReadonlyArray<GraphWrite>
		) =>
			writes.length === 0
				? Effect.void
				: collections.mutate(
						effectId,
						workspaceSubject(subject),
						writes[0]!.collection,
						writes.map(({ row }) => row),
						0,
						{
							roots: writes.map(({ collection, row, action }) => ({
								collection,
								id: row.id,
								action: action ?? 'update'
							}))
						}
					);

		const writeRows = (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			rows: ReadonlyArray<RelatedMutation>,
			action: 'create' | 'update' = 'update'
		) => writeGraph(effectId, subject, rows.map((row) => ({ collection, row, action })));

		const writeMessage = (
			effectId: EffectId,
			subject: Identity.Subject,
			row: RelatedMutation,
			action: 'create' | 'update'
		) => writeRows(effectId, subject, 'conversation_message', [row], action);

		const activePlan = Effect.fn('Agents.activePlan')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation
		) {
			if (task.active_plan_id === undefined || task.active_plan_id === null) return undefined;
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'plan',
				where: { id: { eq: task.active_plan_id } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(PlanRow)(row);
		});

		const lastSequence = (messages: ReadonlyArray<ConversationMessage>): number =>
			messages.at(-1)?.sequence ?? 0;

		type Admission = Readonly<{
			conversationId: ConversationId;
			agentId: AgentId;
			submissionId?: MessageId;
			message: Prompt.MessageEncoded;
			author: Readonly<{ kind: 'human' | 'parent-agent' | 'system'; id?: string }>;
			mode: DirectiveMode;
			/** A person's choice. An agent writing to another agent does not have one — see `admit`. */
			priority?: DirectivePriority;
			annotation?: MessageAnnotation;
			runId?: TurnId;
			supersedesId?: MessageId;
			parent?: Conversation;
			resume?: boolean;
			modelId?: ModelId;
		}>;

		/**
		 * One agent writing to another always steers; nobody else does unless they ask to.
		 *
		 * The two priorities differ in *when* a message is taken: `steer` at the end of the running
		 * turn's next step, `normal` as a turn of its own once the current one finishes. A parent
		 * that has just learned something its child needs is describing the step the child is about
		 * to take, so waiting for the child to finish and then telling it is the wrong answer every
		 * time — and a child left to finish first is a child that has already done the wrong work.
		 *
		 * Decided here rather than at the three call sites that admit on an agent's behalf, because
		 * a rule stated three times is a rule that will hold in two places. It also removed the
		 * `steer` action from the `subagent` tool: with the priority fixed, `message` and `steer`
		 * were the same call under two names, and a model choosing between them could only get it
		 * wrong.
		 */
		const admit = Effect.fn('Agents.admit')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			admission: Admission
		) {
			const input: Admission & { readonly priority: DirectivePriority } = {
				...admission,
				priority:
					admission.author.kind === 'parent-agent'
						? DirectivePriority.make('steer')
						: (admission.priority ?? DirectivePriority.make('normal'))
			};
			const agent = yield* resolveAgent(input.agentId);
			yield* access.authorize(subject, 'agent', agent.id);
			const existing = yield* conversationById(EffectId.make(`${effectId}:task`), subject, input.conversationId);
			// A human conversation outlives its runs. Delegated tasks retain terminal result semantics.
			const conversation = existing?.parent_id == null && input.author.kind === 'human';
			const continueConversation =
				conversation &&
				existing !== undefined &&
				(existing.status === 'done' ||
					existing.status === 'failed' ||
					existing.status === 'stopped' ||
					existing.status === 'attention');
			if (existing !== undefined) {
				if (
					existing.subject_id !== subject.userId ||
					existing.agent_id !== input.agentId ||
					existing.audience !== agent.audience ||
					(existing.status === 'done' && !conversation) ||
					(existing.status === 'failed' && !input.resume && !conversation)
				) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: input.conversationId,
						reason: 'Task identity is immutable'
					});
				}
				if (!input.resume && !conversation && existing.status === 'stopped') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: input.conversationId,
						reason: 'Task is stopped; use control resume'
					});
				}
			}
			let messages: ReadonlyArray<ConversationMessage> = [];
			if (existing !== undefined) messages = yield* messageRows(effectId, subject, input.conversationId);
			const fingerprint = semanticHash({
				conversationId: input.conversationId,
				...(input.submissionId === undefined ? {} : { submissionId: input.submissionId }),
				author: input.author,
				message: input.message,
				annotation: input.annotation,
				runId: input.runId,
				supersedesId: input.supersedesId,
				mode: input.mode,
				priority: input.priority,
				...(input.modelId === undefined ? {} : { modelId: input.modelId })
			});
			/**
			 * Two identities, because two kinds of caller admit a message. A client mints a
			 * `submissionId` per intentional message, so a retry of that send is the same id. The
			 * runtime's own callers — a revision, a resume, a subagent spawn — mint nothing, and their
			 * identity is the content itself, which is what makes those idempotent under replay.
			 */
			const duplicate = messages.find(({ id, semantic_hash }) =>
				input.submissionId === undefined ? semantic_hash === fingerprint : id === input.submissionId
			);
			if (duplicate !== undefined) {
				if (duplicate.semantic_hash !== fingerprint)
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: input.conversationId,
						reason: 'A submission ID cannot be reused for a different message.'
					});
				// The same message sent twice is the same message: already in the transcript, and either
				// already queued or already answered. Nothing further is admitted for it.
				return { messageId: duplicate.id };
			}
			if (input.modelId !== undefined)
				yield* selectModel(EffectId.make(`${effectId}:model`), input.modelId);
			const messageId = input.submissionId ?? messageIdFor(`${input.conversationId}:${fingerprint}`);
			const nextSequence = lastSequence(messages) + 1;
			/**
			 * One row. A message somebody is waiting for an answer to carries what the turn answering
			 * it needs — the mode, the model, and where it queues — because those describe this message
			 * rather than a separate work item about it. A message nobody is waiting on carries no
			 * queue state at all: an assistant reply, a tool result, a system note.
			 */
			const message = {
				id: messageId,
				conversation_id: input.conversationId,
				sequence: nextSequence,
				author: input.author,
				message: input.message,
				semantic_hash: fingerprint,
				...(input.runId === undefined ? {} : { turn_id: input.runId }),
				annotation: input.annotation ?? { tag: 'input' },
				...(input.supersedesId === undefined ? {} : { supersedes_id: input.supersedesId }),
				state: 'queued',
				mode: input.mode,
				priority: input.priority,
				...(input.modelId === undefined ? {} : { model_id: input.modelId })
			};
			if (existing === undefined) {
				const workbenchId = input.parent?.workbench_id ?? WorkbenchId.make(input.conversationId);
				yield* writeConversation(
					effectId,
					subject,
					{
						id: input.conversationId,
						workbench_id: workbenchId,
						subject_id: SubjectId.make(subject.userId),
						agent_id: input.agentId,
						audience: agent.audience,
						...(input.parent === undefined ? {} : { parent_id: input.parent.id }),
						status: 'ready',
						messages: [message]
					},
					'create'
				);
			} else {
				yield* writeMessage(effectId, subject, message, 'create');
				// The conversation only changes when this admission reopens it; otherwise it is untouched.
				if (input.resume || continueConversation)
					yield* writeConversation(EffectId.make(`${effectId}:reopen`), subject, {
						id: input.conversationId,
						status: 'ready',
						active_turn_id: null
					});
			}
			return { messageId } satisfies ConversationSendResult;
		});

		/**
		 * Admits one message into the conversation and returns its id.
		 *
		 * Admission and the turn are separate calls but no longer separate *invocations*: there is no
		 * durable directive between them and nothing to claim, so the caller that admits a message is
		 * the caller that runs the turn for it. `conversations.send` does both in one guest invocation; an
		 * envoy or a schedule does the same by calling `execute` itself.
		 *
		 * A second message arriving while a turn runs finds the conversation `running`, stays queued,
		 * and is answered by the turn in flight when it reaches its next boundary.
		 */
		/** A send is an admission by a person: the request, plus who they are. */
		const submit = (
			effectId: EffectId,
			subject: Identity.Subject,
			request: ConversationSendRequest
		) => admit(effectId, subject, { ...request, author: { kind: 'human', id: subject.userId } });

		/**
		 * Revises one of the subject's own durable user messages.
		 *
		 * Nothing is edited and nothing is deleted: the revision is an ordinary appended message that
		 * names the row it supersedes, and the same admission queues the Agent directive that continues
		 * from it. Only the message's author may revise it, and only the newest revision of a message
		 * may be revised again, so a message never has two live heads.
		 */
		const editMessage = Effect.fn('Agents.editMessage')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: ConversationEditMessageRequest
		) {
			const task = yield* requireOwnedConversation(
				EffectId.make(`${effectId}:task`),
				subject,
				request.conversationId
			);
			const messages = yield* messageRows(effectId, subject, task.id);
			const original = messages.find(({ id }) => id === request.messageId);
			if (original === undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: request.messageId,
					reason: 'unknown Task message'
				});
			}
			if (original.author.kind !== 'human' || original.author.id !== subject.userId) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: request.messageId,
					reason: 'only the author may revise their own message'
				});
			}
			if (messages.some(({ supersedes_id }) => supersedes_id === request.messageId)) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: request.messageId,
					reason: 'the message is already superseded; revise its newest revision'
				});
			}
			const admitted = yield* admit(effectId, subject, {
				conversationId: task.id,
				agentId: task.agent_id,
				message: request.message,
				author: { kind: 'human', id: subject.userId },
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal'),
				supersedesId: request.messageId,
				...(request.modelId === undefined ? {} : { modelId: request.modelId })
			});
			const revision = yield* collections.findFirst(
				EffectId.make(`${effectId}:revision`),
				subject,
				{ collection: 'conversation_message', where: { supersedes_id: { eq: request.messageId } } }
			);
			const decoded = yield* Schema.decodeUnknownEffect(ConversationMessageRow)(revision);
			return {
				messageId: decoded.id,
				supersedesId: request.messageId
			} satisfies ConversationEditMessageResult;
		});

		const runById = Effect.fn('Agents.runById')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			runId: TurnId
		) {
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'turn',
				where: { id: { eq: runId } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(TurnRow)(row);
		});

		/**
		 * The newest provider observation this conversation has, or nothing before its first call.
		 *
		 * One bounded read per turn, which is what lets the token bound be checked before the turn's
		 * first generation rather than after it. `turn_usage` is per turn, so this joins through the
		 * conversation's turns rather than reading a column the usage row does not carry.
		 */
		const latestObservation = Effect.fn('Agents.latestObservation')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			const turns = yield* collections.findMany(EffectId.make(`${effectId}:turns`), subject, {
				collection: 'turn',
				where: { conversation_id: { eq: conversationId } },
				orderBy: { created_at: 'desc' },
				limit: 1
			});
			const newest = (yield* decodeRows(Schema.Struct({ id: TurnId }), turns))[0];
			if (newest === undefined) return undefined;
			const rows = yield* collections.findMany(EffectId.make(`${effectId}:usage`), subject, {
				collection: 'turn_usage',
				where: { turn_id: { eq: newest.id } },
				orderBy: { created_at: 'desc' },
				limit: 1
			});
			return (yield* decodeRows(TurnUsageRow, rows))[0];
		});

		const conversationDepth = Effect.fn('Agents.conversationDepth')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			root: Conversation
		) {
			let depth = 0;
			let current = root;
			const visited = new Set<ConversationId>([root.id]);
			while (current.parent_id !== undefined && current.parent_id !== null) {
				if (visited.has(current.parent_id) || depth >= 64) {
					return yield* new TaskRuntimeError({
						operation: 'task-depth',
						message: 'The durable child Task lineage is cyclic or unbounded.'
					});
				}
				visited.add(current.parent_id);
				const parent = yield* conversationById(
					EffectId.make(`${effectId}:parent:${depth}`),
					subject,
					current.parent_id
				);
				if (parent === undefined || parent.workbench_id !== root.workbench_id) {
					return yield* new TaskRuntimeError({
						operation: 'task-depth',
						message: 'The durable child Task lineage leaves its workbench.'
					});
				}
				current = parent;
				depth += 1;
			}
			return depth;
		});

		const claim = Effect.fn('Agents.claim')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation
		) {
			// The caller that claimed a running turn owns its loop. A second send only queues
			// its message; stop/resume creates a new turn if the original invocation failed.
			if (task.status !== 'ready') return undefined;
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'conversation_message',
				where: { conversation_id: { eq: task.id }, state: { eq: 'queued' } },
				orderBy: { priority: 'desc', sequence: 'asc' },
				limit: 1
			});
			const waiting = yield* decodeRows(
				Schema.Struct({
					id: MessageId,
					priority: DirectivePriority,
					sequence: Schema.Number.check(Schema.isInt()),
					mode: DirectiveMode,
					model_id: Schema.optionalKey(Schema.NullOr(ModelId))
				}),
				rows
			);
			const directive = waiting[0];
			if (directive === undefined) return undefined;
			const agent = yield* resolveAgent(task.agent_id);
			yield* access.authorize(subject, 'agent', agent.id);
			const model = yield* selectModel(
				EffectId.make(`${effectId}:model`),
				directive.model_id ?? undefined
			).pipe(
				Effect.tapError(() => writeConversation(effectId, subject, { id: task.id, status: 'attention' }))
			);
			const tools = yield* allowedTools(
				EffectId.make(`${effectId}:host-capabilities`),
				subject,
				agent
			);
			const runId = runIdFor(`${task.id}:${directive.id}`);
			const messages = yield* messageRows(effectId, subject, task.id);
			const run = {
				id: runId,
				conversation_id: task.id,
				input_message_id: directive.id,
				mode: directive.mode,
				phase: 'model',
				input_through_sequence: lastSequence(messages),
				model_id: model.id,
				context_window_tokens: model.contextWindowTokens,
				capability_snapshot: capabilitySnapshot(subject, agent, tools),
				status: 'running'
			};
			const directiveMessage = messages.find(({ id }) => id === directive.id);
			// Starting a turn is one write: the run exists, the message it answers has left the queue,
			// and the conversation is running — three collections, one statement, one commit.
			yield* writeGraph(effectId, subject, [
				{ collection: 'turn', row: run, action: 'create' },
				{
					collection: 'conversation_message',
					row: {
						id: directive.id,
						turn_id: runId,
						state: 'consumed',
						...(directiveMessage?.annotation == null || directiveMessage.annotation.tag === 'input'
							? {
									annotation: {
										tag: 'input',
										priority: directive.priority,
										consumedAfterSequence: lastSequence(messages)
									}
								}
							: {})
					}
				},
				{
					collection: 'conversation',
					row: { id: task.id, status: 'running', active_turn_id: runId }
				}
			]);
			return yield* Schema.decodeUnknownEffect(TurnRow)(run);
		});

		const fencedConversation = Effect.fn('Agents.fencedConversation')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn
		) {
			const task = yield* requireOwnedConversation(effectId, subject, run.conversation_id);
			/**
			 * The conversation's own status is the fence, and stopping is a write to it.
			 *
			 * A turn re-checks this at every boundary, which is what `control stop` relies on: it
			 * writes `stopped` and the turn in flight settles at its next boundary. Nothing reaches
			 * into a running invocation, so nothing had to be built to let it.
			 */
			if (
				task.active_turn_id !== run.id ||
				(task.status !== 'running' && task.status !== 'ready')
			) {
				return yield* new TaskRuntimeError({
					operation: 'fence',
					message: 'This turn no longer holds the conversation.'
				});
			}
			return task;
		});

		/**
		 * Steering: messages that arrived while this turn was working, taken at a boundary.
		 *
		 * There is no inbox to drain. A queued message is already a row in the transcript, so this
		 * marks the ones addressed to this turn's mode as consumed and stamps them with the run that
		 * is about to read them. The turn then sees them because it re-reads the transcript at the top
		 * of its next iteration.
		 */
		const consumeSteering = Effect.fn('Agents.consumeSteering')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn
		) {
			const task = yield* fencedConversation(effectId, subject, run);
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'conversation_message',
				where: {
					conversation_id: { eq: task.id },
					state: { eq: 'queued' },
					priority: { eq: 'steer' },
					mode: { eq: run.mode }
				},
				orderBy: { sequence: 'asc' },
				limit: 500
			});
			const steering = yield* decodeRows(Schema.Struct({ id: MessageId }), rows);
			if (steering.length === 0) return false;
			const messages = yield* messageRows(effectId, subject, task.id);
			const consumedAfterSequence = lastSequence(messages);
			// Delivery and its receipt are the same write, under the same fence: a retry cannot
			// deliver twice, and the conversation's own columns are unchanged by a delivery.
			yield* writeRows(
				EffectId.make(`${effectId}:inputs`),
				subject,
				'conversation_message',
				steering.map(({ id }) => ({
					id,
					turn_id: run.id,
					state: 'consumed',
					annotation: { tag: 'input', consumedAfterSequence }
				}))
			);
			return true;
		});

		const appendMessage = Effect.fn('Agents.appendMessage')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn,
			transcript: Transcript,
			author: Readonly<{ kind: 'agent' | 'tool' | 'system'; id?: string }>,
			message: Prompt.MessageEncoded,
			annotation?: MessageAnnotation
		) {
			const task = yield* fencedConversation(EffectId.make(`${effectId}:fence`), subject, run);
			const fingerprint = semanticHash({ runId: run.id, effectId, author, message, annotation });
			const existing = transcript.bySemanticHash(fingerprint);
			if (existing !== undefined) return existing;
			// A new sequence, so a fresh read: a message admitted into this conversation while the turn
			// was working holds a sequence this ledger has never seen.
			const current = yield* messageRows(effectId, subject, task.id);
			const row = {
				id: messageIdFor(`${task.id}:${fingerprint}`),
				conversation_id: task.id,
				sequence: lastSequence(current) + 1,
				turn_id: run.id,
				author,
				message,
				semantic_hash: fingerprint,
				...(annotation === undefined ? {} : { annotation })
			};
			yield* writeMessage(effectId, subject, row, 'create');
			const recorded = yield* Schema.decodeUnknownEffect(ConversationMessageRow)(row);
			transcript.record(recorded);
			return recorded;
		});

		/** Only an active, fenced generation may replace its in-progress message. Completed turns stay immutable. */
		const persistGeneration = Effect.fn('Agents.persistGeneration')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn,
			transcript: Transcript,
			authorId: string,
			progress: AIMessageProgress,
			annotation: MessageAnnotation | null
		) {
			const progressMessage = yield* Schema.decodeUnknownEffect(Prompt.Message)(progress.message);
			if (progressMessage.role !== 'assistant')
				return yield* new TaskRuntimeError({
					operation: 'generation',
					message: 'Only assistant parts may stream.'
				});
			if (
				new Set(progress.activeParts).size !== progress.activeParts.length ||
				progress.activeParts.some((index) => index >= progressMessage.content.length)
			)
				return yield* new TaskRuntimeError({
					operation: 'generation',
					message: 'Generation contains invalid active part indexes.'
				});
			const task = yield* fencedConversation(EffectId.make(`${effectId}:fence`), subject, run);
			const fingerprint = semanticHash({ runId: run.id, callId: progress.callId });
			const id = messageIdFor(`${task.id}:${fingerprint}`);
			const previous = transcript.byId(id);
			if (previous !== undefined && previous.annotation?.tag !== 'generation')
				return yield* new TaskRuntimeError({
					operation: 'generation',
					message: 'Completed generation is immutable.'
				});
			if (
				previous?.annotation?.tag === 'generation' &&
				progress.sequence <= previous.annotation.sequence
			) {
				if (
					progress.sequence === previous.annotation.sequence &&
					semanticHash(previous.message) === semanticHash(progress.message) &&
					semanticHash(previous.annotation) === semanticHash(annotation)
				)
					return;
				return yield* new TaskRuntimeError({
					operation: 'generation',
					message: 'Generation progress is out of order.'
				});
			}
			if (
				progress.sequence !==
				(previous?.annotation?.tag === 'generation' ? previous.annotation.sequence + 1 : 0)
			)
				return yield* new TaskRuntimeError({
					operation: 'generation',
					message: 'Generation progress skipped a boundary.'
				});
			if (previous?.annotation?.tag === 'generation' && previous.message.role === 'assistant') {
				const prior = previous.annotation;
				const previousMessage = yield* Schema.decodeUnknownEffect(Prompt.AssistantMessage)(
					previous.message
				);
				if (
					previousMessage.content.some(
						(part, index) =>
							!prior.activeParts.includes(index) &&
							(progress.activeParts.includes(index) ||
								semanticHash(part) !== semanticHash(progressMessage.content[index]))
					)
				)
					return yield* new TaskRuntimeError({
						operation: 'generation',
						message: 'Completed parts are immutable.'
					});
				if (
					annotation?.tag !== 'generation' &&
					(prior.activeParts.length !== 0 ||
						semanticHash(previous.message) !== semanticHash(progress.message))
				)
					return yield* new TaskRuntimeError({
						operation: 'generation',
						message: 'Final response must match completed stream parts.'
					});
			}
			// Parts after the first continue the row they already have, and read nothing at all — that
			// is the per-token-boundary cost this exists to remove.
			const sequence =
				previous?.sequence ?? lastSequence(yield* messageRows(effectId, subject, task.id)) + 1;
			const row = {
				id,
				conversation_id: task.id,
				sequence,
				turn_id: run.id,
				author: { kind: 'agent' as const, id: authorId },
				message: progress.message,
				semantic_hash: fingerprint,
				annotation
			};
			yield* writeMessage(effectId, subject, row, previous === undefined ? 'create' : 'update');
			transcript.record(yield* Schema.decodeUnknownEffect(ConversationMessageRow)(row));
		});

		const recordUsage = Effect.fn('Agents.recordUsage')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn,
			observation: ProviderObservation
		) {
			yield* fencedConversation(EffectId.make(`${effectId}:fence`), subject, run);
			yield* writeRows(
				EffectId.make(`${effectId}:usage`),
				subject,
				'turn_usage',
				[yield* usageMutation(run.id, observation)],
				'create'
			);
		});

		const updateRun = Effect.fn('Agents.updateRun')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn,
			input: Readonly<{
				taskStatus: Conversation['status'];
				runStatus: Turn['status'];
				phase: Turn['phase'];
				active: boolean;
				activePlanId?: PlanId | null;
			}>
		) {
			const task = yield* fencedConversation(EffectId.make(`${effectId}:fence`), subject, run);
			/**
			 * A conversation with a message still waiting is not done, whatever this turn thought. The
			 * question is asked of the transcript, because the transcript is the queue.
			 */
			const hasQueued =
				input.taskStatus === 'done' &&
				(yield* collections.findFirst(EffectId.make(`${effectId}:queued`), subject, {
					collection: 'conversation_message',
					where: { conversation_id: { eq: task.id }, state: { eq: 'queued' } }
				})) !== undefined;
			const taskStatus = hasQueued ? 'ready' : input.taskStatus;
			// The run's new state and the conversation's, together. Only `status` and `phase` are
			// stated: the immutable capability snapshot stays in storage, and the system read policy
			// deliberately does not expose it.
			yield* writeGraph(effectId, subject, [
				{ collection: 'turn', row: { id: run.id, status: input.runStatus, phase: input.phase } },
				{
					collection: 'conversation',
					row: {
						id: task.id,
						status: taskStatus,
						active_turn_id: input.active ? run.id : null,
						...(input.activePlanId === undefined ? {} : { active_plan_id: input.activePlanId })
					}
				}
			]);
			return taskStatus;
		});
		const settleRun = (
			effectId: EffectId,
			subject: Identity.Subject,
			run: Turn,
			taskStatus: Conversation['status'],
			phase: Turn['phase'],
			changes: Readonly<{ activePlanId?: PlanId | null }> = {}
		) =>
			updateRun(effectId, subject, run, {
				taskStatus,
				runStatus: 'succeeded',
				phase,
				active: false,
				...changes
			});

		const attachments = (
			messages: ReadonlyArray<ConversationMessage>,
			runId: TurnId
		): ReadonlyArray<ImageAsset> => {
			const assets: Array<ImageAsset> = [];
			for (const row of messages) {
				if (row.annotation?.tag === 'input' && row.annotation.consumedAfterSequence === undefined)
					continue;
				assets.push(...attachmentAssetsFromMessage(row.message));
				if (row.turn_id !== runId) continue;
				if (isString(row.message.content)) continue;
				for (const part of row.message.content) {
					if (part.type !== 'tool-result' || part.name !== 'use_image' || part.isFailure) continue;
					const decoded = Schema.decodeUnknownOption(ImageAsset)(part.result);
					if (decoded._tag === 'Some') assets.push(decoded.value);
				}
			}
			return assets;
		};

		/**
		 * Runs one child to a stop and returns the row it stopped at.
		 *
		 * `answerQueued` rather than `execute`, because a child may have more than one message
		 * waiting — a spawn followed by a `message` — and a parent that ran only the first would
		 * read an answer to half its instruction. Depth is not threaded: `conversationDepth` walks
		 * `parent_id`, so the child computes its own and the nesting limit bounds the tree without
		 * anything being carried.
		 *
		 * A child that will not settle is a defect, not a state: it would spin the parent's barrier,
		 * so it is refused by name instead.
		 */
		/**
		 * `answerQueued`, reachable from above it. The slot is what makes the recursion inferable.
		 *
		 * A parent runs its children, so `execute → childBarrier → runChild → answerQueued → execute`
		 * is a real cycle and inference has no base case in it. One written type is the base case.
		 *
		 * `unknown`, because that is what `execute` infers, and stating anything narrower here would
		 * be a claim this file cannot back. Two of the three sources are found and named — Effect's
		 * `Toolkit` dispatch contributes `AiError`, which `TurnFailure` now carries — but a third
		 * remains somewhere under `appendMessage`, and `Interface` has papered over it with an
		 * `as Interface` cast since long before the cycle existed. Narrowing it is worth doing and is
		 * not this change; a fictional union here would make the cast harder to find, not easier.
		 *
		 */
		let driveConversation: (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
			// repository-health:allow EFF11 -- the inferred channel of `execute`; narrowing it is
			// tracked in RFC/residual-gates.md, and a narrower claim here would be false today.
		) => Effect.Effect<TurnResult, unknown>;

		const runChild = Effect.fn('Agents.runChild')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			childId: ConversationId
		) {
			yield* driveConversation(EffectId.make(`${effectId}:answer`), subject, childId);
			const settled = yield* requireOwnedConversation(
				EffectId.make(`${effectId}:settled`),
				subject,
				childId
			);
			if (!isSettled(settled.status))
				return yield* new TaskRuntimeError({
					operation: 'children',
					message: `Child conversation ${childId} did not settle; it is ${settled.status}.`
				});
			return settled;
		});

		const childBarrier: (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation,
			messages: ReadonlyArray<ConversationMessage>
			// repository-health:allow EFF11 -- the other half of the recursion's base case; see
			// `driveConversation` above for why it cannot be narrower yet.
		) => Effect.Effect<
			Readonly<{ state: 'clear' } | { state: 'consume'; taskIds: ReadonlyArray<ConversationId> }>,
			unknown
		> = Effect.fn('Agents.childBarrier')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation,
			messages: ReadonlyArray<ConversationMessage>
		) {
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'conversation',
				where: { parent_id: { eq: task.id } },
				orderBy: { created_at: 'asc' },
				limit: 64
			});
			const children = yield* decodeRows(ConversationRow, rows);
			if (children.length === 0) return { state: 'clear' as const };
			const consumed = new Set<ConversationId>();
			for (const row of messages) {
				if (isString(row.message.content)) continue;
				for (const part of row.message.content) {
					if (part.type !== 'tool-result' || part.name !== 'subagent' || part.isFailure) continue;
					const result = Schema.decodeUnknownOption(ConsumedChildResult)(part.result);
					if (result._tag === 'Some') consumed.add(result.value.conversationId);
				}
			}
			/**
			 * A child that has not run is run here, by its parent, before the barrier judges it.
			 *
			 * Nothing else would. A spawned child is a conversation with a queued message and no
			 * caller sitting on it, and the runtime has exactly one driver of a turn — the request
			 * that admitted the message. The parent is that request, one level up, so the parent is
			 * the driver. This is what the durable occurrence used to be for, and the whole of what
			 * it was for: `enqueueExecute` existed to give a child and a woken parent a caller.
			 */
			for (const child of children.filter(({ status }) => !isSettled(status)))
				yield* runChild(EffectId.make(`${effectId}:child:${child.id}`), subject, child.id);
			const unconsumed = children.filter(({ id }) => !consumed.has(id));
			return unconsumed.length === 0
				? { state: 'clear' as const }
				: {
						state: 'consume',
						taskIds: unconsumed.map(({ id }) => id)
					};
		});

		const controlConversation = Effect.fn('Agents.controlConversation')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId,
			action: 'stop' | 'resume',
			modelId?: ModelId
		) {
			const task = yield* requireOwnedConversation(effectId, subject, conversationId);
			const agent = yield* resolveAgent(task.agent_id);
			yield* access.authorize(subject, 'agent', agent.id);
			if (action === 'resume') {
				if (task.status !== 'stopped' && task.status !== 'attention' && task.status !== 'failed') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: conversationId,
						reason: 'Only a stopped, attention or failed Task may resume'
					});
				}
				const previous = yield* collections.findFirst(
					EffectId.make(`${effectId}:previous-model`),
					subject,
					{
						collection: 'conversation_message',
						where: { conversation_id: { eq: conversationId }, model_id: { ne: null } },
						orderBy: { sequence: 'desc' }
					}
				);
				const prior = yield* Schema.decodeUnknownEffect(
					Schema.Struct({ model_id: Schema.optionalKey(Schema.NullOr(ModelId)) })
				)(previous ?? {});
				const selected = yield* selectModel(
					EffectId.make(`${effectId}:model`),
					modelId ?? prior.model_id ?? undefined
				);
				const result = yield* admit(effectId, subject, {
					conversationId,
					agentId: task.agent_id,
					message: systemMessage('Resume this Task from its durable transcript.'),
					author: { kind: 'system' },
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal'),
					resume: true,
					modelId: selected.id
				});
				// Explicit resume recalls the stopped objective and its cancelled queue as context.
				// Ordinary follow-ups keep cancelled instructions excluded.
				const history = yield* messageRows(effectId, subject, conversationId);
				const recalled = history
					.filter(
						(message) =>
							message.state === 'cancelled'
					)
					.map((message) => ({
						id: message.id,
						annotation: { ...message.annotation, consumedAfterSequence: lastSequence(history) }
					}));
				yield* writeRows(
					EffectId.make(`${effectId}:recall`),
					subject,
					'conversation_message',
					recalled
				);
				return {
					conversationId,
					status: 'ready',
					messageId: result.messageId
				};
			}
			const stoppingRun =
				task.active_turn_id === undefined || task.active_turn_id === null
					? undefined
					: yield* runById(EffectId.make(`${effectId}:stopping-run`), subject, task.active_turn_id);
			/**
			 * Stopping cancels what was waiting, and says so in one write.
			 *
			 * The run stops, every queued message leaves the queue cancelled, and the conversation
			 * stops — literally the same statement, so no two of them can disagree about whether the
			 * stop happened. The message the stopped turn was answering is cancelled with them: it was
			 * consumed but never answered, and a stop that left it looking answered would never offer
			 * it again.
			 */
			const cancelled = (yield* messageRows(effectId, subject, conversationId))
				.filter(
					(message) =>
						message.state === 'queued' ||
						(stoppingRun !== undefined && message.id === stoppingRun.input_message_id)
				)
				.map((message) => ({
					collection: 'conversation_message',
					row: { id: message.id, state: 'cancelled' }
				}));
			yield* writeGraph(effectId, subject, [
				...(stoppingRun === undefined
					? []
					: [{ collection: 'turn', row: { id: stoppingRun.id, status: 'stopped' } }]),
				...cancelled,
				{
					collection: 'conversation',
					row: { id: task.id, status: 'stopped', active_turn_id: null }
				}
			]);
			return { conversationId, status: 'stopped' as const };
		});

		const toolContext = (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation,
			run: Turn,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<ConversationMessage>
		): ToolExecutionContext => {
			const readableCollectionNames = reachableCollections(subject, 'read');
			const writableCollectionNames = reachableCollections(subject, 'write');
			return {
				effectId,
				subject,
				agentId: agent.id,
				conversationId: task.id,
				workbenchId: task.workbench_id,
				skills: allowedSkills(subject),
				toolNames: tools.map(({ name }) => name),
				collectionNames: [...new Set([...readableCollectionNames, ...writableCollectionNames])],
				readableCollectionNames,
				writableCollectionNames,
				workspace,
				collections,
				hostTools,
				...(task.todos == null ? {} : { previousTodo: task.todos })
			};
		};

		const isTodoSet = (params: unknown): boolean =>
			isObjectLike(params) && Reflect.get(params, 'operation') === 'set';

		const executeDeclaredTool = Effect.fn('Agents.executeDeclaredTool')(function* (
			declaration: ToolDeclaration,
			params: unknown,
			callId: string,
			subject: Identity.Subject,
			task: Conversation,
			run: Turn,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<ConversationMessage>
		) {
			const name = declaration.name;
			/**
			 * `todo` reconciles against what is stored *now*, not against the snapshot this turn began
			 * with. One assistant message can carry several `todo` calls, and the second has to see the
			 * first — which is the whole of done-is-terminal and single-doing. Only this tool needs it,
			 * so only this tool pays the read.
			 */
			const current =
				name === 'todo'
					? ((yield* conversationById(EffectId.make(`${run.id}:todos:${callId}`), subject, task.id)) ??
						task)
					: task;
			const context = toolContext(
				EffectId.make(`${run.id}:tool:${callId}`),
				subject,
				current,
				run,
				agent,
				tools,
				messages
			);
			if (isSystemTool(name)) {
				const result = yield* executeSystemTool(name, params, context);
				/**
				 * `todo set` is the one system tool that changes durable state, so it is the one that
				 * writes. The catalog validated the replacement against what is stored and handed back
				 * the list to store; persisting it here keeps every write in the runtime, where write
				 * authority lives, rather than giving the catalog a database.
				 */
				if (name === 'todo' && isTodoSet(params))
					yield* writeConversation(EffectId.make(`${context.effectId}:todos`), subject, {
						id: task.id,
						todos: result as Schema.Json
					});
				return result;
			}
			if (name === 'subagent') {
				const depth = yield* conversationDepth(EffectId.make(`${context.effectId}:depth`), subject, task);
				const subagent: SubagentContext<unknown> = {
					effectId: context.effectId,
					subject,
					workbenchId: task.workbench_id,
					agentId: agent.id,
					conversationId: task.id,
					isChild: depth > 0,
					spawnableAgentIds: spawnableAgentIds(workspace.definition),
					collections,
					budget: InvocationBudget.make(depth, InvocationBudget.DEFAULT_NESTING_LIMIT),
					spawn: (actionId, childAgentId, instruction, _depth, toolCallId) =>
						Effect.gen(function* () {
							const childId = conversationIdFor(`${run.id}:${toolCallId}`);
							const submitted = yield* admit(actionId, subject, {
								conversationId: childId,
								agentId: childAgentId,
								message: parentAgentInput(task.id, instruction),
								author: { kind: 'parent-agent', id: task.id },
								mode: DirectiveMode.make('agent'),
								parent: task,
								modelId: run.model_id
							});
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								conversationId: childId,
								messageId: submitted.messageId,
								state: 'running'
							});
						}),
					admit: (actionId, targetId, message) =>
						Effect.gen(function* () {
							const target = yield* requireOwnedConversation(actionId, subject, targetId);
							const submitted = yield* admit(actionId, subject, {
								conversationId: target.id,
								agentId: target.agent_id,
								message: parentAgentInput(task.id, message),
								author: { kind: 'parent-agent', id: task.id },
								mode: DirectiveMode.make('agent'),
								modelId: run.model_id
							});
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								conversationId: target.id,
								messageId: submitted.messageId,
								state: 'queued'
							});
						}),
					awaitTarget: (actionId, childId) =>
						Effect.gen(function* () {
							// Awaiting a child runs it, here, now. There is no park and nothing to wake.
							const child = yield* requireOwnedConversation(actionId, subject, childId);
							const settled = isSettled(child.status)
								? child
								: yield* runChild(actionId, subject, child.id);
							const childMessages = yield* messageRows(actionId, subject, settled.id);
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								state: settled.status,
								conversationId: settled.id,
								message: childMessages.at(-1)?.message ?? null
							});
						}),
					control: (actionId, childId, action) =>
						controlConversation(actionId, subject, childId, action).pipe(
							Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Json)(result))
						)
				};
				return yield* executeSubagentTool(params, subagent, callId);
			}
			const input = yield* Schema.decodeUnknownEffect(Schema.Json)(params).pipe(
				Effect.mapError((error) => invalidToolInput(name, error))
			);
			if (declaration.mcp !== undefined) {
				const mcp = declaration.mcp;
				const result = yield* callMcpTool(mcp, input, context.effectId, connector);
				return yield* Schema.decodeUnknownEffect(Schema.Json)(result).pipe(
					Effect.mapError(
						() =>
							new McpToolError({
								server: mcp.server,
								tool: mcp.tool,
								reason: 'invalid-response',
								detail: 'The official MCP result could not be encoded as durable JSON.'
							})
					)
				);
			}
			const authored = yield* remotes.invoke(name, input, subject, context.effectId).pipe(
				Effect.map((value) => ({ found: true, value })),
				Effect.catch((error) =>
					error instanceof DispatchError && error.code === 'unknown_command'
						? Effect.succeed({ found: false, value: null })
						: Effect.fail(error)
				)
			);
			if (authored.found) return authored.value;
			if (name.startsWith('sandbox_') || declaration.command.startsWith('host:')) {
				return yield* executeHostTool(name, input, context);
			}
			return yield* new ToolNotAllowed({ agent: agent.id, tool: name });
		});

		const handledTool = Effect.fn('Agents.handledTool')(function* (
			call: EncodedToolCall,
			subject: Identity.Subject,
			task: Conversation,
			run: Turn,
			agent: ResolvedAgent,
			declarations: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<ConversationMessage>
		) {
			const declaration = declarations.find(({ name }) => name === call.name);
			if (declaration === undefined) {
				return {
					encodedResult: describeFailure(new ToolNotAllowed({ agent: agent.id, tool: call.name })),
					isFailure: true
				};
			}
			const tool = Tool.dynamic(declaration.name, {
				description: declaration.description,
				parameters: declaration.inputSchema ?? EmptyToolInput,
				success: Schema.Json,
				failure: ToolFailure,
				failureMode: 'return'
			});
			const toolkit = Toolkit.make(tool);
			const handlers = Object.fromEntries([
				[
					declaration.name,
					(params: unknown, context: Readonly<{ readonly toolCallId?: string | undefined }>) =>
						executeDeclaredTool(
							declaration,
							params,
							context.toolCallId ?? call.id,
							subject,
							task,
							run,
							agent,
							declarations,
							messages
						).pipe(
							Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Json)(result)),
							Effect.mapError(describeFailure)
						)
				]
			]);
			const ready = yield* toolkit.pipe(Effect.provide(toolkit.toLayer(handlers)));
			const resultStream = yield* ready.handle(call.name, call.params, call.id);
			const results = yield* resultStream.pipe(Stream.runCollect);
			const final = results.at(-1);
			if (final === undefined) {
				return yield* new TaskRuntimeError({
					operation: 'tool',
					message: `Effect Toolkit produced no final result for ${call.name}.`
				});
			}
			return final;
		});

		const finishRun = Effect.fn('Agents.finishRun')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: Conversation,
			run: Turn,
			output: Prompt.MessageEncoded,
			transcript: Transcript
		) {
			const messages = transcript.rows();
			if (run.mode === 'plan') {
				const body = (
					isString(output.content)
						? output.content
						: output.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
				).trim();
				if (body === '') {
					return yield* new TaskRuntimeError({
						operation: 'plan',
						message: 'Plan mode returned an empty Plan body.'
					});
				}
				const current = yield* activePlan(effectId, subject, task);
				const revision = (current?.revision ?? 0) + 1;
				const planId = planIdFor(`${task.id}:${revision}:${semanticHash(body)}`);
				if (current !== undefined && (current.status === 'active' || current.status === 'stalled'))
					yield* writeRows(EffectId.make(`${effectId}:supersede`), subject, 'plan', [
						{ id: current.id, status: 'superseded' }
					]);
				yield* writeRows(
					EffectId.make(`${effectId}:plan`),
					subject,
					'plan',
					[
						{
							id: planId,
							conversation_id: task.id,
							revision,
							checkpoint_sequence: lastSequence(messages),
							body,
							status: 'active'
						}
					],
					'create'
				);
				yield* settleRun(effectId, subject, run, 'ready', 'model', { activePlanId: planId });
				return 'idle';
			}
			if (run.mode === 'compact') {
				yield* settleRun(effectId, subject, run, 'ready', 'model');
				return 'idle';
			}
			const plan = yield* activePlan(effectId, subject, task);
			if (plan !== undefined && plan.status === 'active') {
				const priorAttempts = messages.filter(
					(message) =>
						message.annotation?.tag === 'plan-verdict' && message.annotation.planId === plan.id
				).length;
				const attempt = priorAttempts + 1;
				const agent = yield* resolveAgent(task.agent_id);
				yield* updateRun(EffectId.make(`${effectId}:verify-start`), subject, run, {
					taskStatus: 'running',
					runStatus: 'running',
					phase: 'verify',
					active: true
				});
				const verificationMessages = [
					...projectPrompt({
						workspacePrompt: workspace.definition.prompt,
						...(agent.instruction === undefined ? {} : { agentInstruction: agent.instruction }),
						mode: 'agent' as const,
						messages,
						activePlan: plan
					}),
					systemMessage(
						[
							'Independently verify the immutable active Plan against the durable transcript, tool receipts, child results, and final implementing response.',
							'Do not trust completion claims. Mark complete only when every verification criterion is evidenced.',
							'Give a concise summary and list every concrete remaining gap.'
						].join('\n')
					)
				];
				const verified = yield* Effect.gen(function* () {
					const metadata = yield* ExecutionPlan.CurrentMetadata;
					const callId = providerCallIdFor(`${run.id}:verify:${attempt}:${metadata.attempt}`);
					return yield* generatePlanVerdict(
						ai,
						EffectId.make(`${effectId}:verification:${attempt}:${metadata.attempt}`),
						{
							callId,
							modelId: run.model_id,
							messages: verificationMessages,
							maxOutputTokens: PLAN_VERIFICATION_OUTPUT_TOKENS
						}
					);
				}).pipe(Effect.withExecutionPlan(planVerificationExecutionPlan));
				yield* recordUsage(
					EffectId.make(`${effectId}:verification-usage:${attempt}`),
					subject,
					run,
					verified.observation
				);
				const annotation = {
					tag: 'plan-verdict' as const,
					planId: plan.id,
					complete: verified.verdict.complete,
					gaps: verified.verdict.gaps
				};
				const verdictMessage = systemMessage(
					[
						`Plan verification ${attempt}/${MAX_PLAN_VERIFICATION_ATTEMPTS}: ${verified.verdict.complete ? 'complete' : 'incomplete'}.`,
						verified.verdict.summary,
						...(verified.verdict.gaps.length === 0
							? []
							: verified.verdict.gaps.map((gap) => `- ${gap}`))
					].join('\n')
				);
				if (verified.verdict.complete || attempt >= MAX_PLAN_VERIFICATION_ATTEMPTS) {
					yield* appendMessage(
						EffectId.make(`${effectId}:verdict:${attempt}`),
						subject,
						run,
						transcript,
						{ kind: 'system' },
						verdictMessage,
						annotation
					);
					const complete = verified.verdict.complete;
					yield* writeRows(EffectId.make(`${effectId}:verdict-plan:${attempt}`), subject, 'plan', [
						{ id: plan.id, status: complete ? 'verified' : 'stalled' }
					]);
					const status = yield* settleRun(
						effectId,
						subject,
						run,
						complete ? 'done' : 'attention',
						'verify'
					);
					return status === 'ready' ? 'idle' : complete ? 'done' : 'attention';
				}
				yield* admit(EffectId.make(`${effectId}:continue:${attempt}`), subject, {
					conversationId: task.id,
					agentId: task.agent_id,
					message: verdictMessage,
					author: { kind: 'system' },
					mode: 'agent',
					priority: 'normal',
					annotation,
					runId: run.id,
					modelId: run.model_id
				});
				yield* settleRun(effectId, subject, run, 'ready', 'verify');
				return 'idle';
			}
			const status = yield* settleRun(effectId, subject, run, 'done', 'model');
			return status === 'ready' ? 'idle' : 'done';
		});

		const execute = Effect.fn('Agents.execute')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			let task = yield* requireOwnedConversation(EffectId.make(`${effectId}:task`), subject, conversationId);
			const run = yield* claim(EffectId.make(`${effectId}:claim`), subject, task);
			if (run === undefined) return { conversationId, status: 'idle' } satisfies TurnResult;
			const agent = yield* resolveAgent(task.agent_id);
			const allTools = yield* allowedTools(
				EffectId.make(`${effectId}:host-capabilities`),
				subject,
				agent
			);
			const toolsForMode =
				run.mode === 'compact'
					? []
					: run.mode === 'plan'
						? allTools.filter(
								(tool) =>
									tool.hostReadOnly === true ||
									[
										'describe_workspace',
										'list_skills',
										'read_skill',
										'search_task_history',
										'use_image',
										'read_collection'
									].includes(tool.name)
							)
						: allTools;
			let output: Prompt.MessageEncoded | undefined;
			/**
			 * How many times the loop has told the model to consume a child before letting it finish.
			 *
			 * The nudge is the only pressure left once children run inline — a child always settles,
			 * so `waiting` can never end the loop — and a model that will not take the hint would
			 * otherwise spin here forever. It is bounded rather than trusted; the child's answer is in
			 * the transcript either way, so finishing without the explicit `await` loses nothing but
			 * the acknowledgement.
			 */
			let nudges = 0;
			let emptyReplies = 0;
			/**
			 * The provider's own count from the last call, which is what the next call will carry in.
			 *
			 * Seeded from the newest observation this conversation already has, not from zero. A turn
			 * inherits the transcript that grew it, so a fresh turn on a long conversation is exactly
			 * the case that needs to compact *before* its first call rather than after a provider
			 * refusal — and starting at zero would send that call and find out the hard way.
			 */
			let usedTokens = observedTokens(
				(yield* latestObservation(EffectId.make(`${effectId}:tokens`), subject, conversationId))
					?.usage
			);
			/** Set when the agent calls `compact` on itself; cleared once the checkpoint is written. */
			let compactRequested = false;
			/**
			 * The two budgets are separate because the two callers are.
			 *
			 * The runtime gets one automatic checkpoint per turn: a turn still over the bound after
			 * compacting has nothing left that a summary of a summary would shrink, and looping would
			 * spend a provider call per iteration on a Task that can no longer finish. The agent gets
			 * a few, because it is reorganizing rather than surviving a limit, and each request is a
			 * deliberate act with a reason attached — but it is bounded all the same, since a model
			 * that compacts every step makes no progress.
			 */
			let automaticCompactions = 0;
			let requestedCompactions = 0;
			const runEffect = Effect.gen(function* () {
				for (let iteration = 0; ; iteration += 1) {
					task = yield* fencedConversation(EffectId.make(`${effectId}:fence:${iteration}`), subject, run);
					yield* consumeSteering(EffectId.make(`${effectId}:steer:${iteration}`), subject, run);
					/**
					 * One read per iteration, and the turn's only one. Every write below records itself
					 * into the ledger, so the re-reads that used to follow each of them are gone.
					 * `consumeSteering` above can still write outside it, which is why this is rebuilt
					 * per iteration rather than per turn; when the inbox goes, so does the rebuild.
					 */
					const transcript = makeTranscript(
						yield* messageRows(
							EffectId.make(`${effectId}:messages:${iteration}`),
							subject,
							task.id
						)
					);
					let messages = transcript.rows();
					let calls = unresolvedToolCalls(messages);
					if (calls.length === 0) {
						const plan = yield* activePlan(
							EffectId.make(`${effectId}:plan:${iteration}`),
							subject,
							task
						);
						let assets = attachments(promptMessages(messages, plan), run.id);
						yield* validateAttachments(task.id, assets);
						let projected = projectPrompt({
							workspacePrompt: workspace.definition.prompt,
							...(agent.instruction === undefined ? {} : { agentInstruction: agent.instruction }),
							mode: run.mode,
							messages,
							...(plan === undefined ? {} : { activePlan: plan })
						});
						/**
						 * One automatic checkpoint per submitted turn, because one directive claims one
						 * run: a turn that is still over the bound after compacting has nothing left to
						 * summarize that a second summary of a summary would shrink, and looping here
						 * would spend a provider call per iteration on a Task that can no longer finish.
						 */
						const bound = Math.floor(run.context_window_tokens * COMPACT_AT_FRACTION_OF_WINDOW);
						const tokens = Math.max(usedTokens, estimatedTokens(projected));
						const overBound = tokens > bound;
						const requested = compactRequested;
						compactRequested = false;
						const affordable = requested
							? requestedCompactions < MAX_REQUESTED_COMPACTIONS_PER_TURN
							: automaticCompactions < 1;
						if (run.mode === 'agent' && (requested || overBound) && affordable) {
							const origin = requested ? 'requested' : 'automatic';
							if (requested) requestedCompactions += 1;
							else automaticCompactions += 1;
							const currentInput = messages.findLast(
								(message) =>
									message.sequence <= run.input_through_sequence &&
									(message.author.kind === 'human' ||
										message.author.kind === 'parent-agent' ||
										message.author.kind === 'system')
							);
							const retainedMessageIds = [
								...new Set([
									...(currentInput === undefined ? [] : [currentInput.id]),
									...messages.filter(({ turn_id }) => turn_id === run.id).map(({ id }) => id)
								])
							];
							const compacted = yield* generateMessage(
								ai,
								EffectId.make(`${effectId}:compact-provider:${iteration}`),
								{
									callId: providerCallIdFor(`${run.id}:compact:${lastSequence(messages)}`),
									modelId: run.model_id,
									/**
									 * The instruction is the final user turn, not a trailing system message. A
									 * projection that ends in tool results followed by a system line reads to a
									 * chat template as an interrupted tool loop, and the model resumes the loop:
									 * the hr-payroll host recorded a checkpoint whose whole text was the model's
									 * native tool-call markup. A user turn is a turn to answer.
									 */
									messages: [
										...projected,
										userAgentInput(
											`${origin === 'requested' ? 'Requested' : 'Automatic'} Compact: summarize the durable context needed to continue this Task. Preserve decisions, constraints, unresolved work, tool evidence, child outcomes, and the current user instruction. Do not perform new work.`
										)
									],
									maxOutputTokens: AUTO_COMPACT_OUTPUT_TOKENS,
									...generationAssets(assets)
								}
							);
							yield* recordUsage(
								EffectId.make(`${effectId}:compact-usage:${iteration}`),
								subject,
								run,
								compacted.observation
							);
							usedTokens = observedTokens(compacted.observation.usage);
							yield* appendMessage(
								EffectId.make(`${effectId}:compact:${iteration}`),
								subject,
								run,
								transcript,
								{ kind: 'agent', id: agent.id },
								checkpointContent(compacted.message),
								{
									tag: 'compact',
									origin,
									cutoff: Math.max(0, ...messages.map(contextSequence)),
									retainedMessageIds
								}
							);
							messages = transcript.rows();
							assets = attachments(promptMessages(messages, plan), run.id);
							projected = projectPrompt({
								workspacePrompt: workspace.definition.prompt,
								...(agent.instruction === undefined ? {} : { agentInstruction: agent.instruction }),
								mode: run.mode,
								messages,
								...(plan === undefined ? {} : { activePlan: plan })
							});
							/**
							 * Degraded, not failed, and said immediately.
							 *
							 * The checkpoint has been written and the projection rebuilt over it, so this is
							 * the moment the runtime knows whether compacting helped. Refusing the turn here
							 * would brick every long conversation whose retained material alone exceeds the
							 * bound, so the turn proceeds and the condition is recorded the way every other
							 * degraded outcome is: one canonical message carrying this run's id.
							 */
							const residual = estimatedTokens(projected);
							if (!requested && residual > bound) {
								yield* appendMessage(
									EffectId.make(`${effectId}:compact-residual:${iteration}`),
									subject,
									run,
									transcript,
									{ kind: 'system' },
									systemMessage(
										`Automatic Compact left the context at ${residual} tokens against a bound of ${bound}. This turn proceeds over the compacted projection without a second checkpoint.`
									)
								);
								messages = transcript.rows();
								projected = projectPrompt({
									workspacePrompt: workspace.definition.prompt,
									...(agent.instruction === undefined
										? {}
										: { agentInstruction: agent.instruction }),
									mode: run.mode,
									messages,
									...(plan === undefined ? {} : { activePlan: plan })
								});
							}
						} else if (requested) {
							/**
							 * A refusal the agent can read, once.
							 *
							 * A request that silently does nothing is worse than one that is refused: the
							 * model asked for a checkpoint, and if it is not told the answer is no it will
							 * ask again every step. `requestedCompactions` keeps counting past the limit, so
							 * this fires on the first refusal and never again.
							 */
							requestedCompactions += 1;
							if (requestedCompactions === MAX_REQUESTED_COMPACTIONS_PER_TURN + 1) {
								yield* appendMessage(
									EffectId.make(`${effectId}:compact-refused:${iteration}`),
									subject,
									run,
									transcript,
									{ kind: 'system' },
									systemMessage(
										`Compact was requested more than ${MAX_REQUESTED_COMPACTIONS_PER_TURN} times in one turn and is refused for the rest of it. Continue from the checkpoints already written.`
									)
								);
								messages = transcript.rows();
								projected = projectPrompt({
									workspacePrompt: workspace.definition.prompt,
									...(agent.instruction === undefined
										? {}
										: { agentInstruction: agent.instruction }),
									mode: run.mode,
									messages,
									...(plan === undefined ? {} : { activePlan: plan })
								});
							}
						}
						/**
						 * The call is named by where the transcript stood when it was made, not by the loop
						 * counter, because the counter restarts.
						 *
						 * A parent that parks on a child leaves `runEffect` and re-enters it on the wake with
						 * the same turn and `iteration` back at 0. Two distinct provider calls then minted one
						 * `call_id`, and the usage row for the second silently overwrote the first — a billable
						 * observation lost with no failure anywhere. The sequence only ever advances, because
						 * every generation appends the message it produced.
						 */
						const callId = providerCallIdFor(`${run.id}:${lastSequence(messages)}`);
						let progressSequence = -1;
						const provided = yield* generateMessage(
							ai,
							EffectId.make(`${effectId}:provider:${iteration}`),
							{
								callId,
								modelId: run.model_id,
								messages: projected,
								// Reasoning shares the output allowance with source edits and tool arguments.
								maxOutputTokens: 16_384,
								tools: toolsForMode,
								onProgress: (progress) =>
									Effect.gen(function* () {
										if (progress.callId !== callId)
											return yield* new TaskRuntimeError({
												operation: 'generation',
												message: 'Progress belongs to another provider call.'
											});
										yield* persistGeneration(
											EffectId.make(`${effectId}:part:${iteration}:${progress.sequence}`),
											subject,
											run,
											transcript,
											agent.id,
											progress,
											{
												tag: 'generation',
												callId,
												sequence: progress.sequence,
												activeParts: progress.activeParts
											}
										);
										progressSequence = progress.sequence;
									}),
								...generationAssets(assets)
							}
						);
						yield* recordUsage(
							EffectId.make(`${effectId}:usage:${iteration}`),
							subject,
							run,
							provided.observation
						);
						usedTokens = observedTokens(provided.observation.usage);
						const generated = { message: provided.message };
						const annotation: MessageAnnotation | undefined =
							run.mode === 'compact'
								? {
										tag: 'compact',
										origin: 'manual',
										cutoff: Math.max(0, ...messages.map(contextSequence)),
										retainedMessageIds: []
									}
								: undefined;
						if (progressSequence >= 0)
							yield* persistGeneration(
								EffectId.make(`${effectId}:assistant:${iteration}`),
								subject,
								run,
								transcript,
								agent.id,
								{
									callId,
									sequence: progressSequence + 1,
									message: generated.message,
									activeParts: []
								},
								annotation ?? null
							);
						else
							yield* appendMessage(
								EffectId.make(`${effectId}:assistant:${iteration}`),
								subject,
								run,
								transcript,
								{ kind: 'agent', id: agent.id },
								generated.message,
								annotation
							);
						output = generated.message;
						calls = toolCalls(generated.message);
						messages = transcript.rows();
					}
					if (calls.length === 0 && output !== undefined) {
						if (
							!Schema.decodeUnknownSync(Prompt.AssistantMessage)(output).content.some(
								(part) => part.type === 'file' || (part.type === 'text' && part.text.trim() !== '')
							)
						) {
							if (emptyReplies++ > 0)
								return yield* new TaskRuntimeError({
									operation: 'generate',
									message: 'The model returned no answer or tool call after a continuation.'
								});
							yield* appendMessage(
								EffectId.make(`${effectId}:empty-reply:${iteration}`),
								subject,
								run,
								transcript,
								{ kind: 'system' },
								systemMessage(
									'Your previous generation contained no answer or tool call. Continue the requested work with a tool call, or give a concrete answer. Keep source edits to small batches.'
								)
							);
							output = undefined;
							continue;
						}
						if (
							yield* consumeSteering(
								EffectId.make(`${effectId}:final-steer:${iteration}`),
								subject,
								run
							)
						) {
							output = undefined;
							continue;
						}
						const barrier = yield* childBarrier(
							EffectId.make(`${effectId}:children:${iteration}`),
							subject,
							task,
							messages
						);
						if (barrier.state === 'consume' && nudges < MAX_CHILD_CONSUME_NUDGES) {
							nudges += 1;
							yield* appendMessage(
								EffectId.make(`${effectId}:children-required:${iteration}`),
								subject,
								run,
								transcript,
								{ kind: 'system' },
								systemMessage(
									`Consume required child Tasks with subagent await before finishing: ${barrier.taskIds.join(', ')}`
								)
							);
							output = undefined;
							continue;
						}
						const status = yield* finishRun(effectId, subject, task, run, output, transcript);
						return { conversationId, status, output } satisfies TurnResult;
					}
					for (const call of calls) {
						yield* fencedConversation(EffectId.make(`${effectId}:tool-fence:${call.id}`), subject, run);
						const handled = yield* handledTool(
							call,
							subject,
							task,
							run,
							agent,
							toolsForMode,
							messages
						);
						yield* appendMessage(
							EffectId.make(`${effectId}:tool-result:${call.id}`),
							subject,
							run,
							transcript,
							{ kind: 'tool', id: call.name },
							toolResultMessage(call, handled.encodedResult, handled.isFailure)
						);
						// The `compact` tool records intent and returns; this is where the loop hears it.
						// Read off the calls it just ran rather than signalled back through the tool
						// context, so there is no second copy of the fact to keep in agreement.
						if (call.name === 'compact' && !handled.isFailure) compactRequested = true;
						messages = transcript.rows();
					}
				}
			});
			/**
			 * The turn settles whichever way it ends. An interruption is not an error, so a `tapError`
			 * finaliser skipped it and the conversation stayed `running` with nothing left to move it;
			 * `onExit` sees every exit and runs uninterruptibly. Each write is logged rather than ignored,
			 * because a status write that fails here is exactly a panel showing work that is not happening.
			 * A stop that already wrote `stopped` refuses both writes at the fence, which is the right answer.
			 */
			return yield* runEffect.pipe(
				/**
				 * A turn that lost the fence is over, not broken. `control stop` writes `stopped` and
				 * the turn in flight meets it at its next boundary; reporting that meeting as a failure
				 * made every deliberate Stop a `dispatch_failed` 500 in the host's error log. The
				 * conversation row already says what happened, so the caller is told it settled.
				 */
				Effect.catchIf(
					(error): error is TaskRuntimeError =>
						error instanceof TaskRuntimeError && error.operation === 'fence',
					() =>
						Effect.logInfo(`Turn ${run.id} ended at the fence: the conversation was stopped.`).pipe(
							Effect.as({ conversationId, status: 'done' } satisfies TurnResult)
						)
				),
				Effect.onExit((exit) => {
					if (Exit.isSuccess(exit)) return Effect.void;
					const sentence = Cause.hasInterruptsOnly(exit.cause)
						? 'The turn was interrupted.'
						: describeFailure(Cause.squash(exit.cause)).message;
					const logged = <A, E>(write: Effect.Effect<A, E>, what: string) =>
						write.pipe(
							Effect.catchCause((cause) =>
								Effect.logWarning(`Turn ${run.id} could not ${what}: ${Cause.pretty(cause)}`)
							)
						);
					// The turn is over and its ledger is out of scope; a failing turn pays one read for
					// the one message it still has to write.
					return logged(
						messageRows(EffectId.make(`${effectId}:failed-messages`), subject, conversationId).pipe(
							Effect.map(makeTranscript),
							Effect.flatMap((failedTranscript) =>
								appendMessage(
									EffectId.make(`${effectId}:failed-message`),
									subject,
									run,
									failedTranscript,
									{ kind: 'system' },
									systemMessage(`Task failed: ${sentence.slice(0, 500)}`)
								)
							)
						),
						'record its failure'
					).pipe(
						Effect.andThen(
							logged(
								updateRun(EffectId.make(`${effectId}:failed`), subject, run, {
									taskStatus: 'failed',
									runStatus: 'failed',
									phase: 'model',
									active: false
								}),
								'leave running'
							)
						)
					);
				})
			);
		});

		/**
		 * Answers the message a caller just sent, and everything else the conversation has waiting.
		 *
		 * `execute` answers exactly one message, which is the right primitive: an envoy or a schedule
		 * runs the turn it came for and nothing else. A person, though, is holding a response open,
		 * and a conversation that settles with another message still queued would sit there until
		 * somebody called again — which is what the durable work occurrence used to be for. This is
		 * what replaced it.
		 *
		 * The first turn is unconditional. Driving it from the queue read would let a caller who
		 * cannot see the row admit a message and then run nothing, which is a silent non-answer
		 * rather than a visible refusal; the drain after it degrades to one turn when the queue is
		 * unreadable, which is the old behaviour and never worse. It terminates because a turn
		 * consumes the message it was started for, and a turn that leaves the head of the queue
		 * untouched ends the loop rather than spinning on work it has already declined.
		 */
		const answerQueued = Effect.fn('Agents.answerQueued')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			conversationId: ConversationId
		) {
			const queuedHead = Effect.fn('Agents.queuedHead')(function* (id: EffectId) {
				const row = yield* collections.findFirst(id, subject, {
					collection: 'conversation_message',
					where: { conversation_id: { eq: conversationId }, state: { eq: 'queued' } },
					orderBy: { priority: 'desc', sequence: 'asc' }
				});
				return row === undefined ? undefined : String(row['id']);
			});
			const settled = yield* execute(
				EffectId.make(`${effectId}:turn:0`),
				subject,
				conversationId
			);
			let head = yield* queuedHead(EffectId.make(`${effectId}:queued:0`));
			for (let turn = 1; head !== undefined; turn += 1) {
				yield* execute(EffectId.make(`${effectId}:turn:${turn}`), subject, conversationId);
				const next = yield* queuedHead(EffectId.make(`${effectId}:queued:${turn}`));
				if (next === head) break;
				head = next;
			}
			return settled;
		});

		driveConversation = answerQueued;

		const control = Effect.fn('Agents.control')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: ConversationControlRequest
		) {
			const result = yield* controlConversation(
				effectId,
				subject,
				request.conversationId,
				request.action,
				request.modelId
			);
			return {
				conversationId: request.conversationId,
				status: yield* Schema.decodeUnknownEffect(ConversationStatus)(result.status)
			} satisfies ConversationControlResult;
		});

		return Service.of({
			models,
			submit,
			editMessage,
			control,
			execute: (effectId, subject, conversationId) => execute(effectId, subject, conversationId),
			answerQueued: (effectId, subject, conversationId) =>
				answerQueued(effectId, subject, conversationId)
			// The cast `Interface` has always carried: its declared error union is narrower than what
			// the implementation infers. Pre-existing, and named here rather than left silent.
		} as Interface);
	})
);
