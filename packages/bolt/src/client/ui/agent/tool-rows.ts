/**
 * One row per tool call.
 *
 * The provider persists a call inside the assistant message and its result as a separate tool
 * message. The panel reads them as one row: the call owns the row, the result is looked up by the
 * call id, and a tool message whose every result is claimed renders nothing of its own.
 */
import { Option, Result, Schema } from 'effect';
import type { Prompt } from 'effect/unstable/ai';
import type { Conversation } from './conversation-selector.js';
import type { PlanRow, TurnRow, PanelMessage } from './transcript.js';

export type ToolCallPart = Prompt.ToolCallPartEncoded;
export type ToolResultPart = Prompt.ToolResultPartEncoded;

export type ToolPairing = Readonly<{
	/** Every persisted result, by the id of the call it answers. */
	resultsByCallId: ReadonlyMap<string, ToolResultPart>;
	/** Every persisted call id; a result whose call is here is rendered on the call's row. */
	callIds: ReadonlySet<string>;
}>;

const isString = Schema.is(Schema.String);

/** Indexes calls and results across the loaded transcript so any row can find its other half. */
export function pairToolCalls(messages: readonly PanelMessage[]): ToolPairing {
	const resultsByCallId = new Map<string, ToolResultPart>();
	const callIds = new Set<string>();
	for (const message of messages) {
		const content = message.message.content;
		if (isString(content)) continue;
		for (const part of content) {
			if (part.type === 'tool-call') callIds.add(part.id);
			else if (part.type === 'tool-result') resultsByCallId.set(part.id, part);
		}
	}
	return { resultsByCallId, callIds };
}

const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(['subagent', 'system/subagent']);

const SpawnParams = Schema.Struct({
	action: Schema.Literal('spawn'),
	agentId: Schema.optionalKey(Schema.String)
});
const decodeSpawnParams = Schema.decodeUnknownOption(SpawnParams);

const SpawnResult = Schema.Struct({ conversationId: Schema.NonEmptyString });
const decodeSpawnResult = Schema.decodeUnknownOption(SpawnResult);

/** A `subagent` spawn call resolved against its result: the child it started, or why it did not. */
export type SubagentLink = Readonly<{
	toolCallId: string;
	agentId: string;
	/** The child task the spawn created; `null` while pending or after a failed spawn. */
	conversationId: string | null;
	/** The spawn's error text, rendered as the block's only line; `null` unless the spawn failed. */
	failure: string | null;
	/** True until the runtime has answered the call. */
	pending: boolean;
	raw: Readonly<{ params: unknown; result: unknown }>;
}>;

/** The child conversation a spawn row stands for, or `null` for any other tool call. */
export function subagentLink(call: ToolCallPart, result: ToolResultPart | undefined): SubagentLink | null {
	if (!SUBAGENT_TOOL_NAMES.has(call.name)) return null;
	const params = decodeSpawnParams(call.params);
	if (Option.isNone(params)) return null;
	const spawned = result === undefined || result.isFailure ? Option.none() : decodeSpawnResult(result.result);
	return {
		toolCallId: call.id,
		agentId: params.value.agentId ?? call.name,
		conversationId: Option.isSome(spawned) ? spawned.value.conversationId : null,
		failure: result?.isFailure === true ? diagnostic(result.result) : null,
		pending: result === undefined,
		raw: { params: call.params, result: result?.result }
	};
}

/** Everything a nested child conversation reads, handed down unchanged through every level. */
export type SubagentTranscript = Readonly<{
	tasks: readonly Conversation[];
	messages: readonly PanelMessage[];
	runs: readonly TurnRow[];
	plans: readonly PlanRow[];
}>;

/** Text for a payload: strings verbatim, everything else pretty JSON. */
export function diagnostic(value: unknown): string {
	if (isString(value)) return value;
	return Result.getOrElse(
		Result.try(() => JSON.stringify(value, null, 2) ?? String(value)),
		() => String(value)
	);
}

export function diagnosticLanguage(value: unknown): 'json' | 'plaintext' {
	const text = diagnostic(value).trimStart();
	return text.startsWith('{') || text.startsWith('[') ? 'json' : 'plaintext';
}
