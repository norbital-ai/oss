/**
 * Independent goal-mode verdict. Shared so the loop, durable replay, and the transcript
 * panel all read the same stored JSON — the UI must not import the server verifier.
 */
import { z } from 'zod';

export const GoalVerdictSchema = z.object({
	achieved: z.boolean(),
	summary: z.string().min(1),
	gaps: z.array(z.string())
});

export type GoalVerdict = z.infer<typeof GoalVerdictSchema>;

export const UNREADABLE_VERDICT: GoalVerdict = {
	achieved: false,
	summary: 'The verifier did not return a usable verdict.',
	gaps: ['Independent verification failed to produce a structured result. Continue the work.']
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGoalVerdict(text: string): GoalVerdict {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	const raw = fenced?.[1]?.trim() ?? trimmed;
	try {
		return GoalVerdictSchema.parse(JSON.parse(raw));
	} catch {
		return UNREADABLE_VERDICT;
	}
}

export function parseStoredGoalVerdict(content: string): GoalVerdict | null {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed) || parsed.resultType !== 'goal_verdict') return null;
		return GoalVerdictSchema.parse({
			achieved: parsed.achieved,
			summary: parsed.summary,
			gaps: parsed.gaps
		});
	} catch {
		return null;
	}
}

export function serializeVerifierScheduled(prompt: string): string {
	return JSON.stringify({ resultType: 'verifier_scheduled', prompt });
}

export function parseStoredVerifierScheduled(content: string): string | null {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed) || parsed.resultType !== 'verifier_scheduled') return null;
		return typeof parsed.prompt === 'string' && parsed.prompt.trim() ? parsed.prompt : null;
	} catch {
		return null;
	}
}

export function serializeGoalVerdict(verdict: GoalVerdict): string {
	return JSON.stringify({
		resultType: 'goal_verdict',
		achieved: verdict.achieved,
		summary: verdict.summary,
		gaps: verdict.gaps
	});
}
