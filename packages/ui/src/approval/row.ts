// A read row's `$approval` (the host attaches it to every record an open approval request holds) and its one-line text.
import type { RowApproval, ViewBolt } from '../client/contract.js';
import { msg } from '../text/messages.js';
import { Option, Schema } from 'effect';

const RowApprovalSchema: Schema.Codec<RowApproval> = Schema.Struct({
	requestId: Schema.String,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	step: Schema.Number,
	steps: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			teams: Schema.Array(Schema.String),
			users: Schema.Array(Schema.String)
		})
	),
	requestedBy: Schema.String
});
// `$approval` is a host-attached system member no model declares: it arrives untyped on the row and decodes here once.
const decodeApproval = Schema.decodeUnknownOption(Schema.Struct({ $approval: RowApprovalSchema }));

/** The row's open approval, or null. */
export const approvalOf = (row: unknown): RowApproval | null =>
	Option.getOrNull(Option.map(decodeApproval(row), (held) => held.$approval));

/** Who the request waits on: the current step's name, or the requester while changes are requested. */
const waiting = (a: RowApproval): string =>
	a.state === 'Pending' ? (a.steps[a.step]?.name ?? '') : a.requestedBy;

/** "Requested by Ada · Pending step 1/2 · waiting on Controller review" (or "Changes requested · waiting on Ada"). */
export function approvalText(bolt: Pick<ViewBolt, 't'>, a: RowApproval): string {
	const status =
		a.state === 'Pending'
			? msg(bolt, 'approval.pendingStep', 'Pending step {k}/{n}', {
					k: a.step + 1,
					n: a.steps.length
				})
			: msg(bolt, 'approval.status.ChangesRequested', 'Changes requested');
	return [
		msg(bolt, 'approval.requestedBy', 'Requested by {who}', { who: a.requestedBy }),
		status,
		msg(bolt, 'approval.waitingOn', 'waiting on {who}', { who: waiting(a) })
	].join(' · ');
}

/** The lock's reason as the record shows it: who may change the record now. */
export const lockText = (bolt: Pick<ViewBolt, 't'>, a: RowApproval | null): string =>
	a === null
		? msg(bolt, 'approval.locked', 'Under approval: only its approvers or requester may change it')
		: a.state === 'Pending'
			? msg(bolt, 'approval.lockedStep', 'Under approval: only {step} approvers may change it', {
					step: waiting(a)
				})
			: msg(bolt, 'approval.lockedBy', 'Under approval: {who} may change it', { who: waiting(a) });

/** A record the viewer may edit while its request asks for changes: saving it resubmits the request. */
export const resubmits = (row: unknown): boolean => approvalOf(row)?.state === 'ChangesRequested';

/** One status label for a request (the scope selector, the panel's head). */
export function approvalStatus(bolt: Pick<ViewBolt, 't'>, status: string): string {
	const words: Readonly<Record<string, string>> = {
		Pending: 'Pending',
		ChangesRequested: 'Changes requested',
		Approved: 'Approved',
		Rejected: 'Rejected',
		Superseded: 'Superseded'
	};
	return msg(bolt, `approval.status.${status}`, words[status] ?? status);
}
