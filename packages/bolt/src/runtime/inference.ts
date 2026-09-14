import { Cause, Effect, Exit, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { getErrorMessage } from '@norbital-ai/std';
import {
	AIRequest,
	EffectId,
	HostToolCatalog,
	ImageAsset,
	ModelId,
	ProviderCallId,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import type { ConversationId } from '@norbital-ai/bolt-protocol/facilities';
import type { FileRef } from '#lib/authoring/models-schema.js';
import type { AIInterface, HostToolsInterface } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import * as Identity from '#lib/runtime/identity/identity.js';

/**
 * The authored `api.infer`: a structured inference that may research with tools first.
 *
 * Owned in one place so hooks, automations and remotes share one contract with the AI facility.
 * The authored schema remains the local decode authority; the provider receives Effect messages
 * and the host resolves image descriptors before its provider call. Without tools the call is a
 * single schema-constrained turn. With tools the model runs a bounded loop of tool turns — each
 * tool an authored closure executed inside this invocation — and the loop closes with the same
 * schema-constrained turn over everything it gathered.
 */
/** One image an authored `api.infer` attached to its turn, taken straight from a `file()` column. */
export type AuthoredInferenceImage = Readonly<{
	readonly file: FileRef;
	readonly detail?: 'auto' | 'low' | 'high';
}>;

/**
 * One authored inference as the ops surface carries it: the schema the answer must decode to, and
 * the picture words to judge against.
 *
 * Named rather than inline because `AuthoringOps.infer` and the object literal behind the
 * authored `api.infer` must carry the same shape, and that shape is the contract between the
 * authoring surface and the AI facility.
 */
export type InferenceRequest = Readonly<{
	readonly schema: Schema.Codec<unknown, unknown>;
	/** Standing directive: identity, the current state, and the goal. Sent as the system message. */
	readonly system?: string;
	readonly prompt: string;
	readonly model: string;
	readonly images?: ReadonlyArray<AuthoredInferenceImage>;
	readonly tools?: ReadonlyArray<AuthoredInferenceTool>;
	/**
	 * Host capabilities the turn may call, named as the host advertises them.
	 *
	 * The runtime resolves each name against the host's own catalogue and dispatches the call
	 * itself, so an authored handler drives the same browser/tool surface an agent does without
	 * the host tool's internals leaking into the workspace. A name the host does not advertise is
	 * a refusal, never a silently missing tool.
	 */
	readonly hostTools?: ReadonlyArray<string>;
}>;

/** What an invocation must carry for an authored inference to call host tools. */
export type InferenceHostToolContext = Readonly<{
	readonly effectId: EffectIdType;
	readonly subject: Identity.Subject;
	/** The conversation the call belongs to, when there is one; the host scopes sessions by it. */
	readonly conversationId?: ConversationId;
	readonly hostTools: HostToolsInterface;
}>;

/**
 * One tool an authored `api.infer` lets the model call before it answers.
 *
 * The model decides whether and how often to call it, with no step cap; the author decides what it does. `run`
 * executes inside the authored invocation, so a tool is an ordinary closure over `api` (a page
 * read through `api.readUrl`, a lookup through `api.db`) and its result is what the model sees
 * next. A failure becomes a failed tool result the model can react to, never a dropped turn.
 */
export type AuthoredInferenceTool = Readonly<{
	readonly name: string;
	readonly description: string;
	readonly input: Schema.Codec<unknown, unknown>;
	run(input: unknown): Effect.Effect<unknown, unknown, never>;
}>;

/**
 * How much of a turn an authored `api.infer` may spend on pictures.
 *
 * Both are refusals, not truncations: a bound that silently dropped an image would leave the model
 * answering about a scene it was never shown, which reads exactly like it answering correctly.
 */
const MAX_INFERENCE_IMAGES = 8;
const MAX_INFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * The name reserved for the tool call that carries the final structured result.
 *
 * An authored tool may not use it: the loop must be able to tell a research call from the answer.
 */
const INFERENCE_RESULT_TOOL = 'return_result';
/** How many consecutive reason-only turns are tolerated before the inference is refused. */
const MAX_INFERENCE_PAUSES = 3;
/** How many malformed submissions are corrected before the inference is refused. */
const MAX_INFERENCE_RESULT_FAILURES = 3;
/**
 * Automatic context maintenance for the inference loop.
 *
 * The loop appends every tool result and would otherwise grow past the model's window, at which
 * point the host refuses the call. When the conversation passes this size, older tool results are
 * replaced with a short stub while the most recent ones stay whole: the model can re-open a source
 * if it still needs the detail, and the loop stays inside the window with no caller tuning.
 */
const MAX_INFERENCE_CONTEXT_CHARS = 400_000;
const KEEP_RECENT_TOOL_RESULTS = 4;

/**
 * Bounds on what one tool turn may carry. The loop itself has no step cap: the model calls tools
 * until it is ready to answer, and only then is the structured turn asked for.
 *
 * A tool result is clipped to a fixed size because the loop's whole history rides into every later
 * turn and one unbounded page would push the closing turn past the model's context, which
 * surfaces as an empty or invalid structured answer rather than as the page being too large.
 */
const MAX_INFERENCE_TOOL_RESULT_CHARS = 24_000;
const MAX_INFERENCE_TOOLS = 16;
const INFERENCE_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const encodePromptMessage = Schema.encodeSync(Prompt.Message);

/** The tool calls an assistant turn asked for, in provider order. */
const inferenceToolCalls = (
	message: Prompt.MessageEncoded
): ReadonlyArray<Readonly<{ id: string; name: string; params: unknown }>> =>
	typeof message.content === 'string'
		? []
		: message.content.flatMap((part) =>
				part.type === 'tool-call' ? [{ id: part.id, name: part.name, params: part.params }] : []
			);

/** Serialises a tool result for the model, clipped so one result cannot consume the conversation. */
const clipToolResult = (value: unknown): unknown => {
	const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
	if (text.length <= MAX_INFERENCE_TOOL_RESULT_CHARS) return value;
	return `${text.slice(0, MAX_INFERENCE_TOOL_RESULT_CHARS)}… [clipped: ${text.length} characters; ask for a narrower result]`;
};

/**
 * The provider-neutral ImageAsset descriptors an authored `api.infer` sends beside its Effect
 * message. Bytes remain host-only and provider dialect remains Colony-only.
 *
 * Bytes must not be read or base64-expanded here: a 1 MiB JPEG becomes a request larger than the
 * facility bridge's 1 MiB ceiling, and encoding a review batch consumes the isolate's CPU budget.
 */
const inferenceImageAssets = (
	images: ReadonlyArray<AuthoredInferenceImage> | undefined
): Effect.Effect<ReadonlyArray<ImageAsset>, Database.FacilityError> =>
	Effect.gen(function* () {
		if (images === undefined || images.length === 0) return [];
		const refuse = (code: string, message: string) =>
			new Database.FacilityError({
				operation: 'ai.generate',
				code,
				message,
				retryable: false,
				outcome: 'known'
			});
		if (images.length > MAX_INFERENCE_IMAGES) {
			return yield* refuse(
				'ai.too_many_images',
				`An inference turn carries at most ${MAX_INFERENCE_IMAGES} images; ${images.length} were passed.`
			);
		}
		const assets: Array<ImageAsset> = [];
		let total = 0;
		for (const image of images) {
			const file = image.file;
			if (file.storage_key.trim() === '' || file.file_name.trim() === '') {
				return yield* refuse(
					'ai.asset_missing',
					'This image value names no stored object, so there is nothing to send.'
				);
			}
			if (!file.mime_type.startsWith('image/')) {
				return yield* refuse(
					'ai.not_an_image',
					`${file.file_name} is ${file.mime_type || 'of unknown type'}, which is not an image.`
				);
			}
			if (!Number.isInteger(file.file_size) || file.file_size < 0) {
				return yield* refuse(
					'ai.invalid_image_size',
					`${file.file_name} has an invalid declared size.`
				);
			}
			total += file.file_size;
			if (total > MAX_INFERENCE_IMAGE_BYTES) {
				return yield* refuse(
					'ai.images_too_large',
					`The images on one inference turn total more than ${MAX_INFERENCE_IMAGE_BYTES} bytes.`
				);
			}
			assets.push(
				ImageAsset.make({
					key: file.storage_key,
					name: file.file_name,
					mimeType: file.mime_type,
					size: file.file_size,
					...(image.detail === undefined ? {} : { detail: image.detail })
				})
			);
		}
		return assets;
	});

/**
 * The `infer` member of the authoring api, owned in one place.
 *
 * The authored schema remains the local decode authority. The provider receives one encoded Effect
 * message and the host resolves any image descriptors before its provider call.
 */
export const inferOp = (
	effectId: EffectIdType,
	ai: AIInterface,
	host?: InferenceHostToolContext
) => {
	let sequence = 0;
	return (input: InferenceRequest): Effect.Effect<unknown, Database.FacilityError> =>
		Effect.gen(function* () {
			// A handler can research several lineages concurrently or ask again after a rejection.
			// Provider call ids become idempotency keys, so each inference needs its own child id.
			const inferenceId = EffectId.make(`${effectId}:infer:${++sequence}`);
			const refusal = (code: string, message: string) =>
				new Database.FacilityError({
					operation: 'ai.generate',
					code,
					message,
					retryable: false,
					outcome: 'known'
				});
			const unsupportedKeys = Object.keys(input).filter(
				(key) =>
					key !== 'schema' &&
					key !== 'system' &&
					key !== 'prompt' &&
					key !== 'model' &&
					key !== 'images' &&
					key !== 'tools' &&
					key !== 'hostTools'
			);
			if (unsupportedKeys.length > 0) {
				return yield* refusal(
					'ai.request_invalid',
					'api.infer received unsupported request fields.'
				);
			}
			const modelId = yield* Schema.decodeUnknownEffect(ModelId)(input.model).pipe(
				Effect.mapError(() =>
					refusal('ai.model_invalid', 'api.infer requires a non-empty model id.')
				)
			);
			const imageAssets = yield* inferenceImageAssets(input.images);
			const jsonSchema = Schema.toJsonSchemaDocument(input.schema).schema;
			const encode = (message: Prompt.Message) =>
				Schema.encodeEffect(Prompt.Message)(message).pipe(
					Effect.mapError(() =>
						refusal('ai.message_invalid', 'The Effect prompt could not be encoded.')
					)
				);
			const message = yield* encode(
				Prompt.userMessage({ content: [Prompt.textPart({ text: input.prompt })] })
			);
			const system =
				input.system === undefined
					? undefined
					: yield* encode(Prompt.systemMessage({ content: input.system }));
			const tools = input.tools ?? [];
			if (tools.length > MAX_INFERENCE_TOOLS)
				return yield* refusal(
					'ai.request_invalid',
					`api.infer accepts at most ${MAX_INFERENCE_TOOLS} tools; ${tools.length} were passed.`
				);
			const toolNames = new Set<string>();
			for (const tool of tools) {
				if (!INFERENCE_TOOL_NAME.test(tool.name) || toolNames.has(tool.name))
					return yield* refusal(
						'ai.request_invalid',
						`api.infer tool names must be unique snake_case identifiers; "${tool.name}" is not.`
					);
				if (tool.description.trim() === '')
					return yield* refusal(
						'ai.request_invalid',
						`api.infer tool "${tool.name}" needs a description the model can choose it by.`
					);
				toolNames.add(tool.name);
			}
			/**
			 * Resolve the host tools the request names against the host's own catalogue.
			 *
			 * A name the host does not advertise refuses here rather than reaching the provider as a
			 * tool the model can call and the loop cannot dispatch: a browser read the host does not
			 * offer must read as an authoring mistake, not as an answer researched without it.
			 */
			const requestedHostTools = [...new Set(input.hostTools ?? [])];
			let hostTools: ReadonlyArray<{
				readonly name: string;
				readonly description: string;
				readonly inputSchema: Schema.JsonObject;
			}> = [];
			if (requestedHostTools.length > 0) {
				if (host === undefined)
					return yield* refusal(
						'ai.request_invalid',
						'api.infer was asked for host tools, but this invocation has no host tool binding: only automation and hook work carries one.'
					);
				const catalogue = yield* host.hostTools
					.execute(EffectId.make(`${inferenceId}:catalog`), {
						tool: 'capability_catalog',
						input: {}
					})
					.pipe(
						Effect.mapError((error) =>
							refusal('ai.host_tools_unavailable', getErrorMessage(error))
						),
						Effect.flatMap(({ output }) =>
							Schema.decodeUnknownEffect(HostToolCatalog)(output).pipe(
								Effect.mapError(() =>
									refusal('ai.host_tools_unavailable', 'The host tool catalogue could not be read.')
								)
							)
						)
					);
				hostTools = requestedHostTools.flatMap((name) => {
					const tool = catalogue.tools.find((candidate) => candidate.name === name);
					return tool === undefined ? [] : [tool];
				});
				const unknown = requestedHostTools.filter(
					(name) => !hostTools.some((tool) => tool.name === name)
				);
				if (unknown.length > 0)
					return yield* refusal(
						'ai.request_invalid',
						`This host advertises no ${unknown.map((name) => `"${name}"`).join(', ')} tool.`
					);
				for (const tool of hostTools) {
					if (toolNames.has(tool.name))
						return yield* refusal(
							'ai.request_invalid',
							`api.infer names "${tool.name}" both as an authored tool and as a host tool; keep one.`
						);
					toolNames.add(tool.name);
				}
			}
			/** One host tool call, dispatched with the invocation's own identity. */
			const callHostTool = (
				context: InferenceHostToolContext,
				call: Readonly<{ id: string; name: string; params: unknown }>
			) => {
				const requested = context.hostTools
					.execute(EffectId.make(`${inferenceId}:host:${call.id}`), {
						tool: call.name,
						input: call.params as Schema.Json,
						...(context.conversationId === undefined ? {} : { sessionId: context.conversationId })
					})
					.pipe(
						Effect.map((response) => response.output),
						Effect.mapError((error) => getErrorMessage(error))
					);
				return context.subject.system !== true && context.subject.policies.length === 0
					? requested.pipe(Effect.provideService(Identity.CurrentSubject, context.subject))
					: requested;
			};
			const conversation: Array<Prompt.MessageEncoded> = [
				...(system === undefined ? [] : [system]),
				message
			];
			const assets = imageAssets.length === 0 ? {} : { imageAssets };
			/** Replace older tool evidence with a stub once the loop approaches the model window. */
			const maintainInferenceContext = (): void => {
				if (JSON.stringify(conversation).length <= MAX_INFERENCE_CONTEXT_CHARS) return;
				const toolIndexes = conversation.flatMap((entry, index) =>
					entry.role === 'tool' ? [index] : []
				);
				const keep = new Set(toolIndexes.slice(-KEEP_RECENT_TOOL_RESULTS));
				for (const index of toolIndexes) {
					if (keep.has(index)) continue;
					const entry = conversation[index];
					if (entry === undefined || entry.role !== 'tool' || typeof entry.content === 'string')
						continue;
					conversation[index] = {
						...entry,
						content: entry.content.map((part) =>
							part.type === 'tool-result'
								? {
										...part,
										result:
											'[older tool result trimmed to keep the loop inside the model window; re-read the source if you need its detail]'
									}
								: part
						)
					};
				}
			};
			/**
			 * The loop is an ordinary agentic run whose final structured answer is a tool call.
			 *
			 * A schema-constrained single turn forces the model's reasoning and its whole answer into
			 * one output budget. DeepSeek V4.1 Flash counts reasoning against `max_tokens`, so a
			 * research prompt that reasons past the budget returns no content at all — the
			 * "No text content in response" failure — and retrying the identical request repeats the
			 * same exhaustion. Running the authored tools as a normal multi-turn loop and taking the
			 * answer from a reserved submission tool lets reasoning span turns, each with its own
			 * budget, and never asks the provider to emit a strict JSON value in the same breath as
			 * the reasoning that produced it.
			 */
			if (toolNames.has(INFERENCE_RESULT_TOOL))
				return yield* refusal(
					'ai.request_invalid',
					`api.infer reserves the tool name "${INFERENCE_RESULT_TOOL}" for its structured result; rename the authored tool.`
				);
			const declarations = [
				...tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: Schema.toJsonSchemaDocument(tool.input).schema
				})),
				...hostTools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema
				})),
				{
					name: INFERENCE_RESULT_TOOL,
					description:
						'Submit the final structured result. Call this exactly once, when the research is complete, and call nothing else in that turn. Its arguments are the result.',
					inputSchema: jsonSchema
				}
			];
			let pauses = 0;
			let resultFailures = 0;
			for (let step = 0; ; step += 1) {
				const turn = yield* ai.generate(
					EffectId.make(`${inferenceId}:step:${step}`),
					AIRequest.cases.Generate.make({
						callId: ProviderCallId.make(`${inferenceId}:step:${step}`),
						modelId,
						messages: [...conversation],
						output: { _tag: 'Message', tools: declarations },
						...assets
					}),
					// Stream, with no-op progress: each streamed part re-arms the host's IO silence wall,
					// so a long reasoning turn is not mistaken for a mute facility.
					() => Effect.void
				);
				if (turn.result._tag !== 'Message')
					return yield* refusal(
						'ai.response_invalid',
						'The AI provider returned the wrong output kind for a tool turn.'
					);
				const calls = inferenceToolCalls(turn.result.message);
				const resultCall = calls.find((call) => call.name === INFERENCE_RESULT_TOOL);
				if (resultCall !== undefined) {
					const decoded = yield* Effect.exit(
						Schema.decodeUnknownEffect(input.schema)(resultCall.params)
					);
					if (Exit.isSuccess(decoded)) return decoded.value;
					if (++resultFailures > MAX_INFERENCE_RESULT_FAILURES)
						return yield* refusal(
							'ai.response_invalid',
							`The AI provider response does not match the authored schema: ${getErrorMessage(
								Cause.squash(decoded.cause)
							)
								.replace(/\s+/g, ' ')
								.slice(0, 400)}`
						);
					conversation.push(turn.result.message);
					conversation.push(
						encodePromptMessage(
							Prompt.toolMessage({
								content: [
									Prompt.toolResultPart({
										id: resultCall.id,
										name: resultCall.name,
										result:
											`The result did not match the schema: ${getErrorMessage(Cause.squash(decoded.cause)).replace(/\s+/g, ' ').slice(0, 400)}. ` +
											`Call "${INFERENCE_RESULT_TOOL}" again with the corrected result.`,
										isFailure: true,
										providerExecuted: false
									})
								]
							})
						)
					);
					continue;
				}
				if (calls.length === 0) {
					// The model reasoned without acting. Give it another turn rather than forcing the
					// answer into the turn its reasoning already spent.
					if (++pauses > MAX_INFERENCE_PAUSES)
						return yield* refusal(
							'ai.response_invalid',
							'api.infer ended without returning a structured result.'
						);
					conversation.push(turn.result.message);
					conversation.push(
						encodePromptMessage(
							Prompt.userMessage({
								content: [
									Prompt.textPart({
										text: `Call a research tool to continue, or call "${INFERENCE_RESULT_TOOL}" with the final result, matching this JSON schema:\n${JSON.stringify(jsonSchema)}`
									})
								]
							})
						)
					);
					continue;
				}
				conversation.push(turn.result.message);
				for (const call of calls) {
					const tool = tools.find(({ name }) => name === call.name);
					const isHostTool = hostTools.some(({ name }) => name === call.name);
					const outcome = isHostTool
						? host === undefined
							? Exit.fail('This invocation has no host tool binding.')
							: yield* Effect.exit(callHostTool(host, call))
						: tool === undefined
							? Exit.fail(
									`Unknown tool "${call.name}". Available: ${[...toolNames, INFERENCE_RESULT_TOOL].join(', ')}.`
								)
							: yield* Effect.exit(
									Schema.decodeUnknownEffect(tool.input)(call.params).pipe(
										Effect.mapError(
											() => `The arguments do not match the "${tool.name}" input schema.`
										),
										Effect.flatMap((params) =>
											tool.run(params).pipe(Effect.mapError((error) => getErrorMessage(error)))
										)
									)
								);
					conversation.push(
						encodePromptMessage(
							Prompt.toolMessage({
								content: [
									Prompt.toolResultPart({
										id: call.id,
										name: call.name,
										result: Exit.isSuccess(outcome)
											? clipToolResult(outcome.value)
											: getErrorMessage(Cause.squash(outcome.cause)),
										isFailure: !Exit.isSuccess(outcome),
										providerExecuted: false
									})
								]
							})
						)
					);
				}
				maintainInferenceContext();
			}
		});
};
