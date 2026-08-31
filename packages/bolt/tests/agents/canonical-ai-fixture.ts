import type {
	AIRequest,
	AIResponse,
	FacilityBinding,
	FacilityResult
} from '@norbital-ai/bolt-protocol';
import type { ModelMessage } from '@tanstack/ai';
import { Schema } from 'effect';

type JsonModelMessage = ModelMessage & Schema.JsonObject;

export const TEST_MODEL = 'test-model';

export const modelCatalogResponse = (): Promise<FacilityResult<AIResponse>> =>
	Promise.resolve({
		_tag: 'Success',
		value: {
			output: {
				defaultModel: TEST_MODEL,
				options: [{ id: TEST_MODEL, contextLength: 128_000 }]
			}
		}
	});

export const assistantText = (content: string, id?: string): JsonModelMessage =>
	({
		...(id === undefined ? {} : { id }),
		role: 'assistant',
		content
	}) as unknown as JsonModelMessage;

export const assistantToolCall = (
	name: string,
	input: unknown,
	id: string,
	content = ''
): JsonModelMessage =>
	({
		id: `assistant-${id}`,
		role: 'assistant',
		content,
		toolCalls: [
			{
				id,
				type: 'function',
				function: { name, arguments: JSON.stringify(input) }
			}
		]
	}) as unknown as JsonModelMessage;

export const successfulAI = (
	turn: (
		request: Extract<AIRequest, { readonly _tag: 'Turn' }>,
		index: number
	) => AIResponse
): FacilityBinding<AIRequest, AIResponse> => {
	let index = 0;
	return {
		call: (_metadata, request) => {
			if (request._tag === 'Models') return modelCatalogResponse();
			if (request._tag !== 'Turn') {
				return Promise.resolve({
					_tag: 'Failure',
					error: {
						code: 'unsupported',
						message: 'The fixture only supports model catalog and chat turns.',
						retryable: false,
						outcome: 'known'
					}
				});
			}
			const value = turn(request, index);
			index += 1;
			return Promise.resolve({ _tag: 'Success', value });
		}
	};
};

export const modelMessages = (
	request: Extract<AIRequest, { readonly _tag: 'Turn' }>
): ReadonlyArray<ModelMessage> =>
	request.messages as unknown as ReadonlyArray<ModelMessage>;

export const lastToolResult = (
	request: Extract<AIRequest, { readonly _tag: 'Turn' }>
): Readonly<Record<string, unknown>> | undefined => {
	const message = modelMessages(request).findLast((candidate) => candidate.role === 'tool');
	if (message?.role !== 'tool' || typeof message.content !== 'string') return undefined;
	try {
		const decoded: unknown = JSON.parse(message.content);
		return typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
			? (decoded as Readonly<Record<string, unknown>>)
			: undefined;
	} catch {
		return undefined;
	}
};
