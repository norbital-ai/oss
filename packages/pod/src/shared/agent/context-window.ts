/**
 * Model-window shaping: tool-result prune and compaction range selection.
 *
 * The transcript keeps the full tool result. The window the model sees may replace an oversized
 * result with a head, a marker, and a tail. Compaction then summarises the older prefix and keeps
 * a recent tail so the last tool exchange is not lost inside a recap.
 */
import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';
import type { chat_session } from '@norbital-ai/platform-utils/system/workspace-schema';

type ChatSessionRow = typeof chat_session.$inferSelect;

/** Transcript item inferred from the JSON schema owned by the chat_session collection. */
export type ChatSessionMessage = NonNullable<ChatSessionRow['messages']>[number];

/** Turn lifecycle inferred from the JSON schema owned by the chat_session collection. */
export type ChatSessionTurn = NonNullable<ChatSessionRow['turns']>[number];

/** The conversation fields Pod mutates and sends to the client, composed from its collection row. */
export type ChatSessionAggregate = Omit<
	Pick<
		ChatSessionRow,
		| 'norbital_id'
		| 'norbital_row_version'
		| 'user_id'
		| 'automation_run_id'
		| 'title'
		| 'visibility'
		| 'platform'
		| 'channel_key'
		| 'external_thread_id'
		| 'messages'
		| 'turns'
		| 'usage_cost_usd'
		| 'usage_total_tokens'
		| 'usage_turns_counted'
		| 'usage_turns_unreported'
	>,
	'norbital_row_version' | 'messages' | 'turns'
> & {
	readonly norbital_row_version: number;
	readonly messages: readonly ChatSessionMessage[];
	readonly turns: readonly ChatSessionTurn[];
};

/** Compact when estimated prompt tokens reach this fraction of the model's context. */
export const COMPACTION_CONTEXT_RATIO = 0.8;

/** Recent window kept verbatim, as a fraction of the model's context. */
export const COMPACTION_RETAIN_RATIO = 0.16;

export const TOOL_RESULT_PRUNE_THRESHOLD = 8192;
export const TOOL_RESULT_PRUNE_HEAD = 4096;
export const TOOL_RESULT_PRUNE_TAIL = 1024;
export const TOOL_RESULT_PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n';

export const COMPACTION_INSTRUCTION = `You are compacting an earlier span of this agent conversation so another model can continue the work.

Output EXACTLY these Markdown sections, in order. Use terse bullets. Write "(none)" for an empty section — never drop a section.

## Primary Request and Intent
- [the person's original and evolving request; quote verbatim where the exact wording matters]

## Key Technical Concepts
- [collections, files, policies, and conventions in play]

## Records and Code
- [identifiers, paths, and the changes or outcomes that matter]

## Errors and Fixes
- [error: how it was resolved, plus any related user correction]

## Pending Work
- [explicitly requested work not yet completed]

## Current Work
- [precisely what was in progress at this checkpoint]

## Next Step
- [the single next action, or "(none)"]

## Critical Context
- [decisions, constraints, user preferences, open questions]

Rules:
- Preserve exact collection names, record ids, file paths, commands, error strings, and identifiers.
- Capture user corrections faithfully.
- Do not mention this summarization request.
- If the conversation already contains a <conversation-summary> or <plan-summary> block, merge still-true facts into one checkpoint. Do not copy the prior block verbatim.`;

export function estimateTokens(value: unknown): number {
	return Math.ceil(JSON.stringify(value).length / 4);
}

export function pruneToolResultContent(content: string): string {
	if (content.length <= TOOL_RESULT_PRUNE_THRESHOLD) return content;
	const head = content.slice(0, TOOL_RESULT_PRUNE_HEAD);
	const tail = content.slice(-TOOL_RESULT_PRUNE_TAIL);
	return `${head}${TOOL_RESULT_PRUNE_MARKER}${tail}`;
}

export function pruneWindowMessage(message: AiMessage): AiMessage {
	if (message.role !== 'tool' || typeof message.content !== 'string') return message;
	const pruned = pruneToolResultContent(message.content);
	return pruned === message.content ? message : { ...message, content: pruned };
}

export function pruneToolResultsInWindow(messages: readonly AiMessage[]): AiMessage[] {
	return messages.map(pruneWindowMessage);
}

export function shouldAutomaticallyCompact(input: {
	readonly messages: readonly AiMessage[];
	readonly tools: readonly unknown[];
	readonly systemPrompt: string;
	readonly contextLength: number | null;
}): boolean {
	if (!input.contextLength || !Number.isFinite(input.contextLength) || input.contextLength <= 0) {
		return false;
	}
	const promptTokens = estimateTokens({
		messages: [{ role: 'system', content: input.systemPrompt }, ...input.messages],
		tools: input.tools
	});
	return promptTokens >= Math.floor(input.contextLength * COMPACTION_CONTEXT_RATIO);
}

export function retainTokenBudget(input: {
	readonly contextLength: number | null;
	readonly messages: readonly AiMessage[];
}): number {
	if (input.contextLength && Number.isFinite(input.contextLength) && input.contextLength > 0) {
		return Math.floor(input.contextLength * COMPACTION_RETAIN_RATIO);
	}
	return Math.max(1, Math.floor(estimateTokens(input.messages) * COMPACTION_RETAIN_RATIO));
}

/**
 * Keep a recent tail under `retainTokens`. Never cut between an assistant tool-call and its results.
 */
export function splitRetainedTail(
	messages: readonly AiMessage[],
	retainTokens: number
): { readonly head: AiMessage[]; readonly tail: AiMessage[] } {
	if (messages.length === 0) return { head: [], tail: [] };
	let used = 0;
	let cut = messages.length;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const cost = estimateTokens(messages[index]);
		if (used + cost > retainTokens && cut < messages.length) break;
		used += cost;
		cut = index;
	}
	while (cut > 0 && messages[cut]?.role === 'tool') cut -= 1;
	return {
		head: messages.slice(0, cut),
		tail: messages.slice(cut)
	};
}

export function compactionSummarizerPrompt(
	messages: readonly AiMessage[],
	instructions?: string
): string {
	const steer = instructions ? `\n\nThe person asked you to focus on: ${instructions}` : '';
	return `${COMPACTION_INSTRUCTION}${steer}\n\n${JSON.stringify(messages)}`;
}
