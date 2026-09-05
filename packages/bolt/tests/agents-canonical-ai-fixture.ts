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

/**
 * A scripted Plan verification verdict. The default fixture verdict is always complete; a test
 * that needs the verify phase to bite scripts these in call order.
 */
export type PlanVerdictReply = Readonly<{
	readonly complete: boolean;
	readonly summary: string;
	readonly gaps?: ReadonlyArray<string>;
}>;

export type SuccessfulAIOptions = Readonly<{
	readonly verdicts?: ReadonlyArray<PlanVerdictReply>;
	readonly onVerdict?: (request: GenerateRequest) => void;
}>;

export const successfulAI = (
	generate: (
		request: GenerateRequest,
		index: number
	) => Prompt.MessageEncoded | Promise<Prompt.MessageEncoded>,
	options: SuccessfulAIOptions = {}
): FacilityBinding<AIRequest, AIResponse> => {
	let index = 0;
	const verdicts = [...(options.verdicts ?? [])];
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
			if (request.output._tag === 'PlanVerdict') {
				index += 1;
				options.onVerdict?.(request);
				const scripted = verdicts.shift() ?? {
					complete: true,
					summary: 'Every verification criterion is evidenced.',
					gaps: []
				};
				return {
					_tag: 'Success',
					value: {
						_tag: 'Generated',
						result: {
							_tag: 'PlanVerdict',
							verdict: {
								complete: scripted.complete,
								summary: scripted.summary,
								gaps: scripted.gaps ?? []
							}
						},
						observation: {
							callId: request.callId,
							provider: 'test-provider',
							model: request.modelId,
							operation: 'language'
						}
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

export const modelMessages = (request: GenerateRequest): ReadonlyArray<Prompt.MessageEncoded> =>
	request.messages;

export const assistantToolCalls = (
	calls: ReadonlyArray<
		Readonly<{ readonly name: string; readonly input: unknown; readonly id?: string }>
	>
): Prompt.MessageEncoded =>
	encodeMessage(
		Prompt.assistantMessage({
			content: calls.map((call, index) =>
				Prompt.toolCallPart({
					id: call.id ?? `${call.name}-${index + 1}`,
					name: call.name,
					params: call.input,
					providerExecuted: false
				})
			)
		})
	);

const encodedText = (message: Prompt.MessageEncoded): string =>
	typeof message.content === 'string'
		? message.content
		: message.content
				.flatMap((part) => (part.type === 'text' || part.type === 'reasoning' ? [part.text] : []))
				.join('\n');

export type GenerateInspection = Readonly<{
	readonly callId: string;
	readonly maxOutputTokens: number;
	readonly promptBytes: number;
	readonly automaticCompact: boolean;
	readonly planMode: boolean;
	readonly compactMode: boolean;
	readonly roles: ReadonlyArray<string>;
}>;

export const inspectGenerate = (request: GenerateRequest): GenerateInspection => {
	const encoded = JSON.stringify(request.messages) ?? '';
	const texts = request.messages.map(encodedText);
	return {
		callId: request.callId,
		maxOutputTokens: request.maxOutputTokens,
		promptBytes: new TextEncoder().encode(encoded).byteLength,
		automaticCompact: texts.some((text) => text.includes('Automatic Compact:')),
		planMode: texts.some((text) => text.startsWith('Plan mode:')),
		compactMode: texts.some((text) =>
			text.includes(
				'Compact mode: summarize durable context without performing work or calling tools.'
			)
		),
		roles: request.messages.map((message) => message.role)
	};
};

export type TranscriptReply =
	| Prompt.MessageEncoded
	| ((
			request: GenerateRequest,
			inspection: GenerateInspection
	  ) => Prompt.MessageEncoded | Promise<Prompt.MessageEncoded>);

/**
 * Streams a scripted assistant transcript into the AI facility.
 *
 * Automatic Compact is an extra Generate the runtime inserts before the scripted turn when the
 * projected prompt exceeds 64 KiB in agent mode. That call is answered here and does not consume
 * a scripted reply, so the feed still records what the model was given.
 */
export const scriptedTranscript = (
	script: ReadonlyArray<TranscriptReply>,
	options: SuccessfulAIOptions = {}
): {
	readonly ai: FacilityBinding<AIRequest, AIResponse>;
	readonly feed: GenerateInspection[];
	readonly requests: GenerateRequest[];
	/** The PlanVerdict Generate calls in arrival order. */
	readonly verdictRequests: GenerateRequest[];
} => {
	const feed: GenerateInspection[] = [];
	const requests: GenerateRequest[] = [];
	const verdictRequests: GenerateRequest[] = [];
	let scriptIndex = 0;
	return {
		feed,
		requests,
		verdictRequests,
		ai: successfulAI(
			(request) => {
				requests.push(request);
				const inspection = inspectGenerate(request);
				feed.push(inspection);
				if (inspection.automaticCompact) {
					return assistantText(
						'Retained: the current user instruction, open decisions, and unresolved work.'
					);
				}
				const reply = script[scriptIndex];
				scriptIndex += 1;
				if (reply === undefined) {
					throw new Error(`scripted transcript exhausted after ${script.length} replies`);
				}
				return typeof reply === 'function' ? reply(request, inspection) : reply;
			},
			{
				...options,
				onVerdict: (request) => verdictRequests.push(request)
			}
		)
	};
};

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

/** The first tool result recorded for one tool name, searched newest-first. */
export const toolResultFor = (request: GenerateRequest, name: string): unknown | undefined => {
	for (const message of request.messages.toReversed()) {
		if (message.role !== 'tool' || typeof message.content === 'string') continue;
		for (const part of message.content) {
			if (part.type === 'tool-result' && part.name === name) return part.result;
		}
	}
	return undefined;
};

/** Every tool result for one tool name across the request, in transcript order. */
export const toolResultsFor = (request: GenerateRequest, name: string): ReadonlyArray<unknown> => {
	const results: Array<unknown> = [];
	for (const message of request.messages) {
		if (message.role !== 'tool' || typeof message.content === 'string') continue;
		for (const part of message.content) {
			if (part.type === 'tool-result' && part.name === name) results.push(part.result);
		}
	}
	return results;
};

/** The newest failed tool result, as the Toolkit encoded the failure. */
export const lastToolFailure = (
	request: GenerateRequest
):
	| Readonly<{ readonly name: string; readonly failure: Readonly<Record<string, unknown>> }>
	| undefined => {
	for (const message of request.messages.toReversed()) {
		if (message.role !== 'tool' || typeof message.content === 'string') continue;
		for (const part of message.content.toReversed()) {
			if (part.type !== 'tool-result' || part.isFailure !== true) continue;
			const result = part.result;
			if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
				return { name: part.name, failure: result as Readonly<Record<string, unknown>> };
			}
		}
	}
	return undefined;
};
