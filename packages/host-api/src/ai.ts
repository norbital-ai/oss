// The intelligence facility: System 1's structured decisions, System 2's model calls and embeddings.
import { Schema, type Stream } from 'effect';
import type { PortFailure } from './errors.ts';
import type { Json } from '@norbital-ai/store';

/** The host's system-2 answer; transcript storage keeps its native toolCalls projection behind the adapter. */
export const AiPortResponseSchema = Schema.Struct({
	content: Schema.Json,
	tool_calls: Schema.Array(Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		input: Schema.Json,
		invalid: Schema.optionalKey(Schema.String)
	})),
	finish: Schema.Literals(['stop', 'tool', 'cut']),
	continuation: Schema.optionalKey(Schema.String),
	reasoning: Schema.optionalKey(Schema.String),
	usage: Schema.Struct({
		input: Schema.Number,
		output: Schema.Number,
		cost: Schema.optionalKey(Schema.Number),
		call: Schema.optionalKey(Schema.String),
		provider: Schema.optionalKey(Schema.String),
		cached: Schema.optionalKey(Schema.Number),
		reasoning: Schema.optionalKey(Schema.Number),
		prompt: Schema.optionalKey(Schema.Struct({ system: Schema.Number, messages: Schema.Number, tools: Schema.Number }))
	})
});
/** The host's system-2 answer (`AiPortResponseSchema`): content, tool calls, how it finished and its usage. */
export type AiResponse = typeof AiPortResponseSchema.Type;

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const Entry = Schema.Union([
	Schema.String,
	Schema.Null,
	Schema.Array(Schema.Json),
	Schema.Record(Schema.String, Schema.Json)
]);
const Question = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('noul'),
		instructions: Schema.optionalKey(Entry),
		criteria: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({ true: Schema.optionalKey(Entry), false: Schema.optionalKey(Entry) })
			)
		)
	}),
	Schema.Struct({
		type: Schema.Literal('choice'),
		instructions: Schema.optionalKey(Entry),
		criteria: Schema.Record(Schema.String, Entry).check(
			Schema.makeFilter((value) => Object.keys(value).length > 0)
		)
	}),
	Schema.Struct({
		type: Schema.Literal('score'),
		instructions: Schema.optionalKey(Entry),
		criteria: Schema.Array(Entry).check(Schema.isMinLength(1), Schema.isMaxLength(10))
	})
]);
/** One System 1 call: the state it reads and its questions by key. */
export const DecisionRequestSchema = Schema.Struct({
	state: Schema.Union([
		Schema.String,
		Schema.Array(Schema.Json),
		Schema.Record(Schema.String, Schema.Json)
	]),
	questions: Schema.Record(Schema.String, Question).check(
		Schema.makeFilter((value) => Object.keys(value).length > 0)
	)
});
/** One System 1 call (`DecisionRequestSchema`): the state it reads and its questions by key. */
export type DecisionRequest = typeof DecisionRequestSchema.Type;
const DecisionAnswerSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal('noul'), noul: Probability }),
	Schema.Struct({
		type: Schema.Literal('choice'),
		choice: Schema.String,
		confidence: Schema.Finite,
		probabilities: Schema.Record(Schema.String, Schema.Finite)
	}),
	Schema.Struct({
		type: Schema.Literal('score'),
		score: Schema.Finite,
		level: Schema.Int,
		confidence: Schema.Finite,
		probabilities: Schema.Record(Schema.String, Schema.Finite),
		legend: Schema.Record(Schema.String, Entry)
	})
]);
/** One System 1 answer to a question: a `noul` probability, a `choice` or a `score`, each with its probabilities. */
export type DecisionAnswer = typeof DecisionAnswerSchema.Type;
/** Schema of a System 1 answer set: one answer per question key, with the provider, model, cost and token usage. */
export const DecisionResult = Schema.Struct({
	answers: Schema.Record(Schema.String, DecisionAnswerSchema),
	cost_usd: Schema.Finite,
	provider: Schema.String,
	model: Schema.optionalKey(Schema.String),
	call: Schema.optionalKey(Schema.String),
	tokens: Schema.optionalKey(Schema.Struct({ input: Schema.Number, output: Schema.Number }))
});
export type DecisionResult = typeof DecisionResult.Type;
/** Fast structured decisions (`ctx.ai.sys_1.decide`, triage). */
export interface System1Port {
	ask(request: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
	readonly max_choices?: number;
}

/** One transcript message the AI port sends the model: who said it and its content. */
export type AiMessage = { role: 'user' | 'assistant' | 'tool'; content: Json };
/** One model call the engine hands the AI port: model, system prompt, messages, tools, optional output schema and files. */
export type AiRequest = {
	model: string;
	/** Host usage attribution; omitted for utility inference, set by the conversation engine for chat work. */
	purpose?: 'chat';
	system?: string;
	messages: readonly AiMessage[];
	tools?: readonly { name: string; description: string; input: Json }[];
	output?: Json;
	/** Images and documents for the model to see; `call` is the tool call that opened one, which it follows. */
	files?: readonly { mime: string; bytes: Uint8Array; call?: string }[];
	continuation?: string;
};
/** Bytes supplied by a host, or a stored file the provider reads outside the cell. */
export type EmbedInput =
	| string
	| {
			readonly $file: {
				readonly name: string;
				readonly mime: string;
				readonly sha256: string;
				readonly bytes: Uint8Array;
			};
	  }
	| {
			readonly $stored: {
				readonly key: string;
				readonly name: string;
				readonly mime: string;
				readonly sha256: string;
				readonly bytes: number;
			};
	  };
/** One model a person may pick (the panel lists `label`, grouped by `provider`); `context` is its window in tokens. */
export type AiModel = { id: string; label: string; provider?: string; context?: number };
/** Embeds text and files into vectors, one per input, with the model the caller names. */
export interface EmbeddingsPort {
	/** `dimensions`: the vector length the caller stores (a model that truncates, Matryoshka-style, answers at it). */
	embed(
		inputs: readonly EmbedInput[],
		model: string,
		signal: AbortSignal,
		dimensions?: number
	): Promise<readonly (readonly number[])[]>;
}
/**
 * The AI facility: `sys_1` (fast structured decisions, text only) and `sys_2` (the LLM, multimodal) are both
 * required when the port is bound; `embed` (multimodal) is present when the host maps an embedding model. The host
 * verifies at activation that every `sys_2` and `embed` model takes images; nothing here branches on modality.
 */
export interface AiPort {
	sys_1: System1Port;
	sys_2: {
		/** The model classes the host maps (`default fast strong`). */
		models: readonly string[];
		/**
		 * The concrete models a person may pick for a conversation and the id a new one starts on (the host's own selection,
		 * cached as it likes; it answers even offline). `infer` takes any of their ids as `model`, beside the classes.
		 */
		catalog?(): Promise<{ models: readonly AiModel[]; default: string }>;
		/**
		 * `onDelta` streams text as it arrives; on the wall the agent keeps it as a cut step. `onProgress`: the stream
		 * produced something that is not text (a tool call's arguments, or `reasoning` as it arrives).
		 */
		infer(
			request: AiRequest,
			signal: AbortSignal,
			onDelta?: (text: string) => void,
			onProgress?: (reasoning?: string) => void
		): Promise<AiResponse>;
	};
	embed?: EmbeddingsPort['embed'];
}
/** One `sys_2` call as it streams: text as it arrives, progress that is not text (a tool call's arguments, reasoning), then the response. */
export type AiEvent =
	| { readonly _tag: 'Delta'; readonly text: string }
	| { readonly _tag: 'Progress'; readonly reasoning: string | undefined }
	| { readonly _tag: 'Response'; readonly response: AiResponse };
/** A chat model call (`sys_2.infer` over an OpenAI-compatible endpoint): a cancellable stream whose last event carries the response. */
export type OpenAiChat = (request: AiRequest) => Stream.Stream<AiEvent, PortFailure>;
