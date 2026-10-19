import { Effect } from 'effect';
import type {
	ActSuccess,
	ActFailure,
	Outcome,
	OutcomeFeedback,
	ViewBolt
} from '../client/contract.js';
import { msg } from '../text/messages.js';
export function outcomeText<O extends OutcomeFeedback>(bolt: Pick<ViewBolt, 't'>, o: O): string {
	switch (o.kind) {
		case 'committed':
			return msg(bolt, 'outcome.saved', 'Saved');
		case 'pendingApproval':
			return msg(bolt, 'outcome.pending', 'Submitted for review');
		case 'refused':
			return bolt.t(o.message);
		case 'conflict':
			return msg(bolt, 'outcome.conflict', 'Someone else changed this; reload and try again');
		case 'unknown':
			return msg(bolt, 'outcome.unknown', "Couldn't confirm; check again");
	}
}
/** Typed action failures as the form and toast presentation's settlement union. */
export const actOutcome = (action: Effect.Effect<ActSuccess, ActFailure>): Effect.Effect<Outcome> =>
	action.pipe(
		Effect.catch((error) =>
			Effect.succeed(
				error._tag === 'ActRefused'
					? {
							kind: 'refused' as const,
							code: error.code,
							message: error.message,
							...(error.field === undefined ? {} : { field: error.field }),
							...(error.row === undefined ? {} : { row: error.row })
						}
					: error._tag === 'ActConflict'
						? { kind: 'conflict' as const, records: error.records }
						: { kind: 'unknown' as const, invocation: error.invocation }
			)
		)
	);
