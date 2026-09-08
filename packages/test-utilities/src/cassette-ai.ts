import { readFileSync } from 'node:fs';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { AIRequest, AIResponse } from '@norbital-ai/bolt-protocol';
import type { AIGenerationResult, FacilityBinding } from '@norbital-ai/bolt-protocol';
import { makeAiBinding } from '@norbital-ai/bolt-server';
import { testAiCatalog, TEST_CONTEXT_WINDOW_TOKENS } from './catalog-ai.js';

/**
 * A recorded model turn file. Only provider OUTPUTS are captured — the `Generated`
 * payloads plus the observation the adapter reported. Prompts are intentionally absent:
 * replay asserts the pipeline (loop → tools → persistence → reply), never the generation.
 * `callId` is stamped live per request, so one cassette replays in any harness.
 */
const CassetteFile = Schema.Struct({
	meta: Schema.Struct({
		name: Schema.String,
		recordedAt: Schema.String,
		model: Schema.String,
		purpose: Schema.String,
		provenance: Schema.optional(Schema.String),
		source: Schema.optional(Schema.String),
		promptTokens: Schema.optional(Schema.NullOr(Schema.Number)),
		completionTokens: Schema.optional(Schema.NullOr(Schema.Number))
	}),
	turns: Schema.Array(AIResponse),
	verdicts: Schema.optional(Schema.Array(AIResponse))
});

export type AgentCassette = typeof CassetteFile.Type;
export type CassetteTurn = Extract<AgentCassette['turns'][number], { readonly _tag: 'Generated' }>;
export type CassetteVerdictTurn = Extract<
	NonNullable<AgentCassette['verdicts']>[number],
	{ readonly _tag: 'Generated' }
>;
type CassetteMessageResult = Extract<CassetteTurn['result'], { readonly _tag: 'Message' }>;
type CassetteVerdictResult = Extract<CassetteTurn['result'], { readonly _tag: 'PlanVerdict' }>;
type GenerateRequest = Extract<AIRequest, { readonly _tag: 'Generate' }>;

/** Reads + validates a cassette file. Every turn is a real `Generated` response or it throws. */
export const readCassetteFile = (path: string): AgentCassette => {
	let file: AgentCassette;
	try {
		file = Schema.decodeUnknownSync(CassetteFile)(JSON.parse(readFileSync(path, 'utf8')));
	} catch (cause) {
		throw new Error(`cassetteAi: ${path} is not a cassette file`, { cause });
	}
	if (file.turns.length === 0 && (file.verdicts ?? []).length === 0) {
		throw new Error(`cassetteAi: ${path} has no turns`);
	}
	for (const [index, turn] of file.turns.entries()) {
		if (turn._tag !== 'Generated') {
			throw new Error(`cassetteAi: ${path} turn ${index} is not a generated turn`);
		}
		if (turn.result._tag !== 'Message') {
			throw new Error(`cassetteAi: ${path} turn ${index} is not a message turn`);
		}
		// Proves the turn re-encodes for the wire now, not mid-replay.
		Schema.encodeSync(AIResponse)(turn);
	}
	for (const [index, turn] of (file.verdicts ?? []).entries()) {
		if (turn._tag !== 'Generated' || turn.result._tag !== 'PlanVerdict') {
			throw new Error(`cassetteAi: ${path} verdict ${index} is not a verdict turn`);
		}
		Schema.encodeSync(AIResponse)(turn);
	}
	return file;
};

/**
 * File-backed twin of `recordedAi`: Catalog matches `catalogAi`, Generate plays the next
 * cassette turn with the live request's `callId` stamped on the observation. Exhaustion is an
 * error, not a silent repeat — a pipeline that calls more turns than recorded changed shape.
 *
 * With `tokensPerSecond` set, text turns stream: progressive part snapshots go out over
 * `onProgress` paced at that rate (tokens ≈ chars/4) before the complete message returns —
 * the offline stand-in for a provider delivering at N tok/s. Default 0 streams nothing and
 * returns instantly, which is how the sub-second first-part budget is measured: any delay is
 * host overhead by construction. Assumed flash-class rate is 60 tok/s (conservative;
 * GPT-4.1-mini and GLM flash typically answer faster) — a test parameter, not a provider claim.
 */
export const DEFAULT_CASSETTE_TOKENS_PER_SECOND = 60;

export type CassetteStreamOptions = Readonly<{ readonly tokensPerSecond?: number }>;

const encodeMessage = Schema.encodeSync(Prompt.Message);

const messageTexts = (message: CassetteMessageResult['message']): Array<string> => {
	if (typeof message.content === 'string') return [message.content];
	const texts: Array<string> = [];
	for (const part of message.content) {
		if (part.type === 'text' || part.type === 'reasoning') texts.push(part.text);
	}
	return texts;
};

const textOfTurn = (turn: CassetteTurn | CassetteVerdictTurn): string | undefined => {
	if (turn.result._tag !== 'Message') return undefined;
	const texts = messageTexts(turn.result.message);
	return texts.length > 0 ? texts.join('') : undefined;
};

type PlayState = { next: number; verdictNext: number };

/**
 * Strict turn matching, shared by both players. Message requests meet message turns,
 * verdict requests meet verdict turns — a mismatch throws loudly instead of silently
 * answering the wrong shape. The one exception mirrors the canonical fixture: a cassette
 * with no verdict turns answers every verdict request with the default complete verdict.
 */
const takeTurn = (
	cassette: AgentCassette,
	state: PlayState,
	wantsVerdict: boolean
): CassetteTurn | CassetteVerdictTurn | undefined => {
	if (wantsVerdict) {
		const verdicts = cassette.verdicts ?? [];
		if (verdicts.length === 0) return undefined;
		const turn = verdicts[state.verdictNext];
		if (turn === undefined || turn._tag !== 'Generated') {
			throw new Error(
				`cassetteAi: cassette ${cassette.meta.name} exhausted after ${state.verdictNext} verdicts`
			);
		}
		state.verdictNext += 1;
		return turn;
	}
	const turn = cassette.turns[state.next];
	if (turn === undefined || turn._tag !== 'Generated') {
		throw new Error(
			`cassetteAi: cassette ${cassette.meta.name} exhausted after ${state.next} turns`
		);
	}
	state.next += 1;
	return turn;
};

const playEncoded = (turn: CassetteTurn, callId: string) => {
	const played = Schema.encodeSync(AIResponse)(turn);
	if (played._tag !== 'Generated') {
		throw new Error('cassetteAi: cassette turn did not re-encode as generated');
	}
	return {
		result: played.result,
		observation: { ...played.observation, callId }
	};
};

const defaultVerdict = (callId: string) => ({
	result: {
		_tag: 'PlanVerdict' as const,
		verdict: {
			complete: true,
			summary: 'Every verification criterion is evidenced.',
			gaps: [] as ReadonlyArray<string>
		}
	},
	observation: {
		provider: 'cassette',
		model: 'cassette/verdict',
		operation: 'language' as const,
		callId
	}
});

export const cassetteAi = (cassette: AgentCassette, options: CassetteStreamOptions = {}) => {
	const state: PlayState = { next: 0, verdictNext: 0 };
	let sequence = 0;
	return makeAiBinding({
		call: async (_metadata, request: AIRequest, _signal, onProgress) => {
			switch (request._tag) {
				case 'Catalog':
					return testAiCatalog;
				case 'Generate': {
					const turn = takeTurn(cassette, state, request.output._tag === 'PlanVerdict');
					if (turn === undefined) {
						const verdict = defaultVerdict(request.callId);
						return { _tag: 'Generated' as const, ...verdict };
					}
					const played = playEncoded(turn, request.callId);
					const { result, observation } = played;
					if (turn.result._tag !== 'Message') {
						return { _tag: 'Generated' as const, result, observation };
					}
					const tokensPerSecond = options.tokensPerSecond ?? 0;
					const text = tokensPerSecond > 0 ? textOfTurn(turn) : undefined;
					if (text !== undefined && onProgress !== undefined && typeof onProgress === 'function') {
						const chunkChars = Math.max(16, Math.ceil((tokensPerSecond * 4) / 5));
						let emitted = '';
						for (let at = 0; at < text.length; at += chunkChars) {
							emitted = text.slice(0, at + chunkChars);
							const snapshot = Schema.decodeUnknownSync(Schema.Json)({
								callId: request.callId,
								sequence,
								message: encodeMessage(
									Prompt.assistantMessage({ content: [Prompt.textPart({ text: emitted })] })
								),
								activeParts: [0]
							});
							sequence += 1;
							await onProgress(snapshot);
							const chunkTokens = Math.max(1, Math.ceil(chunkChars / 4));
							await new Promise((resolve) =>
								setTimeout(resolve, (chunkTokens / tokensPerSecond) * 1000)
							);
						}
						// Close like a real provider: the complete message with no active parts,
						// which the loop requires to equal the returned final response.
						const closing = Schema.decodeUnknownSync(Schema.Json)({
							callId: request.callId,
							sequence,
							message: turn.result.message,
							activeParts: []
						});
						sequence += 1;
						await onProgress(closing);
					}
					return { _tag: 'Generated' as const, result, observation };
				}
				case 'Embed':
					throw new Error('cassetteAi: Embed was not recorded');
				default: {
					const _exhaustive: never = request;
					throw new Error(`cassetteAi: unhandled AI request: ${JSON.stringify(_exhaustive)}`);
				}
			}
		}
	});
};

/** A cassette turn payload by index. Gate-coordinated tests keep their own timing and read content here. */
export const cassetteMessage = (
	cassette: AgentCassette,
	index: number
): CassetteMessageResult['message'] => {
	const turn = cassette.turns[index];
	if (turn === undefined || turn._tag !== 'Generated') {
		throw new Error(`cassetteAi: cassette ${cassette.meta.name} has no message turn ${index}`);
	}
	if (turn.result._tag !== 'Message') {
		throw new Error(`cassetteAi: cassette ${cassette.meta.name} has no message turn ${index}`);
	}
	return turn.result.message;
};

/** A cassette verdict payload by index. */
export const cassetteVerdict = (
	cassette: AgentCassette,
	index: number
): CassetteVerdictResult['verdict'] => {
	const turn = (cassette.verdicts ?? [])[index];
	if (turn === undefined || turn._tag !== 'Generated') {
		throw new Error(`cassetteAi: cassette ${cassette.meta.name} has no verdict turn ${index}`);
	}
	if (turn.result._tag !== 'PlanVerdict') {
		throw new Error(`cassetteAi: cassette ${cassette.meta.name} has no verdict turn ${index}`);
	}
	return turn.result.verdict;
};

/** Mirror of the canonical fixture: the runtime's auto-compact summary call is answered in-line and never consumes a cassette turn. */
const COMPACT_SUMMARY_TEXT =
	'Retained: the current user instruction, open decisions, and unresolved work.';

export type CassetteInspection = Readonly<{
	readonly callId: GenerateRequest['callId'];
	readonly maxOutputTokens: GenerateRequest['maxOutputTokens'];
	readonly promptBytes: number;
	readonly automaticCompact: boolean;
	readonly planMode: boolean;
	readonly compactMode: boolean;
	readonly roles: ReadonlyArray<GenerateRequest['messages'][number]['role']>;
}>;

const inspectRequest = (request: GenerateRequest): CassetteInspection => {
	const encoded = JSON.stringify(request.messages) ?? '';
	const texts = request.messages.flatMap((message) => messageTexts(message));
	return {
		callId: request.callId,
		maxOutputTokens: request.maxOutputTokens,
		promptBytes: new TextEncoder().encode(encoded).byteLength,
		automaticCompact: texts.some(
			(text) => text.includes('Automatic Compact:') || text.includes('Requested Compact:')
		),
		planMode: texts.some((text) => text.startsWith('Plan mode:')),
		compactMode: texts.some((text) =>
			text.includes(
				'Compact mode: summarize durable context without performing work or calling tools.'
			)
		),
		roles: request.messages.map((message) => message.role)
	};
};

/**
 * Cassette-backed twin of `scriptedTranscript`: `{ ai, feed, requests, verdictRequests }`
 * with the same feed semantics (every Generate inspected, auto-compact answered canned).
 * Tests that scripted fixed reply arrays swap by replacing the array with a cassette file.
 */
export const cassetteTranscript = (
	cassette: AgentCassette,
	/**
	 * The window every model in this twin's catalog claims.
	 *
	 * Compaction fires at a fraction of the model's own context window, so a suite that wants to see
	 * it states a window small enough for its fixture to exceed. Everything else takes the default,
	 * which is large enough that no suite compacts by accident.
	 */
	contextWindowTokens: number = TEST_CONTEXT_WINDOW_TOKENS
) => {
	const catalog = {
		...testAiCatalog,
		languageModels: testAiCatalog.languageModels.map((model) => ({
			...model,
			contextWindowTokens
		})),
		embeddingModels: testAiCatalog.embeddingModels.map((model) => ({
			...model,
			contextWindowTokens
		}))
	};
	const feed: Array<CassetteInspection> = [];
	const requests: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
	const verdictRequests: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
	const state: PlayState = { next: 0, verdictNext: 0 };
	const ai = makeAiBinding({
		call: async (_metadata, request) => {
			if (request._tag === 'Catalog') return catalog;
			if (request._tag !== 'Generate') throw new Error('cassetteAi: Generate required');
			if (request.output._tag === 'PlanVerdict') {
				verdictRequests.push(request);
				const turn = takeTurn(cassette, state, true);
				if (turn === undefined) {
					const verdict = defaultVerdict(request.callId);
					return { _tag: 'Generated' as const, ...verdict };
				}
				return { _tag: 'Generated' as const, ...playEncoded(turn, request.callId) };
			}
			requests.push(request);
			const inspection = inspectRequest(request);
			feed.push(inspection);
			if (inspection.automaticCompact) {
				return {
					_tag: 'Generated' as const,
					result: {
						_tag: 'Message' as const,
						message: encodeMessage(
							Prompt.assistantMessage({
								content: [Prompt.textPart({ text: COMPACT_SUMMARY_TEXT })]
							})
						)
					},
					observation: {
						provider: 'cassette',
						model: 'cassette/auto-compact',
						operation: 'language' as const,
						callId: request.callId
					}
				};
			}
			const turn = takeTurn(cassette, state, false);
			if (turn === undefined) {
				const verdict = defaultVerdict(request.callId);
				return { _tag: 'Generated' as const, ...verdict };
			}
			return { _tag: 'Generated' as const, ...playEncoded(turn, request.callId) };
		}
	});
	return { feed, requests, verdictRequests, ai };
};
