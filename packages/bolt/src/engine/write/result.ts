import { Effect } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { Outcome } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import type { ActResult } from '../services.ts';
import type { WriteEngine } from './act.ts';
import type { CommitAnswer } from './commit.ts';

export const LOST_OUTCOME: Extract<Outcome, { kind: 'refused' }> = {
	kind: 'refused', code: 'refused', message: 'The outcome was lost.'
};

/** One committed answer, its idempotent fallback and its actual post-commit publication. */
export const settleCommit = Effect.fn('Bolt.settleCommit')(function* (
	answer: CommitAnswer | undefined,
	stored: () => Effect.Effect<Outcome | null, EngineError>,
	publish: WriteEngine['committed'],
	missing?: Pick<BoltError, 'code' | 'message'>
): Effect.fn.Return<ActResult, EngineError> {
	if (answer === undefined)
		return yield* BoltError.make(missing?.code ?? 'bad_answer', 'commit', missing?.message ?? 'The commit returned no answer.');
	const outcome: Outcome = answer.outcome ?? (yield* stored())
		?? LOST_OUTCOME;
	const result: ActResult = {
		outcome, captured: answer.captured, v: publish === undefined ? 0 : yield* publish(answer)
	};
	return answer.read_guards_applied === true && (outcome.kind === 'committed' || outcome.kind === 'pending_approval')
		? { ...result, readGuardsConsumed: true }
		: result;
});
