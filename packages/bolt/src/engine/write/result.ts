import { Effect, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import type { Outcome } from '../contracts.ts';
import { Captured } from '../db/captured.ts';
import type { EngineError } from '../errors.ts';
import type { ActResult } from '../services.ts';

const AuditedRow = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	revision: Schema.Number,
	op: Schema.String,
	cause: Schema.String,
	old: Schema.Json,
	new: Schema.Json
});

/** Wire schema for one commit statement's returned row. */
export const CommitAnswer = Schema.Struct({
	outcome: Schema.NullOr(WriteOutcome),
	captured: Schema.Array(Captured),
	next_due: Schema.NullOr(Schema.String),
	changed_instances: Schema.Array(Schema.String),
	approval_decided: Schema.optionalKey(Schema.Number),
	read_guards_applied: Schema.optionalKey(Schema.Boolean),
	audited: Schema.optionalKey(
		Schema.Struct({
			at: Schema.String,
			committed_at: Schema.String,
			records: Schema.Array(AuditedRow)
		})
	)
});
export type CommitAnswer = typeof CommitAnswer.Type;

export const LOST_OUTCOME: Extract<Outcome, { kind: 'refused' }> = {
	kind: 'refused', code: 'refused', message: 'The outcome was lost.'
};

/** One committed answer, its idempotent fallback and its actual post-commit publication. */
export const settleCommit = Effect.fn('Bolt.settleCommit')(function* (
	answer: CommitAnswer | undefined,
	stored: () => Effect.Effect<Outcome | null, EngineError>,
	publish: (answer: CommitAnswer) => Effect.Effect<number>,
	missing?: Pick<BoltError, 'code' | 'message'>
): Effect.fn.Return<ActResult, EngineError> {
	if (answer === undefined)
		return yield* BoltError.make(missing?.code ?? 'bad_answer', 'commit', missing?.message ?? 'The commit returned no answer.');
	const outcome: Outcome = answer.outcome ?? (yield* stored())
		?? LOST_OUTCOME;
	const result: ActResult = {
		outcome, captured: answer.captured, v: yield* publish(answer)
	};
	return answer.read_guards_applied === true && (outcome.kind === 'committed' || outcome.kind === 'pending_approval')
		? { ...result, readGuardsConsumed: true }
		: result;
});
