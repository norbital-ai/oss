import { Schema } from 'effect';

/**
 * An independent verifier's verdict on a goal-mode turn.
 *
 * Stored as JSON on the message so the agent loop, durable replay and the transcript panel all read
 * one representation — the panel must never import the server-side verifier to understand a result
 * it is only displaying. Both readers here returned `null` unconditionally, which made the goal and
 * verifier branches of the transcript dead code that TypeScript reported as unreachable.
 */

export const GoalVerdict = Schema.Struct({
	achieved: Schema.Boolean,
	summary: Schema.NonEmptyString,
	gaps: Schema.Array(Schema.String)
});
export interface GoalVerdict extends Schema.Schema.Type<typeof GoalVerdict> {}

/** What a goal turn reports when verification itself failed to produce a structured answer. */
export const UNREADABLE_VERDICT: GoalVerdict = {
	achieved: false,
	summary: 'The verifier did not return a usable verdict.',
	gaps: ['Independent verification failed to produce a structured result. Continue the work.']
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a verdict out of a model reply, which commonly arrives fenced in a code block.
 * An unreadable reply is a stated non-verdict rather than a thrown error: the turn happened, and
 * reporting "not verified" is more useful than losing the message.
 */
export const parseGoalVerdict = (text: string): GoalVerdict => {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	const raw = fenced?.[1]?.trim() ?? trimmed;
	try {
		return Schema.decodeUnknownSync(GoalVerdict)(JSON.parse(raw));
	} catch {
		return UNREADABLE_VERDICT;
	}
};

/** Reads a verdict previously stored on a message; anything else is not a verdict. */
export const parseStoredGoalVerdict = (content: string): GoalVerdict | null => {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed) || parsed['resultType'] !== 'goal_verdict') return null;
		return Schema.decodeUnknownSync(GoalVerdict)({
			achieved: parsed['achieved'],
			summary: parsed['summary'],
			gaps: parsed['gaps']
		});
	} catch {
		return null;
	}
};

export const serializeGoalVerdict = (verdict: GoalVerdict): string =>
	JSON.stringify({ resultType: 'goal_verdict', ...verdict });

export const serializeVerifierScheduled = (prompt: string): string =>
	JSON.stringify({ resultType: 'verifier_scheduled', prompt });

/** Reads the prompt a scheduled verifier will run; an empty prompt is not a schedule. */
export const parseStoredVerifierScheduled = (content: string): string | null => {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed) || parsed['resultType'] !== 'verifier_scheduled') return null;
		const prompt = parsed['prompt'];
		return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt : null;
	} catch {
		return null;
	}
};
