import { Clock, Context, Effect, ExecutionPlan, Layer, Schema, Stream } from 'effect';
import { Prompt, Tool, Toolkit } from 'effect/unstable/ai';
import { EffectId, ReleaseId } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveId,
	DirectiveMode,
	DirectivePriority,
	ExactCharge,
	ImageAsset,
	MessageId,
	ModelId,
	PlanId,
	type PlanVerdict,
	ProviderCallId,
	type ProviderObservation,
	RunId,
	RunPhase,
	RunStatus,
	SubjectId,
	TaskAudience,
	TaskId,
	TaskStatus,
	UsageObservation,
	WorkbenchId
} from '@norbital-ai/bolt-protocol/facilities';
import {
	imageAssetsFromMessage,
	stripImageFileParts,
	taskAssetKeyPrefix,
	taskAssetStorageKey as taskScopedImageKey
} from './image-descriptors.js';
import {
	type TaskControlRequest,
	type TaskControlResult,
	type TaskEditMessageRequest,
	type TaskEditMessageResult,
	type TaskSubmitRequest,
	type TaskSubmitResult
} from '@norbital-ai/bolt-protocol/system';
import type { ToolDeclaration } from '#lib/authoring/workspace-schema.js';
import { WEB_AGENT_NAME } from '#lib/authoring/workspace-schema.js';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { RemoteRegistry } from '#lib/runtime/collections/authored.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import {
	AI,
	Connector,
	HostTools,
	Tasks,
	type AIInterface
} from '#lib/runtime/facilities/services.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import * as InvocationBudget from '#lib/runtime/budget.js';
import {
	AgentModelUnavailable,
	McpToolError,
	SkillError,
	ToolNotAllowed,
	callMcpTool,
	executeHostTool,
	executeSystemTool,
	executeSubagentTool,
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
	McpToolError,
	SkillError,
	ToolNotAllowed
} from './capability-catalog.js';

class TaskRuntimeError extends Schema.TaggedError<TaskRuntimeError>()(
	'Bolt.TaskRuntime.Error',
	{ operation: Schema.NonEmptyString, message: Schema.NonEmptyString }
) {
	readonly category = 'task-runtime' as const;
	readonly retryable = false;
}

const CapabilityId = Schema.String.check(
	Schema.isPattern(/^(?:system|host|tenant|personal)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
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
	Schema.Struct({
		tag: Schema.Literal('compact'),
		origin: Schema.Literals(['manual', 'automatic']),
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

export const AgentTaskRow = Schema.Struct({
	id: TaskId,
	workbench_id: WorkbenchId,
	subject_id: SubjectId,
	agent_id: AgentId,
	audience: TaskAudience,
	parent_id: Schema.optionalKey(Schema.NullOr(TaskId)),
	status: TaskStatus,
	active_plan_id: Schema.optionalKey(Schema.NullOr(PlanId)),
	active_run_id: Schema.optionalKey(Schema.NullOr(RunId)),
	epoch: Schema.Natural
});
type AgentTask = typeof AgentTaskRow.Type;

export const AgentPlanRow = Schema.Struct({
	id: PlanId,
	task_id: TaskId,
	revision: Schema.Natural,
	checkpoint_sequence: Schema.Natural,
	body: Schema.NonEmptyString,
	status: Schema.Literals(['active', 'verified', 'stalled', 'superseded'])
});
type AgentPlan = typeof AgentPlanRow.Type;

export const AgentMessageRow = Schema.Struct({
	id: MessageId,
	task_id: TaskId,
	sequence: Schema.Natural,
	run_id: Schema.optionalKey(Schema.NullOr(RunId)),
	author: Schema.Struct({
		kind: Schema.Literals(['human', 'agent', 'parent-agent', 'tool', 'system']),
		id: Schema.optionalKey(Schema.NonEmptyString)
	}),
	message: Schema.toEncoded(Prompt.Message),
	semantic_hash: Schema.NonEmptyString,
	annotation: Schema.optionalKey(Schema.NullOr(MessageAnnotation)),
	supersedes_id: Schema.optionalKey(Schema.NullOr(MessageId))
});
export type AgentMessage = typeof AgentMessageRow.Type;

export const AgentRunRow = Schema.Struct({
	id: RunId,
	task_id: TaskId,
	directive_id: DirectiveId,
	epoch: Schema.Natural,
	mode: DirectiveMode,
	phase: RunPhase,
	input_through_sequence: Schema.Natural,
	model_id: ModelId,
	capability_snapshot: CapabilitySnapshot,
	status: RunStatus
});
type AgentRun = typeof AgentRunRow.Type;

export const AgentUsageRow = Schema.Struct({
	id: Schema.NonEmptyString,
	call_id: ProviderCallId,
	run_id: RunId,
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
	if (value !== null && typeof value === 'object') {
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

export const taskIdFor = (scope: string): TaskId => TaskId.make(deterministicId(`task:${scope}`));
const planIdFor = (scope: string): PlanId => PlanId.make(deterministicId(`plan:${scope}`));
const messageIdFor = (scope: string): MessageId =>
	MessageId.make(deterministicId(`message:${scope}`));
const directiveIdFor = (scope: string): DirectiveId =>
	DirectiveId.make(deterministicId(`directive:${scope}`));
const runIdFor = (scope: string): RunId => RunId.make(deterministicId(`run:${scope}`));
const providerCallIdFor = (scope: string): ProviderCallId =>
	ProviderCallId.make(`call:${semanticHash(scope)}`);

const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const taskAssetStorageKey = (
	taskId: TaskId,
	documentId: string,
	fileName: string
): string => taskScopedImageKey(taskId, documentId, fileName);
const validateImageAssets = (taskId: TaskId, assets: ReadonlyArray<ImageAsset>) =>
	Effect.gen(function* () {
		const prefix = taskAssetKeyPrefix(taskId);
		if (
			assets.length > MAX_IMAGE_COUNT ||
			assets.reduce((sum, asset) => sum + asset.size, 0) > MAX_IMAGE_SOURCE_BYTES
		) {
			return yield* new TaskRuntimeError({
				operation: 'image-assets',
				message: 'The image count or source bytes exceed the provider boundary.'
			});
		}
		for (const asset of assets) {
			if (
				!asset.key.startsWith(prefix) ||
				asset.key.includes('..') ||
				asset.key.split('/').length !== 3 ||
				!asset.mimeType.toLowerCase().startsWith('image/') ||
				asset.size <= 0
			) {
				return yield* new TaskRuntimeError({
					operation: 'image-assets',
					message: 'An image descriptor is outside this Task or malformed.'
				});
			}
		}
	});

const encodePromptMessage = Schema.encodeSync(Prompt.Message);
export const messageText = (message: Prompt.MessageEncoded): string =>
	typeof message.content === 'string'
		? message.content
		: message.content
				.flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
				.join('\n');
const systemMessage = (content: string): Prompt.MessageEncoded =>
	encodePromptMessage(Prompt.systemMessage({ content }));
export const userAgentInput = (text: string): Prompt.MessageEncoded =>
	encodePromptMessage(Prompt.userMessage({ content: [Prompt.textPart({ text })] }));
const parentAgentInput = (parentTaskId: TaskId, text: string): Prompt.MessageEncoded =>
	userAgentInput(`[Parent agent ${parentTaskId}]\n${text}`);

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
	userAgentInput(
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
		].join('\n')
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
const supersessionProjection = (messages: ReadonlyArray<AgentMessage>) => {
	const superseded = new Set(
		messages.flatMap(({ supersedes_id }) =>
			supersedes_id === undefined || supersedes_id === null ? [] : [supersedes_id]
		)
	);
	if (superseded.size === 0) return messages;
	return messages.filter(({ id }) => !superseded.has(id));
};

const compactProjection = (messages: ReadonlyArray<AgentMessage>) => {
	const checkpoint = messages.findLast(({ annotation }) => annotation?.tag === 'compact');
	const annotation = checkpoint?.annotation;
	if (checkpoint === undefined || annotation?.tag !== 'compact') return messages;
	const retained = new Set(annotation.retainedMessageIds);
	return messages.filter(
		({ id, sequence }) => sequence > annotation.cutoff || id === checkpoint.id || retained.has(id)
	);
};

const projectTaskPrompt = (input: {
	readonly workspacePrompt: string;
	readonly agentInstruction?: string;
	readonly mode: DirectiveMode;
	readonly messages: ReadonlyArray<AgentMessage>;
	readonly activePlan?: AgentPlan;
}): ReadonlyArray<Prompt.MessageEncoded> => {
	const system = [input.workspacePrompt, input.agentInstruction]
		.filter((part): part is string => part !== undefined && part.trim() !== '')
		.join('\n\n');
	const projected = compactProjection(supersessionProjection(input.messages));
	const activePlan = input.activePlan;
	const messages =
		activePlan === undefined
			? projected
			: projected.filter(({ sequence }) => sequence > activePlan.checkpoint_sequence);
	return [
		...(system === '' ? [] : [systemMessage(system)]),
		...(activePlan === undefined
			? []
			: [systemMessage(`Active Plan revision ${activePlan.revision}:\n${activePlan.body}`)]),
		...(input.mode === 'plan'
			? [
					systemMessage(
						'Plan mode: produce one objective, implementation approach, and verification contract. Do not execute implementation tools.'
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
	typeof message.content === 'string'
		? []
		: message.content.flatMap((part) =>
				part.type === 'tool-call' ? [{ id: part.id, name: part.name, params: part.params }] : []
			);
const unresolvedToolCalls = (
	messages: ReadonlyArray<AgentMessage>
): ReadonlyArray<EncodedToolCall> => {
	const resolved = new Set(
		messages.flatMap(({ message }) =>
			typeof message.content === 'string'
				? []
				: message.content.flatMap((part) => (part.type === 'tool-result' ? [part.id] : []))
		)
	);
	return messages.flatMap(({ message }) =>
		toolCalls(message).filter(({ id }) => !resolved.has(id))
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

const generateMessage = Effect.fn('Agents.generateMessage')(function* (
	ai: AIInterface,
	effectId: EffectId,
	input: {
		callId: ProviderCallId;
		modelId: ModelId;
		messages: ReadonlyArray<Prompt.MessageEncoded>;
		maxOutputTokens: number;
		imageAssets?: ReadonlyArray<ImageAsset>;
	}
) {
	const response = yield* ai.generate(effectId, {
		_tag: 'Generate',
		callId: input.callId,
		modelId: input.modelId,
		messages: [...input.messages],
		maxOutputTokens: input.maxOutputTokens,
		output: { _tag: 'Message' },
		...(input.imageAssets === undefined ? {} : { imageAssets: [...input.imageAssets] })
	});
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
	runId: RunId,
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
	return yield* Schema.decodeUnknownEffect(AgentUsageRow)({
		id: deterministicId(`usage:${observation.callId}`),
		call_id: observation.callId,
		run_id: runId,
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
	audience: TaskAudience;
	delegation: 'enabled' | 'disabled';
}>;
type TaskExecutionResult = Readonly<{
	taskId: TaskId;
	status: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'attention';
	output?: Prompt.MessageEncoded;
}>;

export type Interface = Readonly<{
	readonly submit: (
		effectId: EffectId,
		subject: Identity.Subject,
		request: TaskSubmitRequest
	) => Effect.Effect<
		TaskSubmitResult,
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
		request: TaskEditMessageRequest
	) => Effect.Effect<
		TaskEditMessageResult,
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
		request: TaskControlRequest
	) => Effect.Effect<
		TaskControlResult,
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
	readonly execute: (
		effectId: EffectId,
		subject: Identity.Subject,
		taskId: TaskId
	) => Effect.Effect<
		TaskExecutionResult,
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
}>;

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Agents');

const ToolFailure = Schema.Struct({
	code: Schema.NonEmptyString,
	message: Schema.NonEmptyString
});
interface ToolFailure extends Schema.Schema.Type<typeof ToolFailure> {}

const describeFailure = (failure: unknown): ToolFailure => {
	if (failure instanceof Error)
		return { code: failure.name || 'tool_error', message: failure.message };
	if (typeof failure === 'object' && failure !== null) {
		const tag = Reflect.get(failure, '_tag');
		const message = Reflect.get(failure, 'message');
		return {
			code: typeof tag === 'string' && tag !== '' ? tag : 'tool_error',
			message: typeof message === 'string' && message !== '' ? message : 'Tool execution failed.'
		};
	}
	return { code: 'tool_error', message: String(failure) };
};

const EmptyToolInput: Schema.JsonObject = {
	type: 'object',
	properties: {},
	additionalProperties: false
};

const writeActions: ReadonlyArray<'create' | 'update' | 'delete'> = ['create', 'update', 'delete'];
const ParkedResult = Schema.Struct({ state: Schema.Literal('parked'), taskId: TaskId });

const isParkedResult = Schema.is(ParkedResult);

const MAX_PLAN_VERIFICATION_ATTEMPTS = 3;
const PLAN_VERIFICATION_OUTPUT_TOKENS = 768;
/**
 * The projection bound that makes TaskRuntime compact before an Agent turn instead of after a
 * provider refusal.
 *
 * Measured on the encoded projection — the exact array of `Prompt.MessageEncoded` about to be sent —
 * because that is the only quantity the runtime already has exactly. Tokens are not: a token count
 * belongs to a provider's tokenizer, and asking one costs a round trip per turn to approximate a
 * number the byte length already orders correctly.
 *
 * 64 KiB of encoded JSON is roughly 16k tokens of prose at the ~4 bytes/token rule of thumb, and
 * rather fewer for the JSON-heavy tool traffic that dominates a long Task. Against the smallest
 * context window Bolt targets (128k), that leaves the turn about seven eighths of its window for the
 * system contract, the Plan, the capability snapshot, tool results, and the response — the checkpoint
 * lands while the conversation still fits comfortably, not at the edge where a single large tool
 * result decides whether the turn survives. It is deliberately host-side: a workspace author cannot
 * raise it into a provider's hard failure, and no authored agent config carries a context budget for
 * it to live in.
 */
const AUTO_COMPACT_PROMPT_BYTES = 64 * 1_024;
const AUTO_COMPACT_OUTPUT_TOKENS = 1_536;
const planVerificationExecutionPlan = ExecutionPlan.make({
	provide: Context.empty(),
	attempts: 2
});
const promptBytes = (messages: ReadonlyArray<Prompt.MessageEncoded>): number =>
	new TextEncoder().encode(JSON.stringify(messages)).byteLength;
const ConsumedChildResult = Schema.Struct({
	state: Schema.Literals(['done', 'failed']),
	taskId: TaskId
});

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const access = yield* AccessControl.Service;
		const collections = yield* Collections.Service;
		const ai = yield* AI.Service;
		const tasks = yield* Tasks.Service;
		const hostTools = yield* HostTools.Service;
		const connector = yield* Connector.Service;
		const remotes = yield* RemoteRegistry;

		const resolveAgent = Effect.fn('Agents.resolveAgent')(function* (agentId: AgentId) {
			if (agentId === WEB_AGENT_NAME) {
				return {
					id: agentId,
					audience: TaskAudience.make('personal'),
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
				audience: TaskAudience.make('workbench'),
				delegation: envoy.delegation
			} satisfies ResolvedAgent;
		});

		const allowedSkills = (subject: Identity.Subject) =>
			workspace.definition.skills.filter(({ name }) =>
				access.capabilities(subject).skills.has(name)
			);

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

		const allowedTools = (
			subject: Identity.Subject,
			agent: ResolvedAgent
		): ReadonlyArray<ToolDeclaration> => {
			const granted = access.capabilities(subject);
			const authored = workspace.definition.tools.filter((tool) =>
				tool.mcp === undefined ? granted.tools.has(tool.name) : granted.mcp.has(tool.mcp.server)
			);
			const authoredNames = new Set(authored.map(({ name }) => name));
			return [
				...systemToolSpecs.filter(
					(tool) =>
						!authoredNames.has(tool.name) &&
						(tool.name !== 'write_collection' || writesForSubject(subject))
				),
				...(agent.delegation === 'enabled' && !authoredNames.has(subagentToolSpec.name)
					? [subagentToolSpec]
					: []),
				...authored
			];
		};

		const capabilitySnapshot = (
			subject: Identity.Subject,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>
		): CapabilitySnapshot => {
			const capabilities = [
				...tools.map((tool) => ({
					id: CapabilityId.make(
						`${tool.mcp === undefined ? (systemToolSpecs.some(({ name }) => name === tool.name) || tool.name === subagentToolSpec.name ? 'system' : 'tenant') : 'tenant'}/${tool.name}`
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

		const selectModel = Effect.fn('Agents.selectModel')(function* (effectId: EffectId) {
			const response = yield* ai.catalog(effectId, { _tag: 'Catalog' });
			const selected = response.languageModels.find(
				({ id }) => id === response.defaultLanguageModelId
			);
			if (selected === undefined) {
				return yield* new AgentModelUnavailable({ model: 'catalog', reason: 'invalid-catalog' });
			}
			return selected.id;
		});

		const taskById = Effect.fn('Agents.taskById')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId
		) {
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'agent_task',
				where: { id: { eq: taskId } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(AgentTaskRow)(row).pipe(
				Effect.mapError(
					() =>
						new TaskRuntimeError({
							operation: 'read-task',
							message: 'The durable Task row is malformed.'
						})
				)
			);
		});

		const requireOwnedTask = Effect.fn('Agents.requireOwnedTask')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId
		) {
			const task = yield* taskById(effectId, subject, taskId);
			if (task === undefined || task.subject_id !== subject.userId) {
				return yield* new AccessControl.AccessDenied({
					action: 'agent',
					resource: taskId,
					reason: 'unknown Task'
				});
			}
			return task;
		});

		const messageRows = Effect.fn('Agents.messageRows')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId
		) {
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'agent_message',
				where: { task_id: { eq: taskId } },
				orderBy: { sequence: 'asc' },
				limit: 500
			});
			return yield* decodeRows(AgentMessageRow, rows);
		});

		type RelatedMutation = Readonly<Record<string, unknown>> & Readonly<{ id: string }>;

		const completeRelation = Effect.fn('Agents.completeRelation')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			ownerField: string,
			ownerId: string,
			changes: ReadonlyArray<RelatedMutation>
		) {
			const rows = yield* collections.findMany(effectId, subject, {
				collection,
				where: { [ownerField]: { eq: ownerId } },
				orderBy: { created_at: 'asc' },
				limit: 500
			});
			const existing = yield* decodeRows(Schema.Struct({ id: Schema.NonEmptyString }), rows);
			const changed = new Set(changes.map(({ id }) => id));
			return [
				...existing.filter(({ id }) => !changed.has(id)).map(({ id }) => ({ id })),
				...changes
			];
		});
		const retainTaskRows = (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId,
			collection: string,
			changes: ReadonlyArray<RelatedMutation>
		) => completeRelation(effectId, subject, collection, 'task_id', taskId, changes);
		const mutateTask = (
			effectId: EffectId,
			subject: Identity.Subject,
			mutation: Readonly<Record<string, unknown>> & Readonly<{ id: TaskId }>,
			action: 'create' | 'update' = 'update'
		) =>
			collections.mutate(effectId, subject, 'agent_task', [mutation], true, 0, {
				root: { id: mutation.id, action }
			});

		const activePlan = Effect.fn('Agents.activePlan')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: AgentTask
		) {
			if (task.active_plan_id === undefined || task.active_plan_id === null) return undefined;
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'agent_plan',
				where: { id: { eq: task.active_plan_id } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(AgentPlanRow)(row);
		});

		const lastSequence = (messages: ReadonlyArray<AgentMessage>): number =>
			messages.at(-1)?.sequence ?? 0;

		type Admission = Readonly<{
			taskId: TaskId;
			agentId: AgentId;
			message: Prompt.MessageEncoded;
			author: Readonly<{ kind: 'human' | 'parent-agent' | 'system'; id?: string }>;
			mode: DirectiveMode;
			priority: DirectivePriority;
			annotation?: MessageAnnotation;
			runId?: RunId;
			supersedesId?: MessageId;
			parent?: AgentTask;
			resume?: boolean;
		}>;

		const admit = Effect.fn('Agents.admit')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			input: Admission
		) {
			const agent = yield* resolveAgent(input.agentId);
			yield* access.authorize(subject, 'agent', agent.id);
			const existing = yield* taskById(EffectId.make(`${effectId}:task`), subject, input.taskId);
			if (existing !== undefined) {
				if (
					existing.subject_id !== subject.userId ||
					existing.agent_id !== input.agentId ||
					existing.audience !== agent.audience ||
					existing.status === 'done' ||
					existing.status === 'failed'
				) {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: input.taskId,
						reason: 'Task identity is immutable'
					});
				}
				if (!input.resume && existing.status === 'stopped') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: input.taskId,
						reason: 'Task is stopped; use control resume'
					});
				}
			}
			let messages: ReadonlyArray<AgentMessage> = [];
			if (existing !== undefined) messages = yield* messageRows(effectId, subject, input.taskId);
			const fingerprint = semanticHash({
				taskId: input.taskId,
				author: input.author,
				message: input.message,
				annotation: input.annotation,
				runId: input.runId,
				supersedesId: input.supersedesId,
				mode: input.mode,
				priority: input.priority
			});
			const duplicate = messages.find(({ semantic_hash }) => semantic_hash === fingerprint);
			if (duplicate !== undefined) {
				const directive = yield* collections.findFirst(effectId, subject, {
					collection: 'agent_inbox',
					where: { message_id: { eq: duplicate.id } }
				});
				if (directive !== undefined) {
					const decoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: DirectiveId }))(
						directive
					);
					return { directiveId: decoded.id };
				}
			}
			const messageId = messageIdFor(`${input.taskId}:${fingerprint}`);
			const directiveId = directiveIdFor(`${input.taskId}:${fingerprint}`);
			const nextSequence = lastSequence(messages) + 1;
			const inbox = yield* collections.findMany(effectId, subject, {
				collection: 'agent_inbox',
				where: { task_id: { eq: input.taskId } },
				orderBy: { sequence: 'desc' },
				limit: 1
			});
			const inboxRows = yield* decodeRows(
				Schema.Struct({ sequence: Schema.Number.check(Schema.isInt()) }),
				inbox
			);
			const inboxSequence = inboxRows[0]?.sequence ?? 0;
			yield* tasks.execute(EffectId.make(`${effectId}:wake`), {
				_tag: 'Wake',
				notLaterThanEpochMs: yield* Clock.currentTimeMillis
			});
			const message = {
				id: messageId,
				task_id: input.taskId,
				sequence: nextSequence,
				author: input.author,
				message: input.message,
				semantic_hash: fingerprint,
				...(input.runId === undefined ? {} : { run_id: input.runId }),
				...(input.annotation === undefined ? {} : { annotation: input.annotation }),
				...(input.supersedesId === undefined ? {} : { supersedes_id: input.supersedesId })
			};
			const directive = {
				id: directiveId,
				task_id: input.taskId,
				sequence: inboxSequence + 1,
				message_id: messageId,
				mode: input.mode,
				priority: input.priority,
				state: 'queued'
			};
			if (existing === undefined) {
				const workbenchId = input.parent?.workbench_id ?? WorkbenchId.make(input.taskId);
				yield* mutateTask(
					effectId,
					subject,
					{
						id: input.taskId,
						workbench_id: workbenchId,
						subject_id: SubjectId.make(subject.userId),
						agent_id: input.agentId,
						audience: agent.audience,
						...(input.parent === undefined ? {} : { parent_id: input.parent.id }),
						status: 'ready',
						epoch: 0,
						messages: [message],
						directives: [directive]
					},
					'create'
				);
			} else {
				const completeMessages = yield* retainTaskRows(
					EffectId.make(`${effectId}:retain-messages`),
					subject,
					input.taskId,
					'agent_message',
					[message]
				);
				const completeDirectives = yield* retainTaskRows(
					EffectId.make(`${effectId}:retain-directives`),
					subject,
					input.taskId,
					'agent_inbox',
					[directive]
				);
				yield* mutateTask(effectId, subject, {
					id: input.taskId,
					status: input.resume ? 'ready' : existing.status,
					epoch: existing.epoch,
					...(input.resume ? { active_run_id: null } : {}),
					messages: completeMessages,
					directives: completeDirectives
				});
			}
			return { directiveId } satisfies TaskSubmitResult;
		});

		const submit = Effect.fn('Agents.submit')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: TaskSubmitRequest
		) {
			return yield* admit(effectId, subject, {
				taskId: request.taskId,
				agentId: request.agentId,
				message: request.message,
				author: { kind: 'human', id: subject.userId },
				mode: request.mode,
				priority: request.priority
			});
		});

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
			request: TaskEditMessageRequest
		) {
			const task = yield* requireOwnedTask(
				EffectId.make(`${effectId}:task`),
				subject,
				request.taskId
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
				taskId: task.id,
				agentId: task.agent_id,
				message: request.message,
				author: { kind: 'human', id: subject.userId },
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal'),
				supersedesId: request.messageId
			});
			const revision = yield* collections.findFirst(
				EffectId.make(`${effectId}:revision`),
				subject,
				{ collection: 'agent_message', where: { supersedes_id: { eq: request.messageId } } }
			);
			const decoded = yield* Schema.decodeUnknownEffect(AgentMessageRow)(revision);
			return {
				directiveId: admitted.directiveId,
				messageId: decoded.id,
				supersedesId: request.messageId
			} satisfies TaskEditMessageResult;
		});

		const runById = Effect.fn('Agents.runById')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			runId: RunId
		) {
			const row = yield* collections.findFirst(effectId, subject, {
				collection: 'agent_run',
				where: { id: { eq: runId } }
			});
			if (row === undefined) return undefined;
			return yield* Schema.decodeUnknownEffect(AgentRunRow)(row);
		});

		const taskDepth = Effect.fn('Agents.taskDepth')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			root: AgentTask
		) {
			let depth = 0;
			let current = root;
			const visited = new Set<TaskId>([root.id]);
			while (current.parent_id !== undefined && current.parent_id !== null) {
				if (visited.has(current.parent_id) || depth >= 64) {
					return yield* new TaskRuntimeError({
						operation: 'task-depth',
						message: 'The durable child Task lineage is cyclic or unbounded.'
					});
				}
				visited.add(current.parent_id);
				const parent = yield* taskById(
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
			task: AgentTask
		) {
			if (task.active_run_id !== undefined && task.active_run_id !== null) {
				const active = yield* runById(effectId, subject, task.active_run_id);
				if (active !== undefined && (active.status === 'running' || active.status === 'waiting')) {
					return active;
				}
			}
			if (task.status !== 'ready') return undefined;
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'agent_inbox',
				where: { task_id: { eq: task.id }, state: { eq: 'queued' } },
				orderBy: { priority: 'desc', sequence: 'asc' },
				limit: 1
			});
			const directives = yield* decodeRows(
				Schema.Struct({
					id: DirectiveId,
					sequence: Schema.Number.check(Schema.isInt()),
					mode: DirectiveMode
				}),
				rows
			);
			const directive = directives[0];
			if (directive === undefined) return undefined;
			const agent = yield* resolveAgent(task.agent_id);
			yield* access.authorize(subject, 'agent', agent.id);
			const modelId = yield* selectModel(EffectId.make(`${effectId}:model`));
			const tools = allowedTools(subject, agent);
			const epoch = task.epoch + 1;
			const runId = runIdFor(`${task.id}:${directive.id}:${epoch}`);
			const messages = yield* messageRows(effectId, subject, task.id);
			const run = {
				id: runId,
				task_id: task.id,
				directive_id: directive.id,
				epoch,
				mode: directive.mode,
				phase: 'model',
				input_through_sequence: lastSequence(messages),
				model_id: modelId,
				capability_snapshot: capabilitySnapshot(subject, agent, tools),
				status: 'running'
			};
			const completeDirectives = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-directives`),
				subject,
				task.id,
				'agent_inbox',
				[{ id: directive.id, state: 'claimed', claimed_run_id: runId }]
			);
			const completeRuns = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-runs`),
				subject,
				task.id,
				'agent_run',
				[run]
			);
			yield* mutateTask(effectId, subject, {
				id: task.id,
				status: 'running',
				active_run_id: runId,
				epoch,
				directives: completeDirectives,
				runs: completeRuns
			});
			return yield* Schema.decodeUnknownEffect(AgentRunRow)(run);
		});

		const fencedTask = Effect.fn('Agents.fencedTask')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: AgentRun
		) {
			const task = yield* requireOwnedTask(effectId, subject, run.task_id);
			if (
				task.active_run_id !== run.id ||
				task.epoch !== run.epoch ||
				(task.status !== 'running' && task.status !== 'ready')
			) {
				return yield* new TaskRuntimeError({
					operation: 'fence',
					message: 'The Task run fence is stale.'
				});
			}
			return task;
		});

		const appendMessage = Effect.fn('Agents.appendMessage')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: AgentRun,
			author: Readonly<{ kind: 'agent' | 'tool' | 'system'; id?: string }>,
			message: Prompt.MessageEncoded,
			annotation?: MessageAnnotation
		) {
			const task = yield* fencedTask(EffectId.make(`${effectId}:fence`), subject, run);
			const messages = yield* messageRows(effectId, subject, task.id);
			const fingerprint = semanticHash({ runId: run.id, effectId, author, message, annotation });
			const existing = messages.find(({ semantic_hash }) => semantic_hash === fingerprint);
			if (existing !== undefined) return existing;
			const sequence = lastSequence(messages) + 1;
			const row = {
				id: messageIdFor(`${task.id}:${fingerprint}`),
				task_id: task.id,
				sequence,
				run_id: run.id,
				author,
				message,
				semantic_hash: fingerprint,
				...(annotation === undefined ? {} : { annotation })
			};
			const completeMessages = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-messages`),
				subject,
				task.id,
				'agent_message',
				[row]
			);
			yield* mutateTask(effectId, subject, {
				id: task.id,
				status: task.status,
				active_run_id: run.id,
				epoch: run.epoch,
				messages: completeMessages
			});
			return yield* Schema.decodeUnknownEffect(AgentMessageRow)(row);
		});

		const recordUsage = Effect.fn('Agents.recordUsage')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: AgentRun,
			observation: ProviderObservation
		) {
			const task = yield* fencedTask(EffectId.make(`${effectId}:fence`), subject, run);
			const usage = yield* usageMutation(run.id, observation);
			const completeUsage = yield* completeRelation(
				EffectId.make(`${effectId}:retain-usage`),
				subject,
				'agent_usage',
				'run_id',
				run.id,
				[usage]
			);
			const completeRuns = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-runs`),
				subject,
				task.id,
				'agent_run',
				[{ id: run.id, usage: completeUsage }]
			);
			yield* mutateTask(effectId, subject, {
				id: task.id,
				status: task.status,
				active_run_id: run.id,
				epoch: run.epoch,
				runs: completeRuns
			});
		});

		const updateRun = Effect.fn('Agents.updateRun')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			run: AgentRun,
			input: Readonly<{
				taskStatus: AgentTask['status'];
				runStatus: AgentRun['status'];
				phase: AgentRun['phase'];
				active: boolean;
				directiveState?: 'settled' | 'cancelled';
				plans?: ReadonlyArray<Readonly<Record<string, unknown>>>;
				activePlanId?: PlanId | null;
			}>
		) {
			const task = yield* fencedTask(EffectId.make(`${effectId}:fence`), subject, run);
			const completeRuns = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-runs`),
				subject,
				task.id,
				'agent_run',
				[{ id: run.id, status: input.runStatus, phase: input.phase }]
			);
			if (input.plans !== undefined) {
				for (const plan of input.plans) {
					const id = plan['id'];
					if (typeof id !== 'string' || id === '')
						return yield* Effect.fail(new TypeError('A Task Plan mutation requires an id.'));
				}
			}
			const completePlans =
				input.plans === undefined
					? undefined
					: yield* retainTaskRows(
							EffectId.make(`${effectId}:retain-plans`),
							subject,
							task.id,
							'agent_plan',
							input.plans.map((plan) => ({ ...plan, id: String(plan['id']) }))
						);
			const completeDirectives =
				input.directiveState === undefined
					? undefined
					: yield* retainTaskRows(
							EffectId.make(`${effectId}:retain-directives`),
							subject,
							task.id,
							'agent_inbox',
							[{ id: run.directive_id, state: input.directiveState }]
						);
			yield* mutateTask(effectId, subject, {
				id: task.id,
				status: input.taskStatus,
				active_run_id: input.active ? run.id : null,
				epoch: run.epoch,
				...(input.activePlanId === undefined ? {} : { active_plan_id: input.activePlanId }),
				...(completePlans === undefined ? {} : { plans: completePlans }),
				runs: completeRuns,
				...(completeDirectives === undefined ? {} : { directives: completeDirectives })
			});
		});
		const settleRun = (
			effectId: EffectId,
			subject: Identity.Subject,
			run: AgentRun,
			taskStatus: AgentTask['status'],
			phase: AgentRun['phase'],
			changes: Readonly<{
				plans?: ReadonlyArray<Readonly<Record<string, unknown>>>;
				activePlanId?: PlanId | null;
			}> = {}
		) =>
			updateRun(effectId, subject, run, {
				taskStatus,
				runStatus: 'succeeded',
				phase,
				active: false,
				directiveState: 'settled',
				...changes
			});

		const wakeParent = Effect.fn('Agents.wakeParent')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			child: AgentTask
		) {
			if (child.parent_id === undefined || child.parent_id === null) return;
			const parent = yield* taskById(EffectId.make(`${effectId}:parent`), subject, child.parent_id);
			if (
				parent === undefined ||
				parent.status !== 'waiting' ||
				parent.active_run_id === undefined ||
				parent.active_run_id === null
			) {
				return;
			}
			const parentRun = yield* runById(
				EffectId.make(`${effectId}:parent-run`),
				subject,
				parent.active_run_id
			);
			if (parentRun === undefined || parentRun.status !== 'waiting') return;
			const epoch = parent.epoch + 1;
			const completeRuns = yield* retainTaskRows(
				EffectId.make(`${effectId}:retain-runs`),
				subject,
				parent.id,
				'agent_run',
				[{ id: parentRun.id, epoch, status: 'running', phase: 'children' }]
			);
			yield* mutateTask(effectId, subject, {
				id: parent.id,
				status: 'ready',
				active_run_id: parentRun.id,
				epoch,
				runs: completeRuns
			});
			yield* tasks.execute(EffectId.make(`${effectId}:wake`), {
				_tag: 'Wake',
				notLaterThanEpochMs: yield* Clock.currentTimeMillis
			});
		});

		const previousTodo = (
			messages: ReadonlyArray<AgentMessage>,
			runId: RunId
		): TodoListValue | undefined => {
			for (const row of messages.toReversed()) {
				if (row.run_id !== runId) continue;
				if (typeof row.message.content === 'string') continue;
				for (const part of row.message.content.toReversed()) {
					if (part.type !== 'tool-result' || part.name !== 'todo' || part.isFailure) continue;
					const decoded = Schema.decodeUnknownOption(TodoList)(part.result);
					if (decoded._tag === 'Some') return decoded.value;
				}
			}
			return undefined;
		};

		const imageAssets = (
			messages: ReadonlyArray<AgentMessage>,
			runId: RunId
		): ReadonlyArray<ImageAsset> => {
			const assets: Array<ImageAsset> = [];
			for (const row of messages) {
				assets.push(...imageAssetsFromMessage(row.message));
				if (row.run_id !== runId) continue;
				if (typeof row.message.content === 'string') continue;
				for (const part of row.message.content) {
					if (part.type !== 'tool-result' || part.name !== 'use_image' || part.isFailure) continue;
					const decoded = Schema.decodeUnknownOption(ImageAsset)(part.result);
					if (decoded._tag === 'Some') assets.push(decoded.value);
				}
			}
			return assets.slice(-MAX_IMAGE_COUNT);
		};

		const childBarrier = Effect.fn('Agents.childBarrier')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			task: AgentTask,
			messages: ReadonlyArray<AgentMessage>
		) {
			const rows = yield* collections.findMany(effectId, subject, {
				collection: 'agent_task',
				where: { parent_id: { eq: task.id } },
				orderBy: { created_at: 'asc' },
				limit: 64
			});
			const children = yield* decodeRows(AgentTaskRow, rows);
			if (children.length === 0) return { state: 'clear' as const };
			const consumed = new Set<TaskId>();
			for (const row of messages) {
				if (typeof row.message.content === 'string') continue;
				for (const part of row.message.content) {
					if (part.type !== 'tool-result' || part.name !== 'subagent' || part.isFailure) continue;
					const result = Schema.decodeUnknownOption(ConsumedChildResult)(part.result);
					if (result._tag === 'Some') consumed.add(result.value.taskId);
				}
			}
			const running = children.filter(({ status }) => status !== 'done' && status !== 'failed');
			if (running.length > 0) {
				return {
					state: 'waiting',
					taskIds: running.map(({ id }) => id)
				};
			}
			const unconsumed = children.filter(({ id }) => !consumed.has(id));
			return unconsumed.length === 0
				? { state: 'clear' as const }
				: {
						state: 'consume',
						taskIds: unconsumed.map(({ id }) => id)
					};
		});

		const controlTask = Effect.fn('Agents.controlTask')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId,
			action: 'stop' | 'resume'
		) {
			const task = yield* requireOwnedTask(effectId, subject, taskId);
			const agent = yield* resolveAgent(task.agent_id);
			yield* access.authorize(subject, 'agent', agent.id);
			if (action === 'resume') {
				if (task.status !== 'stopped' && task.status !== 'attention') {
					return yield* new AccessControl.AccessDenied({
						action: 'agent',
						resource: taskId,
						reason: 'Only a stopped or attention Task may resume'
					});
				}
				yield* selectModel(EffectId.make(`${effectId}:model`));
				const result = yield* admit(effectId, subject, {
					taskId,
					agentId: task.agent_id,
					message: systemMessage(`Resume this Task from durable epoch ${task.epoch}.`),
					author: { kind: 'system' },
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal'),
					resume: true
				});
				return {
					taskId,
					status: 'ready',
					directiveId: result.directiveId
				};
			}
			const completeRuns =
				task.active_run_id === undefined || task.active_run_id === null
					? undefined
					: yield* retainTaskRows(
							EffectId.make(`${effectId}:retain-runs`),
							subject,
							task.id,
							'agent_run',
							[{ id: task.active_run_id, status: 'stopped' }]
						);
			yield* mutateTask(effectId, subject, {
				id: task.id,
				status: 'stopped',
				active_run_id: null,
				epoch: task.epoch,
				...(completeRuns === undefined ? {} : { runs: completeRuns })
			});
			yield* tasks.execute(EffectId.make(`${effectId}:interrupt`), {
				_tag: 'Interrupt',
				taskId
			});
			return { taskId, status: 'stopped' as const };
		});

		const toolContext = (
			effectId: EffectId,
			subject: Identity.Subject,
			task: AgentTask,
			run: AgentRun,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<AgentMessage>
		): ToolExecutionContext => {
			const todo = previousTodo(messages, run.id);
			const readableCollectionNames = reachableCollections(subject, 'read');
			const writableCollectionNames = reachableCollections(subject, 'write');
			return {
				effectId,
				subject,
				agentId: agent.id,
				taskId: task.id,
				workbenchId: task.workbench_id,
				skills: allowedSkills(subject),
				toolNames: tools.map(({ name }) => name),
				collectionNames: [...new Set([...readableCollectionNames, ...writableCollectionNames])],
				readableCollectionNames,
				writableCollectionNames,
				workspace,
				collections,
				hostTools,
				...(todo === undefined ? {} : { previousTodo: todo })
			};
		};

		const executeDeclaredTool = Effect.fn('Agents.executeDeclaredTool')(function* (
			declaration: ToolDeclaration,
			params: unknown,
			callId: string,
			subject: Identity.Subject,
			task: AgentTask,
			run: AgentRun,
			agent: ResolvedAgent,
			tools: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<AgentMessage>
		) {
			const name = declaration.name;
			const context = toolContext(
				EffectId.make(`${run.id}:tool:${callId}`),
				subject,
				task,
				run,
				agent,
				tools,
				messages
			);
			if (isSystemTool(name)) return yield* executeSystemTool(name, params, context);
			if (name === 'subagent') {
				const depth = yield* taskDepth(EffectId.make(`${context.effectId}:depth`), subject, task);
				const subagent: SubagentContext = {
					effectId: context.effectId,
					subject,
					workbenchId: task.workbench_id,
					agentId: agent.id,
					taskId: task.id,
					collections,
					budget: InvocationBudget.make(depth, InvocationBudget.DEFAULT_NESTING_LIMIT),
					spawn: (actionId, childAgentId, instruction, _depth, toolCallId) =>
						Effect.gen(function* () {
							const childId = taskIdFor(`${run.id}:${toolCallId}`);
							const submitted = yield* admit(actionId, subject, {
								taskId: childId,
								agentId: childAgentId,
								message: parentAgentInput(task.id, instruction),
								author: { kind: 'parent-agent', id: task.id },
								mode: DirectiveMode.make('agent'),
								priority: DirectivePriority.make('normal'),
								parent: task
							});
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								taskId: childId,
								directiveId: submitted.directiveId,
								state: 'running'
							});
						}),
					admit: (actionId, targetId, message, priority) =>
						Effect.gen(function* () {
							const target = yield* requireOwnedTask(actionId, subject, targetId);
							const submitted = yield* admit(actionId, subject, {
								taskId: target.id,
								agentId: target.agent_id,
								message: parentAgentInput(task.id, message),
								author: { kind: 'parent-agent', id: task.id },
								mode: DirectiveMode.make('agent'),
								priority: DirectivePriority.make(priority)
							});
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								taskId: target.id,
								directiveId: submitted.directiveId,
								state: 'queued'
							});
						}),
					awaitTarget: (actionId, childId) =>
						Effect.gen(function* () {
							const child = yield* requireOwnedTask(actionId, subject, childId);
							if (child.status === 'done' || child.status === 'failed') {
								const childMessages = yield* messageRows(actionId, subject, child.id);
								return yield* Schema.decodeUnknownEffect(Schema.Json)({
									state: child.status,
									taskId: child.id,
									message: childMessages.at(-1)?.message ?? null
								});
							}
							yield* updateRun(actionId, subject, run, {
								taskStatus: 'waiting',
								runStatus: 'waiting',
								phase: 'children',
								active: true
							});
							return yield* Schema.decodeUnknownEffect(Schema.Json)({
								state: 'parked',
								taskId: child.id
							});
						}),
					control: (actionId, childId, action) =>
						controlTask(actionId, subject, childId, action).pipe(
							Effect.flatMap((result) => Schema.decodeUnknownEffect(Schema.Json)(result))
						)
				};
				return yield* executeSubagentTool(params, subagent, callId);
			}
			const input = yield* Schema.decodeUnknownEffect(Schema.Json)(params).pipe(
				Effect.mapError(() => new ToolNotAllowed({ agent: agent.id, tool: `${name}:invalid-json` }))
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
			task: AgentTask,
			run: AgentRun,
			agent: ResolvedAgent,
			declarations: ReadonlyArray<ToolDeclaration>,
			messages: ReadonlyArray<AgentMessage>
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
			task: AgentTask,
			run: AgentRun,
			output: Prompt.MessageEncoded,
			messages: ReadonlyArray<AgentMessage>
		) {
			if (run.mode === 'plan') {
				const body = messageText(output).trim();
				if (body === '') {
					return yield* new TaskRuntimeError({
						operation: 'plan',
						message: 'Plan mode returned an empty Plan body.'
					});
				}
				const current = yield* activePlan(effectId, subject, task);
				const revision = (current?.revision ?? 0) + 1;
				const planId = planIdFor(`${task.id}:${revision}:${semanticHash(body)}`);
				const plans: Array<Readonly<Record<string, unknown>>> = [
					...(current === undefined || (current.status !== 'active' && current.status !== 'stalled')
						? []
						: [{ id: current.id, status: 'superseded' }]),
					{
						id: planId,
						task_id: task.id,
						revision,
						checkpoint_sequence: lastSequence(messages),
						body,
						status: 'active'
					}
				];
				yield* settleRun(effectId, subject, run, 'ready', 'model', {
					plans,
					activePlanId: planId
				});
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
					...projectTaskPrompt({
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
						{ kind: 'system' },
						verdictMessage,
						annotation
					);
					const complete = verified.verdict.complete;
					yield* settleRun(effectId, subject, run, complete ? 'done' : 'attention', 'verify', {
						plans: [{ id: plan.id, status: complete ? 'verified' : 'stalled' }]
					});
					if (complete)
						yield* wakeParent(EffectId.make(`${effectId}:wake-parent`), subject, task);
					return complete ? 'done' : 'attention';
				}
				yield* admit(EffectId.make(`${effectId}:continue:${attempt}`), subject, {
					taskId: task.id,
					agentId: task.agent_id,
					message: verdictMessage,
					author: { kind: 'system' },
					mode: 'agent',
					priority: 'normal',
					annotation,
					runId: run.id
				});
				yield* settleRun(effectId, subject, run, 'ready', 'verify');
				return 'idle';
			}
			yield* settleRun(effectId, subject, run, 'done', 'model');
			yield* wakeParent(EffectId.make(`${effectId}:wake-parent`), subject, task);
			return 'done';
		});

		const execute = Effect.fn('Agents.execute')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			taskId: TaskId
		) {
			let task = yield* requireOwnedTask(EffectId.make(`${effectId}:task`), subject, taskId);
			const run = yield* claim(EffectId.make(`${effectId}:claim`), subject, task);
			if (run === undefined) return { taskId, status: 'idle' } satisfies TaskExecutionResult;
			if (run.status === 'waiting') {
				return { taskId, status: 'waiting' } satisfies TaskExecutionResult;
			}
			const agent = yield* resolveAgent(task.agent_id);
			const allTools = allowedTools(subject, agent);
			const toolsForMode =
				run.mode === 'compact'
					? []
					: run.mode === 'plan'
						? allTools.filter((tool) =>
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
			yield* tasks.execute(EffectId.make(`${effectId}:active`), { _tag: 'Active', taskId });
			let output: Prompt.MessageEncoded | undefined;
			const runEffect = Effect.gen(function* () {
				for (let iteration = 0; iteration < 8; iteration += 1) {
					task = yield* fencedTask(EffectId.make(`${effectId}:fence:${iteration}`), subject, run);
					let messages = yield* messageRows(
						EffectId.make(`${effectId}:messages:${iteration}`),
						subject,
						task.id
					);
					let calls = unresolvedToolCalls(messages);
					if (calls.length === 0) {
						const plan = yield* activePlan(
							EffectId.make(`${effectId}:plan:${iteration}`),
							subject,
							task
						);
						let assets = imageAssets(messages, run.id);
						yield* validateImageAssets(task.id, assets);
						let projected = projectTaskPrompt({
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
						const compactedThisRun = messages.some(
							(message) => message.run_id === run.id && message.annotation?.tag === 'compact'
						);
						if (
							run.mode === 'agent' &&
							!compactedThisRun &&
							promptBytes(projected) > AUTO_COMPACT_PROMPT_BYTES
						) {
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
									...messages.filter(({ run_id }) => run_id === run.id).map(({ id }) => id)
								])
							];
							const compacted = yield* generateMessage(
								ai,
								EffectId.make(`${effectId}:auto-compact-provider:${iteration}`),
								{
									callId: providerCallIdFor(`${run.id}:auto-compact:${iteration}`),
									modelId: run.model_id,
									messages: [
										...projected,
										systemMessage(
											'Automatic Compact: summarize the durable context needed to continue this Task. Preserve decisions, constraints, unresolved work, tool evidence, child outcomes, and the current user instruction. Do not perform new work.'
										)
									],
									maxOutputTokens: AUTO_COMPACT_OUTPUT_TOKENS,
									...(assets.length === 0 ? {} : { imageAssets: assets })
								}
							);
							yield* recordUsage(
								EffectId.make(`${effectId}:auto-compact-usage:${iteration}`),
								subject,
								run,
								compacted.observation
							);
							yield* appendMessage(
								EffectId.make(`${effectId}:auto-compact:${iteration}`),
								subject,
								run,
								{ kind: 'agent', id: agent.id },
								compacted.message,
								{
									tag: 'compact',
									origin: 'automatic',
									cutoff: lastSequence(messages),
									retainedMessageIds
								}
							);
							messages = yield* messageRows(
								EffectId.make(`${effectId}:auto-compact-messages:${iteration}`),
								subject,
								task.id
							);
							assets = imageAssets(messages, run.id);
							projected = projectTaskPrompt({
								workspacePrompt: workspace.definition.prompt,
								...(agent.instruction === undefined ? {} : { agentInstruction: agent.instruction }),
								mode: run.mode,
								messages,
								...(plan === undefined ? {} : { activePlan: plan })
							});
							const residualBytes = promptBytes(projected);
							if (residualBytes > AUTO_COMPACT_PROMPT_BYTES) {
								/**
								 * Degraded, not failed. Refusing the turn here would brick every long
								 * conversation the moment its retained material alone exceeds the bound, so
								 * the turn proceeds and the condition is recorded the way every other
								 * degraded outcome is: one canonical message carrying this run's id, never
								 * a reintroduced run disposition column (RFC §4.2).
								 */
								yield* appendMessage(
									EffectId.make(`${effectId}:auto-compact-residual:${iteration}`),
									subject,
									run,
									{ kind: 'system' },
									systemMessage(
										`Automatic Compact left the projection above the context bound (${residualBytes} bytes against ${AUTO_COMPACT_PROMPT_BYTES}). This turn proceeds over the compacted projection without a second checkpoint.`
									)
								);
								messages = yield* messageRows(
									EffectId.make(`${effectId}:auto-compact-residual-messages:${iteration}`),
									subject,
									task.id
								);
								projected = projectTaskPrompt({
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
						const callId = providerCallIdFor(`${run.id}:${iteration}`);
						const generated = yield* generateMessage(
							ai,
							EffectId.make(`${effectId}:provider:${iteration}`),
							{
								callId,
								modelId: run.model_id,
								messages: projected,
								maxOutputTokens: 2_048,
								...(assets.length === 0 ? {} : { imageAssets: assets })
							}
						);
						yield* recordUsage(
							EffectId.make(`${effectId}:usage:${iteration}`),
							subject,
							run,
							generated.observation
						);
						const annotation: MessageAnnotation | undefined =
							run.mode === 'compact'
								? {
										tag: 'compact',
										origin: 'manual',
										cutoff: lastSequence(messages),
										retainedMessageIds: []
									}
								: undefined;
						yield* appendMessage(
							EffectId.make(`${effectId}:assistant:${iteration}`),
							subject,
							run,
							{ kind: 'agent', id: agent.id },
							generated.message,
							annotation
						);
						output = generated.message;
						calls = toolCalls(generated.message);
						messages = yield* messageRows(effectId, subject, task.id);
					}
					if (calls.length === 0 && output !== undefined) {
						const barrier = yield* childBarrier(
							EffectId.make(`${effectId}:children:${iteration}`),
							subject,
							task,
							messages
						);
						if (barrier.state === 'waiting') {
							yield* updateRun(effectId, subject, run, {
								taskStatus: 'waiting',
								runStatus: 'waiting',
								phase: 'children',
								active: true
							});
							return {
								taskId,
								status: 'waiting',
								...(output === undefined ? {} : { output })
							} satisfies TaskExecutionResult;
						}
						if (barrier.state === 'consume') {
							yield* appendMessage(
								EffectId.make(`${effectId}:children-required:${iteration}`),
								subject,
								run,
								{ kind: 'system' },
								systemMessage(
									`Consume required child Tasks with subagent await before finishing: ${barrier.taskIds.join(', ')}`
								)
							);
							output = undefined;
							continue;
						}
						const status = yield* finishRun(effectId, subject, task, run, output, messages);
						return { taskId, status, output } satisfies TaskExecutionResult;
					}
					for (const call of calls) {
						yield* fencedTask(EffectId.make(`${effectId}:tool-fence:${call.id}`), subject, run);
						const handled = yield* handledTool(
							call,
							subject,
							task,
							run,
							agent,
							toolsForMode,
							messages
						);
						if (isParkedResult(handled.encodedResult)) {
							return {
								taskId,
								status: 'waiting',
								...(output === undefined ? {} : { output })
							} satisfies TaskExecutionResult;
						}
						yield* appendMessage(
							EffectId.make(`${effectId}:tool-result:${call.id}`),
							subject,
							run,
							{ kind: 'tool', id: call.name },
							toolResultMessage(call, handled.encodedResult, handled.isFailure)
						);
						messages = yield* messageRows(effectId, subject, task.id);
					}
				}
				yield* updateRun(effectId, subject, run, {
					taskStatus: 'attention',
					runStatus: 'failed',
					phase: 'model',
					active: false,
					directiveState: 'settled'
				});
				return {
					taskId,
					status: 'attention',
					...(output === undefined ? {} : { output })
				} satisfies TaskExecutionResult;
			});
			return yield* runEffect.pipe(
				Effect.tapError(() =>
					updateRun(EffectId.make(`${effectId}:failed`), subject, run, {
						taskStatus: 'failed',
						runStatus: 'failed',
						phase: 'model',
						active: false,
						directiveState: 'settled'
					}).pipe(
						Effect.andThen(wakeParent(EffectId.make(`${effectId}:failed-parent`), subject, task)),
						Effect.ignore
					)
				),
				Effect.ensuring(
					tasks
						.execute(EffectId.make(`${effectId}:settled`), { _tag: 'Settled', taskId })
						.pipe(Effect.ignore)
				)
			);
		});

		const control = Effect.fn('Agents.control')(function* (
			effectId: EffectId,
			subject: Identity.Subject,
			request: TaskControlRequest
		) {
			const result = yield* controlTask(effectId, subject, request.taskId, request.action);
			return {
				taskId: request.taskId,
				status: yield* Schema.decodeUnknownEffect(TaskStatus)(result.status)
			} satisfies TaskControlResult;
		});

		return Service.of({
			submit,
			editMessage,
			control,
			execute: (effectId, subject, taskId) => execute(effectId, subject, taskId)
		} as Interface);
	})
);
