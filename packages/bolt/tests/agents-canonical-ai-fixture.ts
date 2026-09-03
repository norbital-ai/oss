import type {
	AIRequest,
	AIResponse,
	FacilityBinding,
	FacilityResult
} from '@norbital-ai/bolt-protocol';
import { ModelId } from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';

type GenerateRequest = Extract<AIRequest, { readonly _tag: 'Generate' }>;

const encodeMessage = Schema.encodeSync(Prompt.Message);

export const TEST_MODEL = ModelId.make('test-provider/test-language-model');
export const TEST_EMBEDDING_MODEL = ModelId.make('test-provider/test-embedding-model');

export const modelCatalogResponse = (): Promise<FacilityResult<AIResponse>> =>
	Promise.resolve({
		_tag: 'Success',
		value: {
			_tag: 'Catalog',
			languageModels: [{ id: TEST_MODEL }],
			defaultLanguageModelId: TEST_MODEL,
			embeddingModels: [{ id: TEST_EMBEDDING_MODEL }],
			defaultEmbeddingModelId: TEST_EMBEDDING_MODEL
		}
	});

export const assistantText = (content: string): Prompt.MessageEncoded =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [Prompt.textPart({ text: content })]
		})
	);

export const assistantToolCall = (
	name: string,
	input: unknown,
	id: string,
	content = ''
): Prompt.MessageEncoded =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [
				...(content === '' ? [] : [Prompt.textPart({ text: content })]),
				Prompt.toolCallPart({
					id,
					name,
					params: input,
					providerExecuted: false
				})
			]
		})
	);

export const successfulAI = (
	generate: (
		request: GenerateRequest,
		index: number
	) => Prompt.MessageEncoded | Promise<Prompt.MessageEncoded>
): FacilityBinding<AIRequest, AIResponse> => {
	let index = 0;
	return {
		call: async (_metadata, request) => {
			if (request._tag === 'Catalog') return modelCatalogResponse();
			if (request._tag !== 'Generate') {
				return {
					_tag: 'Failure',
					error: {
						code: 'unsupported',
						message: 'The fixture only supports language catalog and generation.',
						retryable: false,
						outcome: 'known'
					}
				};
			}
			if (request.output._tag !== 'Message') {
				return {
					_tag: 'Failure',
					error: {
						code: 'unexpected_generation_output',
						message: 'The chat fixture requires Message generation output.',
						retryable: false,
						outcome: 'known'
					}
				};
			}
			const message = await generate(request, index);
			index += 1;
			return {
				_tag: 'Success',
				value: {
					_tag: 'Generated',
					result: { _tag: 'Message', message },
					observation: {
						callId: request.callId,
						provider: 'test-provider',
						model: request.modelId,
						operation: 'language'
					}
				}
			};
		}
	};
};

export const modelMessages = (
	request: GenerateRequest
): ReadonlyArray<Prompt.MessageEncoded> => request.messages;

export const lastToolResult = (
	request: GenerateRequest
): Readonly<Record<string, unknown>> | undefined => {
	for (const message of request.messages.toReversed()) {
		if (message.role !== 'tool' || typeof message.content === 'string') continue;
		for (const part of message.content.toReversed()) {
			if (part.type !== 'tool-result') continue;
			const result = part.result;
			if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
				return result as Readonly<Record<string, unknown>>;
			}
		}
	}
	return undefined;
};
