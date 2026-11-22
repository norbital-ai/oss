// The intelligence facility: System 1's structured decisions, System 2's model calls and embeddings.
import { Predicate, Schema, type Stream } from 'effect';
import type { PortFailure } from './errors.ts';
import type { Json } from '@norbital-ai/store';

/** Fields every AI provider receives; engine transcript metadata is not part of this contract. */
export const AiToolCallSchema = Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		input: Schema.Json,
		invalid: Schema.optionalKey(Schema.String)
	});
/** Assistant text, preserved reasoning and tool calls passed to the provider. */
export const AiAssistantContent = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	reasoning: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(AiToolCallSchema))
});
/** A tool call result passed back to the provider. */
export const AiToolResult = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	result: Schema.optionalKey(Schema.Json)
	});
/** Text projection shared by the producer and provider. */
export const textOf = (content: Json): string => {
	if (typeof content === 'string') return content;
	const text = Predicate.isObject(content) ? content['text'] : undefined;
	return typeof text === 'string' ? text : JSON.stringify(content);
};

/** The host's system-2 answer; transcript storage keeps its native toolCalls projection behind the adapter. */
export const AiPortResponseSchema = Schema.Struct({
	content: Schema.Json,
	tool_calls: Schema.Array(AiToolCallSchema),
	finish: Schema.Literals(['stop', 'tool', 'cut']),
	continuation: Schema.optionalKey(Schema.String),
	reasoning: Schema.optionalKey(Schema.String),
	/**
	 * Tokens and the call's charge in USD under the provider's call id: a host's provider reports both `cost` and `call`
	 * for every call (from the endpoint's own charge, else its listed price); only a recorded test answer omits them.
	 */
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

/**
 * Authoritative bounds for one System 1 (`sys_1`) decision call: wall timeout, inline image budget,
 * question/option cardinalities, and provider-specific caps.
 */
export const DECISION_LIMITS = {
	/** Maximum wall time for one `sys_1` call in milliseconds (3 s). */
	call_ms: 3_000,
	/** Maximum number of inline PNG/JPEG images allowed inside `state`. */
	max_images: 16,
	/** Maximum combined decoded byte size of inline images inside `state` (20 MiB). */
	max_image_bytes: 20 * 1024 * 1024,
	/** Maximum choices per `choice` question on the native Jev Decisions API. */
	max_choices: 255,
	/** Minimum criterion levels for a `score` question. */
	min_score_levels: 1,
	/** Maximum criterion levels for a `score` question. */
	max_score_levels: 10,
	/** Maximum questions per call on the OpenAI `/v1/decisions` wire format. */
	openai_max_questions: 400,
	/** Minimum choices/levels per question on the OpenAI `/v1/decisions` wire format. */
	openai_min_options: 2
} as const;

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
/** Structured entry in a System 1 question or criterion: string, null, JSON array, or JSON object. */
export const DecisionEntrySchema = Schema.Union([
	Schema.String,
	Schema.Null,
	Schema.Array(Schema.Json),
	Schema.Record(Schema.String, Schema.Json)
]);
/** Non-null shared evidence state for one System 1 decision call (text, JSON, and resolved inline PNG/JPEG images). */
export const DecisionStateSchema = Schema.Union([
	Schema.String,
	Schema.Array(Schema.Json),
	Schema.Record(Schema.String, Schema.Json)
]);
/** One typed System 1 question: `noul` (binary probability), `choice` (categorical), or `score` (1–10 ordinal levels). */
export const DecisionQuestionSchema = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('noul'),
		instructions: Schema.optionalKey(DecisionEntrySchema),
		criteria: Schema.optionalKey(
			Schema.NullOr(
				Schema.Struct({
					true: Schema.optionalKey(DecisionEntrySchema),
					false: Schema.optionalKey(DecisionEntrySchema)
				})
			)
		)
	}),
	Schema.Struct({
		type: Schema.Literal('choice'),
		instructions: Schema.optionalKey(DecisionEntrySchema),
		criteria: Schema.Record(Schema.String, DecisionEntrySchema).check(
			Schema.makeFilter((value) => Object.keys(value).length > 0)
		)
	}),
	Schema.Struct({
		type: Schema.Literal('score'),
		instructions: Schema.optionalKey(DecisionEntrySchema),
		criteria: Schema.Array(DecisionEntrySchema).check(
			Schema.isMinLength(DECISION_LIMITS.min_score_levels),
			Schema.isMaxLength(DECISION_LIMITS.max_score_levels)
		)
	})
]);
/**
 * One System 1 decision request: shared `state` (JSON/text plus resolved inline PNG/JPEG images) and a non-empty map
 * of independent `questions`. Intended for fixed-set classification, triage, routing, predicates, and ordinal scoring —
 * never free-form or recursive AST generation (use `sys_2.infer` for that).
 */
export const DecisionRequestSchema = Schema.Struct({
	state: DecisionStateSchema,
	questions: Schema.Record(Schema.String, DecisionQuestionSchema).check(
		Schema.makeFilter((value) => Object.keys(value).length > 0)
	)
});
/** One System 1 call (`DecisionRequestSchema`): the state it reads and its questions by key. */
export type DecisionRequest = typeof DecisionRequestSchema.Type;
/**
 * Schema of one System 1 answer: `noul` probability in `[0, 1]`, `choice` with winning key and normalized distribution,
 * or `score` with expected value, 0-based winning `level` index (mapped to the criterion value at the guest boundary),
 * distribution, and `legend`.
 */
export const DecisionAnswerSchema = Schema.Union([
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
		legend: Schema.Record(Schema.String, DecisionEntrySchema)
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
/**
 * Host port for System 1 (`sys_1`): bounded, fail-closed, independent structured decisions over text, JSON, and
 * resolved inline PNG/JPEG images (`ctx.ai.sys_1.decide` and conversation triage). Never falls back silently.
 */
export interface System1Port {
	/** `model`: a `catalog` id the workspace's administrator chose; absent, `catalog().default`. */
	ask(request: DecisionRequest, signal: AbortSignal, model?: string): Promise<DecisionResult>;
	readonly max_choices?: number;
	/** The models the provider can decide with, as it lists them, and the one it uses unless told otherwise. */
	catalog(): Promise<{ models: readonly AiModel[]; default: string }>;
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
/**
 * One model a provider lists (the panel shows `label`, grouped by `provider`); `context` is its window in tokens,
 * `price` USD per million tokens (input, output, cached input): what a call costs when the endpoint reports no charge.
 */
export const AiModelSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	provider: Schema.optionalKey(Schema.String),
	context: Schema.optionalKey(Schema.Number),
	price: Schema.optionalKey(
		Schema.Struct({
			input: Schema.Number,
			output: Schema.Number,
			cached: Schema.optionalKey(Schema.Number)
		})
	)
});
/** One model a provider lists (`AiModelSchema`): its id, label, vendor, window and price. */
export type AiModel = typeof AiModelSchema.Type;
/** A model's listed price in USD per million tokens: input, output and cached input. */
export type AiPrice = NonNullable<AiModel['price']>;
/** A provider's listing: its models and the one it uses unless told otherwise. */
export const AiCatalogSchema = Schema.Struct({ models: Schema.Array(AiModelSchema), default: Schema.String });
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
 * The AI facility: `sys_1` (fast structured decisions over text, JSON, and resolved inline PNG/JPEG images) and `sys_2`
 * (the multimodal LLM) are both required when the port is bound; `embed` (multimodal) is present when the host maps an
 * embedding model. The host verifies at activation that every `sys_2` and `embed` model takes images; nothing here
 * branches on modality.
 */
export interface AiPort {
	sys_1: System1Port;
	sys_2: {
		/** The model classes the host maps (`default fast strong`). */
		models: readonly string[];
		/**
		 * Every model the provider can reach that the agent can run on (images in, tools), as the provider lists them, and
		 * the id a new conversation starts on; cached as the host likes, answering even offline. `infer` takes any of their
		 * ids as `model`, beside the classes.
		 */
		catalog(): Promise<{ models: readonly AiModel[]; default: string }>;
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
