import { Effect } from 'effect';
import type {
	ActSuccess,
	AutomationHandle,
	ActFailure,
	Outcome,
	OutcomeFeedback,
	ProtocolFailure,
	ViewBolt
} from '../client/contract.js';
import { msg } from '../text/messages.js';
import { toast } from '../toast/toast.svelte.js';
export function outcomeText<O extends OutcomeFeedback>(bolt: Pick<ViewBolt, 't'>, o: O): string {
	switch (o.kind) {
		case 'committed':
			return msg(bolt, 'outcome.saved');
		case 'pending_approval':
			return msg(bolt, 'outcome.pending');
		case 'refused':
			return bolt.t(o.message);
		case 'conflict':
			return msg(bolt, 'outcome.conflict');
		case 'unknown':
			return msg(bolt, 'outcome.unknown');
		case 'running':
			return msg(bolt, 'outcome.running');
	}
}
/** Typed action failures as the form and toast presentation's settlement union. */
export const actOutcome = (action: Effect.Effect<ActSuccess, ActFailure>): Effect.Effect<Outcome, ProtocolFailure> =>
	action.pipe(
		Effect.catchTags({
			ActRefused: (error) => Effect.succeed({
				kind: 'refused' as const, code: error.code, message: error.message,
				...(error.field === undefined ? {} : { field: error.field }),
				...(error.row === undefined ? {} : { row: error.row })
			}),
			ActConflict: (error) => Effect.succeed({ kind: 'conflict' as const, records: error.records }),
			ActUnknown: (error) => Effect.succeed({ kind: 'unknown' as const, invocation: error.invocation })
		})
	);

/** Toasts `o`; `saved` replaces the generic "Saved" (a delete says "Deleted"). */
export function notify<O extends OutcomeFeedback>(
	bolt: Pick<ViewBolt, 't'>,
	o: O,
	saved?: string
): void {
	const text = o.kind === 'committed' && saved !== undefined ? saved : outcomeText(bolt, o);
	if (o.kind === 'committed') toast.success(text);
	else if (o.kind === 'pending_approval' || o.kind === 'running') toast.info(text);
	else if (o.kind === 'unknown') toast.warning(text);
	else toast.error(text);
}

/** Native forms present call results as a completed action and job receipts as their queue admission. */
export const automation_outcome = (handle: AutomationHandle): Effect.Effect<Outcome, ProtocolFailure> =>
	actOutcome(handle.mode === 'job' ? handle : handle.pipe(Effect.map((output) => ({ kind: 'committed' as const, output, records: [] }))));
