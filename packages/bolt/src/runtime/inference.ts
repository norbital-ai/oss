import { Cause, Effect, Exit, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { getErrorMessage } from '@norbital-ai/std';
import {
	AIRequest,
	EffectId,
	ImageAsset,
	ModelId,
	ProviderCallId,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import type { FileRef } from '#lib/authoring/models-schema.js';
import type { AIInterface } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';

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
	readonly prompt: string;
	readonly model: string;
	readonly images?: ReadonlyArray<AuthoredInferenceImage>;
	readonly tools?: ReadonlyArray<AuthoredInferenceTool>;
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

/** Leaves schema-constrained inference enough room to finish one complete JSON value. */
const MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS = 8_192;

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
/**
 * The most tool turns one inference may take before it must answer.
 *
 * Without this the loop is bounded only by the model deciding to stop, and a research prompt that
 * keeps asking for another page never does. Bounded, the worst case is this many provider calls.
 */
const MAX_INFERENCE_TOOL_TURNS = 12;
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
export const inferOp =
	(effectId: EffectIdType, ai: AIInterface) =>
	(input: InferenceRequest): Effect.Effect<unknown, Database.FacilityError> =>
		Effect.gen(function* () {
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
					key !== 'prompt' &&
					key !== 'model' &&
					key !== 'images' &&
					key !== 'tools'
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
			const message = yield* Schema.encodeEffect(Prompt.Message)(
				Prompt.userMessage({ content: [Prompt.textPart({ text: input.prompt })] })
			).pipe(
				Effect.mapError(() =>
					refusal('ai.message_invalid', 'The Effect prompt could not be encoded.')
				)
			);
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
			const conversation: Array<Prompt.MessageEncoded> = [message];
			const assets = imageAssets.length === 0 ? {} : { imageAssets };
			if (tools.length > 0) {
				const declarations = tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: Schema.toJsonSchemaDocument(tool.input).schema
				}));
				for (let step = 0; ; step += 1) {
					if (step >= MAX_INFERENCE_TOOL_TURNS)
						return yield* refusal(
							'ai.tool_loop_unbounded',
							`The model requested tools for ${MAX_INFERENCE_TOOL_TURNS} turns without answering; refusing to continue.`
						);
					const turn = yield* ai.generate(
						EffectId.make(`${effectId}:infer:step:${step}`),
						AIRequest.cases.Generate.make({
							callId: ProviderCallId.make(`${effectId}:infer:step:${step}`),
							modelId,
							messages: [...conversation],
							maxOutputTokens: MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
							output: { _tag: 'Message', tools: declarations },
							...assets
						})
					);
					if (turn.result._tag !== 'Message')
						return yield* refusal(
							'ai.response_invalid',
							'The AI provider returned the wrong output kind for a tool turn.'
						);
					conversation.push(turn.result.message);
					const calls = inferenceToolCalls(turn.result.message);
					if (calls.length === 0) break;
					for (const call of calls) {
						const tool = tools.find(({ name }) => name === call.name);
						const outcome =
							tool === undefined
								? Exit.fail(`Unknown tool "${call.name}". Available: ${[...toolNames].join(', ')}.`)
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
				}
				conversation.push(
					encodePromptMessage(
						Prompt.userMessage({
							content: [
								Prompt.textPart({
									text: 'Return the structured result now, from the evidence gathered above. Do not call tools.'
								})
							]
						})
					)
				);
			}
			const response = yield* ai.generate(
				effectId,
				AIRequest.cases.Generate.make({
					callId: ProviderCallId.make(`${effectId}:infer`),
					modelId,
					messages: conversation,
					maxOutputTokens: MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
					output: { _tag: 'Object', objectName: 'inference', jsonSchema },
					...assets
				})
			);
			if (response.result._tag !== 'Object') {
				return yield* refusal(
					'ai.response_invalid',
					'The AI provider returned the wrong output kind.'
				);
			}
			return yield* Schema.decodeUnknownEffect(input.schema)(response.result.value).pipe(
				Effect.mapError((error) =>
					// The path matters: "eligibility: null where an array or omission was expected" is
					// actionable; "does not match the authored schema" sent a day into guesswork.
					refusal(
						'ai.response_invalid',
						`The AI provider response does not match the authored schema: ${String(error).replace(/\s+/g, ' ').slice(0, 400)}`
					)
				)
			);
		});
