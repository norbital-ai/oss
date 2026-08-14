/**
 * Independent end-action for a turn: the main agent works, then a verifier decides whether it may stop.
 *
 * The verifier is a separate `ai.prompt` with no tools and a different system prompt. It does not
 * trust the agent's last sentence. The check it runs is the intent's verifier prompt — the same
 * text the composer showed — unless the person edited it. A failed verdict is written into the
 * transcript and injected back into the window so the main agent continues.
 */
import type { AiMessage } from '@norbital-ai/platform-utils/runtime/binding';
import { pruneToolResultsInWindow } from '$lib/shared/agent/context-window.js';
import { replayAutomationAi } from '$lib/server/run/automation-replay.server.js';
import { readChatSession, updateChatMessage } from '$lib/server/agent/chat-session.server.js';
import type { AgentAutomationSpec } from '$lib/authoring/automations/automations.js';
import {
	parseGoalVerdict,
	parseStoredGoalVerdict,
	parseStoredVerifierScheduled,
	serializeGoalVerdict,
	serializeVerifierScheduled,
	UNREADABLE_VERDICT,
	type GoalVerdict
} from '$lib/shared/agent/goal-verdict.js';

export {
	GoalVerdictSchema,
	parseGoalVerdict,
	parseStoredGoalVerdict,
	serializeGoalVerdict,
	UNREADABLE_VERDICT,
	type GoalVerdict
} from '$lib/shared/agent/goal-verdict.js';

/** Independent checks per root turn, including the last one that is allowed to fail-closed. */
export const MAX_GOAL_VERIFICATIONS = 3;

export const GOAL_MODE_REMINDER = `## Work turn

This turn is a work turn. Do the work the person asked for. When you would stop, an independent verifier — not you — checks the transcript against the end-action prompt for this intent. Claims without tool results do not count. If the verifier finds gaps, you will be sent back to close them. You may list, read, message, or wait for other agents in this sandbox only — the same person on web, or the same channel profile. Never another user or another channel. spawn_subagent waits in this session. await_sandbox_agent parks this turn until a sibling session settles. Do not announce completion until the work is done.`;

export const PLAN_VERIFIER_REMINDER = `When you would stop, an independent verifier — not you — checks whether this plan is complete and executable. You do not decide that.`;

export const GOAL_VERIFIER_SYSTEM_PROMPT = `You are an independent verifier. You did not do this work and you must not finish it. Decide whether the agent actually fulfilled the person's request.

Be skeptical of the agent's own claims. A sentence that says the work is done is not evidence. Prefer tool results, record identifiers, and concrete outcomes. If the transcript does not show the work, it is not done.

Reply with JSON only, no markdown:
{"achieved": boolean, "summary": string, "gaps": string[]}
- achieved: true only when the request is fully met.
- summary: one or two sentences a person can read.
- gaps: what is still missing. Empty only when achieved is true.`;

/** Prompt text that sends the main agent back to close verifier gaps. */
export function renderGoalContinuation(verdict: GoalVerdict): string {
	if (verdict.achieved) {
		return `Goal verification passed. ${verdict.summary}`;
	}
	const gaps =
		verdict.gaps.length > 0
			? verdict.gaps.map((gap) => `- ${gap}`).join('\n')
			: '- The request is not fully met.';
	return (
		`Goal verification failed. ${verdict.summary}\nGaps:\n${gaps}\n` +
		'Continue until these gaps are closed. Treat the current workspace, tool results, and ' +
		'durable session state as authoritative; inspect them instead of assuming earlier narration ' +
		'is still current. Do not claim the work is done until the gaps are closed.'
	);
}

/** Window message carrying a failed verifier verdict back to the main agent. */
export function goalContinuationMessage(verdict: GoalVerdict): AiMessage {
	return {
		role: 'user',
		content: `<goal-verification>\n${renderGoalContinuation(verdict)}\n</goal-verification>`
	};
}

/** Rebuild a verifier verdict row as a user message for the next window. */
export function windowMessageFromStoredGoal(content: string): AiMessage {
	const verdict = parseStoredGoalVerdict(content);
	return goalContinuationMessage(verdict ?? UNREADABLE_VERDICT);
}

/** Compose the independent verifier prompt from the turn's request and transcript. */
export function buildGoalVerificationPrompt(input: {
	readonly userRequest: string;
	readonly messages: readonly AiMessage[];
	readonly verifierPrompt: string;
}): string {
	return [
		'Verifier instructions:',
		input.verifierPrompt,
		'',
		"Person's request:",
		input.userRequest,
		'',
		'Transcript (assistant claims are not evidence; tool results are):',
		JSON.stringify(pruneToolResultsInWindow(input.messages))
	].join('\n');
}

/**
 * Prior independent checks on this turn.
 *
 * Durable replay already persisted the current verify's row. Count only verdicts whose
 * `durable_ordinal` is strictly before the upcoming `ai.prompt`, so live and replay agree.
 */
export async function countGoalVerdicts(
	sessionId: string,
	turnId: string,
	options?: { readonly beforeOrdinal?: number }
): Promise<number> {
	const session = await readChatSession(sessionId);
	return session.messages.filter((message) => {
		if (message.turn_id !== turnId || message.kind !== 'goal') return false;
		const content = message.parts[0]?.content;
		if (typeof content !== 'string' || !parseStoredGoalVerdict(content)) return false;
		if (options?.beforeOrdinal === undefined) return true;
		return (
			typeof message.durable_ordinal === 'number' && message.durable_ordinal < options.beforeOrdinal
		);
	}).length;
}

/** Latest scheduled end-action prompt on this turn, including a person-edited one. */
export async function readScheduledVerifierPrompt(
	sessionId: string,
	turnId: string
): Promise<string | null> {
	const session = await readChatSession(sessionId);
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (!message || message.turn_id !== turnId || message.kind !== 'goal') continue;
		const content = message.parts[0]?.content;
		if (typeof content !== 'string') continue;
		const prompt = parseStoredVerifierScheduled(content);
		if (prompt) return prompt;
	}
	return null;
}

/** Replace the scheduled verifier prompt on this conversation's open root turn. */
export async function updateScheduledVerifierPrompt(
	sessionId: string,
	prompt: string
): Promise<void> {
	const trimmed = prompt.trim();
	if (!trimmed) throw new Error('Verifier prompt is empty');
	const session = await readChatSession(sessionId);
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (!message || message.kind !== 'goal') continue;
		const content = message.parts[0]?.content;
		if (typeof content !== 'string' || !parseStoredVerifierScheduled(content)) continue;
		await updateChatMessage(sessionId, message.norbital_id, {
			parts: [{ role: 'system', content: serializeVerifierScheduled(trimmed) }]
		});
		return;
	}
	throw new Error('No verifier is scheduled on this conversation');
}

/**
 * One independent check. Durable turns fence this as `ai.prompt` so replay returns the same verdict.
 */
export function replayGoalVerification(input: {
	readonly spec: AgentAutomationSpec;
	readonly userRequest: string;
	readonly messages: readonly AiMessage[];
	readonly verifierPrompt: string;
}): GoalVerdict {
	const text = replayAutomationAi({
		request: {
			kind: 'ai.prompt',
			prompt: `${GOAL_VERIFIER_SYSTEM_PROMPT}\n\n${buildGoalVerificationPrompt(input)}`,
			...(input.spec.model ? { model: input.spec.model } : {}),
			...(input.spec.profile ? { profile: input.spec.profile } : {})
		}
	});
	return typeof text === 'string' ? parseGoalVerdict(text) : UNREADABLE_VERDICT;
}

/**
 * After a verdict is in hand: persist it, and say whether the main loop may actually stop.
 *
 * The last allowed attempt stops even when it failed, so a stubborn gap cannot run forever.
 */
export function acceptGoalStop(verdict: GoalVerdict, attemptsIncludingThis: number): boolean {
	return verdict.achieved || attemptsIncludingThis >= MAX_GOAL_VERIFICATIONS;
}
