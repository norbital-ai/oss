/**
 * The pure domain of one agent turn: the shapes a turn is stored as, replayed to a provider in,
 * pruned back from, and bounded by.
 *
 * Nothing here reads a database or a service. The layer code that executes a turn lives beside
 * the services it needs; this module is what the layer and the transports that reflect on a turn
 * both import, so the turn's shape is declared once.
 */
import { Effect, Schema } from 'effect';
import { AIUsage } from '@norbital-ai/bolt-protocol';
import * as Identity from '#lib/runtime/identity/identity.js';

/** One model-returned tool call, in the shape the turn stores it. */
const ToolCall = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});

/** The one shape a model answers a turn round with: reasoning, text, and tool calls are optional. */
export const TurnOutput = Schema.Struct({
	reasoning: Schema.optionalKey(Schema.String),
	/** Opaque provider blocks are replayed verbatim across tool rounds. */
	reasoningDetails: Schema.optionalKey(Schema.Array(Schema.Json)),
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(ToolCall))
});

/** How many of the newest assistant rows survive pruning untouched. */
export const protectedAssistantTurns = 3;
const softToolOutputCharacters = 4_000;
const hardToolOutputCharacters = 50_000;

/**
 * The replay share of a model context. The rest belongs to instructions, tool schemas, the live
 * round, and the answer the model is about to produce.
 */
export const promptReplayFraction = 0.6;

/** How deep usage roll-up and transcript walk follow delegation. */
export const maxDelegationDepth = 8;

/**
 * The transport surface a turn reflects into, when one is watching.
 *
 * A transport turn is one message edited in place: `observe` is called with the parts after each
 * durable commit, and `currentKey` names the bubble the completion replaces. Presentation and
 * pacing belong to the surface, never to the agent — a turn exposes its state, and the surface
 * decides what it looks like and when it changes. Absent for the web agent.
 */
export type TurnSurface = Readonly<{
	readonly observe: (parts: ReadonlyArray<TurnPart>) => Effect.Effect<void, unknown>;
	readonly currentKey: () => string | null;
	/** Replaces the progress bubble with the settled answer. Best effort, like observation. */
	readonly complete?: (output: Schema.Json) => Effect.Effect<void, unknown>;
}>;

/** One step of an agent turn. "Step" and "part" name the same thing: what the turn produced next.
 *
 * A turn is one message, so its steps are parts inside that message rather than messages of their
 * own.
 */
export const TurnPart = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('reasoning'),
		text: Schema.String,
		/** Provider signatures/encrypted blocks are prompt state, not presentation text. */
		details: Schema.optionalKey(Schema.Array(Schema.Json))
	}),
	Schema.Struct({ kind: Schema.Literal('text'), text: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('tool'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		input: Schema.Json
	}),
	Schema.Struct({
		kind: Schema.Literal('tool-result'),
		id: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		output: Schema.Json
	})
]);
export type TurnPart = Schema.Schema.Type<typeof TurnPart>;

/**
 * Closes every committed tool call that has no committed result yet.
 *
 * Stop, interruption, and host-loss are terminal boundaries. Replaying an assistant tool call
 * across one of those boundaries without its matching tool result produces an invalid provider
 * transcript, so lifecycle code applies this before publishing the terminal turn state.
 */
export const closeUnpairedToolCalls = (
	parts: ReadonlyArray<TurnPart>,
	reason: 'host-restarted' | 'interrupted' | 'stopped' | 'tool-failed'
): ReadonlyArray<TurnPart> => {
	const results = new Set(parts.flatMap((part) => (part.kind === 'tool-result' ? [part.id] : [])));
	const closed: Array<TurnPart> = [...parts];
	for (const part of parts) {
		if (part.kind !== 'tool' || results.has(part.id)) continue;
		closed.push({
			kind: 'tool-result',
			id: part.id,
			name: part.name,
			output: {
				terminal: true,
				error: 'tool interrupted before completion',
				reason
			}
		});
		results.add(part.id);
	}
	return closed;
};

export const TurnStatus = Schema.Literals([
	'queued',
	'running',
	'stopped',
	'completed',
	'failed',
	'interrupted'
]);
export type TurnStatus = Schema.Schema.Type<typeof TurnStatus>;

/**
 * Everything a stored turn needs to run under the authority that started it.
 *
 * The subject is a snapshot, deliberately. A task invocation carries no credential, and rebuilding a
 * subject from `chat_session.user_id` would be both incomplete (there is no team path there)
 * and wrong for envoys (their policies are static authority, not the linked person's authority).
 */
export const StoredTurn = Schema.Struct({
	id: Schema.NonEmptyString,
	status: TurnStatus,
	/** Invocation nesting carried with the durable turn, without a scheduler payload. */
	depth: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
	parts: Schema.Array(TurnPart),
	subject: Schema.optionalKey(Identity.Subject),
	agent_name: Schema.optionalKey(Schema.NonEmptyString),
	/** Caller-selected host model. Absent means the catalog's current default. */
	model: Schema.optionalKey(Schema.NonEmptyString),
	usage: Schema.optionalKey(AIUsage),
	usage_unreported: Schema.optionalKey(Schema.Boolean)
});
export type StoredTurn = Schema.Schema.Type<typeof StoredTurn>;

/** A completed delegated turn, returned to its parent as the answer to its await tool call. */
export const SettledTarget = Schema.Struct({
	id: Schema.NonEmptyString,
	status: Schema.Literals(['completed', 'failed', 'interrupted', 'stopped']),
	parts: Schema.Array(TurnPart)
});

/**
 * A replay of a stored assistant turn: the text and the tool calls a provider needs, in the order
 * they happened, with either half optional — the one shape a provider actually builds a prompt from.
 */
const ReplayContent = Schema.Struct({
	reasoning: Schema.optionalKey(Schema.String),
	reasoningDetails: Schema.optionalKey(Schema.Array(Schema.Json)),
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(Schema.Json))
});

/**
 * Expands one stored turn back into the alternating messages a provider accepts.
 *
 * The store keeps a turn whole because that is what the turn is; a provider instead wants the
 * assistant/tool alternation it emitted. Rebuilding it here is what lets the log hold the reader's
 * model without the prompt losing which answer belongs to which call.
 */
export const replayTurn = (parts: ReadonlyArray<TurnPart>): ReadonlyArray<Schema.Json> => {
	const replayed: Array<Schema.Json> = [];
	let reasoning: string | undefined;
	let reasoningDetails: ReadonlyArray<Schema.Json> | undefined;
	let text: string | undefined;
	let calls: Array<Schema.Json> = [];
	const flush = () => {
		if (
			reasoning === undefined &&
			reasoningDetails === undefined &&
			text === undefined &&
			calls.length === 0
		)
			return;
		const content: Schema.Schema.Type<typeof ReplayContent> = {
			...(reasoning === undefined ? {} : { reasoning }),
			...(reasoningDetails === undefined ? {} : { reasoningDetails: [...reasoningDetails] }),
			...(text === undefined ? {} : { text }),
			...(calls.length === 0 ? {} : { toolCalls: calls })
		};
		replayed.push({ role: 'assistant', content });
		reasoning = undefined;
		reasoningDetails = undefined;
		text = undefined;
		calls = [];
	};
	for (const part of parts) {
		if (part.kind === 'reasoning') {
			flush();
			reasoning = part.text;
			reasoningDetails = part.details;
		} else if (part.kind === 'text') {
			// Reasoning and its answer belong to the same provider assistant message. A second text
			// part or a text part after calls starts a new assistant message.
			if (text !== undefined || calls.length > 0) flush();
			text = part.text;
		} else if (part.kind === 'tool') {
			calls.push({ name: part.name, input: part.input });
		} else {
			flush();
			replayed.push({ role: 'tool', name: part.name, content: JSON.stringify(part.output) });
		}
	}
	flush();
	return replayed;
};

/**
 * Old tool output is evidence, not an entitlement to consume the prompt forever. The recent three
 * assistant turns remain byte-for-byte intact; older output is trimmed at the two age thresholds
 * used by the runtime's fixed replay window.
 */
export const pruneToolOutput = (
	parts: ReadonlyArray<TurnPart>,
	ageFraction: number,
	protectedTurn: boolean
): ReadonlyArray<TurnPart> => {
	if (protectedTurn) return parts;
	return parts.map((part): TurnPart => {
		if (part.kind !== 'tool-result') return part;
		const encoded = JSON.stringify(part.output);
		if (ageFraction >= 0.5 && encoded.length > hardToolOutputCharacters) {
			return {
				...part,
				output: {
					cleared: true,
					originalCharacters: encoded.length,
					reason: 'outside recent prompt window'
				}
			};
		}
		if (ageFraction >= 0.3 && encoded.length > softToolOutputCharacters) {
			return {
				...part,
				output: `${encoded.slice(0, 1_500)}\n… ${encoded.length - 3_000} characters trimmed …\n${encoded.slice(-1_500)}`
			};
		}
		return part;
	});
};

/** One indivisible stored turn after its rows have been decoded and soft-pruned. */
export type PromptWindowTurn = Readonly<{
	readonly messages: ReadonlyArray<Schema.Json>;
	/** The newest user turn and recent assistant turns form the retention floor. */
	readonly protected: boolean;
	/** Provider-reported usage for the assistant row in this turn, when one was recorded. */
	readonly usage?: AIUsage;
}>;

const jsonBytes = (value: Schema.Json): number =>
	new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** The tokenizer-free estimate used at the prompt seam: UTF-8 bytes divided by four. */
export const estimatedPromptTokens = (messages: ReadonlyArray<Schema.Json>): number =>
	messages.reduce<number>((tokens, message) => tokens + Math.ceil(jsonBytes(message) / 4), 0);

/**
 * Corrects the byte estimate with prompt usage the provider reported on earlier turns.
 *
 * Stored usage is cumulative when a turn took several rounds, so dividing it by the number of
 * assistant messages reconstructed for that turn avoids treating a repeated prompt as new
 * transcript. The correction never reduces the byte estimate: provider counts include system and
 * tool-schema tokens which are deliberately outside the replay allowance, and under-counting here
 * is the dangerous direction.
 */
const usageCorrection = (
	turns: ReadonlyArray<PromptWindowTurn>,
	fixedMessages: ReadonlyArray<Schema.Json>
): number => {
	let correction = 1;
	let prefix: Array<Schema.Json> = [...fixedMessages];
	for (const turn of turns) {
		prefix = [...prefix, ...turn.messages];
		const reported = turn.usage?.inputTokens;
		if (reported === undefined || !Number.isFinite(reported) || reported <= 0) continue;
		const assistantRounds = Math.max(
			1,
			turn.messages.filter(
				(message) =>
					typeof message === 'object' &&
					message !== null &&
					!Array.isArray(message) &&
					Reflect.get(message, 'role') === 'assistant'
			).length
		);
		const observedPrompt = reported / assistantRounds;
		const estimatedPrefix = estimatedPromptTokens(prefix);
		if (estimatedPrefix > 0) correction = Math.max(correction, observedPrompt / estimatedPrefix);
	}
	return correction;
};

/**
 * Applies the 60% hard replay window without ever cutting through a stored turn.
 *
 * Soft tool-output pruning has already happened when these units arrive. Oldest unprotected turns
 * are removed until the corrected estimate fits. A retention floor may itself exceed the budget;
 * system instructions, the newest user request, and protected assistants are promises stronger than
 * the cap and therefore remain whole rather than producing a provider-invalid fragment.
 */
export const truncatePromptWindow = (
	turns: ReadonlyArray<PromptWindowTurn>,
	contextTokens: number,
	fixedMessages: ReadonlyArray<Schema.Json> = []
): ReadonlyArray<Schema.Json> => {
	if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
		throw new RangeError('model context tokens must be a positive finite number');
	}
	const budget = Math.floor(contextTokens * promptReplayFraction);
	const correction = usageCorrection(turns, fixedMessages);
	const estimates = turns.map((turn) => estimatedPromptTokens(turn.messages) * correction);
	let total = estimates.reduce((sum, estimate) => sum + estimate, 0);
	const retained = turns.map(() => true);
	for (let index = 0; index < turns.length && total > budget; index += 1) {
		if (turns[index]?.protected === true) continue;
		retained[index] = false;
		total -= estimates[index] ?? 0;
	}
	return turns.flatMap((turn, index) => (retained[index] ? turn.messages : []));
};
