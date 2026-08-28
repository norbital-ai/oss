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

/** The one shape a model answers a turn round with: text, tool calls, either half optional. */
export const TurnOutput = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	toolCalls: Schema.optionalKey(Schema.Array(ToolCall))
});

/** How many rounds one turn may run before it is broken off rather than left to loop. */
export const maxToolRounds = 8;
/** How many transcript rows a prompt is built from. */
export const recentPromptRows = 64;
/** How many of the newest assistant rows survive pruning untouched. */
export const protectedAssistantTurns = 3;
export const softToolOutputCharacters = 4_000;
export const hardToolOutputCharacters = 50_000;

/** How deep usage roll-up and transcript walk follow delegation. */
export const maxDelegationDepth = 8;
/** How many times a backgrounded delegated turn may be resumed before it is abandoned. */
export const maxResumes = 4;

/**
 * The transport surface a turn reflects into, when one is watching.
 *
 * A transport turn is one message edited in place: `observe` is called with the parts after each
 * durable commit, and `currentKey` names the bubble the completion replaces. Presentation and
 * pacing belong to the surface, never to the agent — a turn exposes its state, and the surface
 * decides what it looks like and when it changes. Absent for the web agent.
 */
export type TurnSurface = Readonly<{
	readonly observe: (parts: ReadonlyArray<TurnPart>) => Effect.Effect<void>;
	readonly currentKey: () => string | null;
}>;

/** One step of an agent turn. "Step" and "part" name the same thing: what the turn produced next.
 *
 * A turn is one message, so its steps are parts inside that message rather than messages of their
 * own.
 */
export const TurnPart = Schema.Union([
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

export const TurnStatus = Schema.Literals([
	'queued',
	'running',
	'paused',
	'completed',
	'failed',
	'interrupted',
	'dequeued'
]);
export type TurnStatus = Schema.Schema.Type<typeof TurnStatus>;

/**
 * Everything a parked turn needs in order to continue under the authority that started it.
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
	parent_agent_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	parts: Schema.Array(TurnPart),
	resumed: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	),
	subject: Schema.optionalKey(Identity.Subject),
	agent_name: Schema.optionalKey(Schema.NonEmptyString),
	usage: Schema.optionalKey(AIUsage),
	usage_unreported: Schema.optionalKey(Schema.Boolean)
});
export type StoredTurn = Schema.Schema.Type<typeof StoredTurn>;

/** What `await_agent` asks of its child before returning control to its parent. */
export const AwaitInput = Schema.Struct({
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
/** The one value a parked wait must be — `waiting: true` — named by construction. */
export const WaitingAnswer = Schema.Struct({ waiting: Schema.Literal(true) });

/** A completed delegated turn, returned to its parent as the answer to its await tool call. */
export const SettledTarget = Schema.Struct({
	id: Schema.NonEmptyString,
	status: Schema.Literals(['completed', 'failed', 'interrupted', 'dequeued']),
	parts: Schema.Array(TurnPart)
});

/**
 * A replay of a stored assistant turn: the text and the tool calls a provider needs, in the order
 * they happened, with either half optional — the one shape a provider actually builds a prompt from.
 */
export const ReplayContent = Schema.Struct({
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
	let text: string | undefined;
	let calls: Array<Schema.Json> = [];
	const flush = () => {
		if (text === undefined && calls.length === 0) return;
		const content: Schema.Schema.Type<typeof ReplayContent> =
			text === undefined
				? { toolCalls: calls }
				: calls.length === 0
					? { text }
					: { text, toolCalls: calls };
		replayed.push({ role: 'assistant', content });
		text = undefined;
		calls = [];
	};
	for (const part of parts) {
		if (part.kind === 'text') {
			flush();
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
