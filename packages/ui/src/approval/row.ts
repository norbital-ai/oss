// A read row's `$approval` (the host attaches it to every record an open approval request holds) and its one-line text.
import type { ApprovalView, RowApproval, ViewBolt } from '../client/contract.js';
import { msg, catalogText } from '../text/messages.js';
import { Option, Schema } from 'effect';

const RowApprovalSchema: Schema.Codec<RowApproval> = Schema.Struct({
	request_id: Schema.String,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	step: Schema.Number,
	steps: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			teams: Schema.Array(Schema.String),
			users: Schema.Array(Schema.String)
		})
	),
	requested_by: Schema.String,
	pending_delete: Schema.optionalKey(Schema.Literal(true))
});
// `$approval` is a host-attached system member no model declares: it arrives untyped on the row and decodes here once.
const decodeApproval = Schema.decodeUnknownOption(Schema.Struct({ $approval: RowApprovalSchema }));

/** The row's open approval, or null. */
export const approvalOf = (row: unknown): RowApproval | null =>
	Option.getOrNull(Option.map(decodeApproval(row), (held) => held.$approval));

/** Who the request waits on: the current step's name, or the requester while changes are requested. */
const waiting = (a: RowApproval): string =>
	a.state === 'Pending' ? (a.steps[a.step]?.name ?? '') : a.requested_by;

/** "Requested by Ada · Pending step 1/2 · waiting on Controller review" (or "Changes requested · waiting on Ada"). */
export function approvalText(bolt: Pick<ViewBolt, 't'>, a: RowApproval): string {
	const status =
		a.state === 'Pending'
			? msg(bolt, 'approval.pendingStep', {
					k: a.step + 1,
					n: a.steps.length
				})
			: msg(bolt, 'approval.status.ChangesRequested');
	return [
		...(a.pending_delete === true ? [msg(bolt, 'table.pendingDelete')] : []),
		msg(bolt, 'approval.requested_by', { who: a.requested_by }),
		status,
		msg(bolt, 'approval.waitingOn', { who: waiting(a) })
	].join(' · ');
}

/** The lock's reason as the record shows it: who may change the record now. */
export const lockText = (bolt: Pick<ViewBolt, 't'>, a: RowApproval | null): string =>
	a === null
		? msg(bolt, 'approval.locked')
		: a.state === 'Pending'
			? msg(bolt, 'approval.lockedStep', {
					step: waiting(a)
				})
			: msg(bolt, 'approval.lockedBy', { who: waiting(a) });

/** A record the viewer may edit while its request asks for changes: saving it resubmits the request. */
export const resubmits = (row: unknown): boolean => approvalOf(row)?.state === 'ChangesRequested';

/** One status label for a request (the scope selector, the panel's head). */
export function approvalStatus(bolt: Pick<ViewBolt, 't'>, status: string): string {
	const words: Readonly<Record<string, string>> = {
		Pending: 'Pending',
		ChangesRequested: 'Changes requested',
		Approved: 'Approved',
		Rejected: 'Rejected',
		Superseded: 'Superseded',
		Withdrawn: 'Withdrawn'
	};
	return catalogText(bolt, `approval.status.${status}`, words[status] ?? status);
}

/** Where a request stands in a record's history: "Waiting for approval" while pending, else its status in words. */
export const historyStatus = (bolt: Pick<ViewBolt, 't'>, status: string): string =>
	status === 'Pending' ? msg(bolt, 'approval.waiting') : approvalStatus(bolt, status);

const MOVE_TEXT: Readonly<Record<ApprovalView['log'][number]['move'], string>> = {
	request: 'Requested',
	approve: 'Approved',
	reject: 'Rejected',
	request_changes: 'Requested changes',
	resubmit: 'Resubmitted',
	supersede: 'Superseded',
	withdraw: 'Withdrew'
};
/** One log entry's move in words ("Requested changes"). */
export const moveText = (bolt: Pick<ViewBolt, 't'>, move: ApprovalView['log'][number]['move']): string =>
	catalogText(bolt, `approval.move.${move}`, MOVE_TEXT[move]);
