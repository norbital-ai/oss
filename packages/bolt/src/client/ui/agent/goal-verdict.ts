import { Result, Schema } from 'effect';

/**
 * An independent verifier's verdict on a goal-mode turn.
 *
 * Stored as JSON on the message so the agent loop, durable replay and the transcript panel all read
 * one representation — the panel must never import the server-side verifier to understand a result
 * it is only displaying. Both readers here returned `null` unconditionally, which made the goal and
 * verifier branches of the transcript dead code that TypeScript reported as unreachable.
 */

const GoalVerdictSchema = Schema.Struct({
	achieved: Schema.Boolean,
	summary: Schema.NonEmptyString,
	gaps: Schema.Array(Schema.String)
});
type GoalVerdict = Schema.Schema.Type<typeof GoalVerdictSchema>;

/** A stored goal verdict: the verdict fields plus the envelope tag reading them back requires. */
const StoredGoalVerdict = Schema.Struct({
	resultType: Schema.Literal('goal_verdict'),
	achieved: Schema.Boolean,
	summary: Schema.NonEmptyString,
	gaps: Schema.Array(Schema.String)
});

/** A stored verifier schedule: just the prompt, so an empty or missing one is not a schedule. */
const StoredVerifierScheduled = Schema.Struct({
	resultType: Schema.Literal('verifier_scheduled'),
	prompt: Schema.String
});

/** Reads a verdict previously stored on a message; anything else is not a verdict. */
export const parseStoredGoalVerdict = (content: string): GoalVerdict | null =>
	Result.map(
		Schema.decodeUnknownResult(Schema.fromJsonString(StoredGoalVerdict))(content),
		(parsed) => ({ achieved: parsed.achieved, summary: parsed.summary, gaps: parsed.gaps })
	).pipe(Result.getOrNull);

/** Reads the prompt a scheduled verifier will run; an empty prompt is not a schedule. */
export const parseStoredVerifierScheduled = (content: string): string | null => {
	const parsed = Result.getOrElse(
		Schema.decodeUnknownResult(Schema.fromJsonString(StoredVerifierScheduled))(content),
		() => null
	);
	return parsed === null || parsed.prompt.trim().length === 0 ? null : parsed.prompt;
};
