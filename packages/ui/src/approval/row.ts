// A read row's `$approval` (the host attaches it to every record an open approval request holds) and its one-line text.
import type { RowApproval, ViewBolt } from '../client/contract.js';
import { msg } from '../text/messages.js';

const isApproval = (v: unknown): v is RowApproval =>
	typeof v === 'object' &&
	v !== null &&
	'requestId' in v &&
	typeof v.requestId === 'string' &&
	'state' in v &&
	(v.state === 'Pending' || v.state === 'ChangesRequested') &&
	'step' in v &&
	typeof v.step === 'number' &&
	'steps' in v &&
	typeof v.steps === 'number' &&
	'requestedBy' in v &&
	typeof v.requestedBy === 'string' &&
	'waitingOn' in v &&
	Array.isArray(v.waitingOn) &&
	v.waitingOn.every((w: unknown) => typeof w === 'string');

/** The row's open approval, or null. */
export const approvalOf = (row: unknown): RowApproval | null =>
	typeof row === 'object' && row !== null && '$approval' in row && isApproval(row.$approval)
		? row.$approval
		: null;

/** "Requested by Ana · Pending step 1/2 · waiting on Finance" (or "Changes requested · waiting on Ana"). */
export function approvalText(bolt: Pick<ViewBolt, 't'>, a: RowApproval): string {
	const status =
		a.state === 'Pending'
			? msg(bolt, 'approval.pendingStep', 'Pending step {k}/{n}', { k: a.step + 1, n: a.steps })
			: msg(bolt, 'approval.status.CHANGES_REQUESTED', 'Changes requested');
	return [
		msg(bolt, 'approval.requestedBy', 'Requested by {who}', { who: a.requestedBy }),
		status,
		msg(bolt, 'approval.waitingOn', 'waiting on {who}', {
			who: a.waitingOn.join(` ${msg(bolt, 'approval.or', 'or')} `)
		})
	].join(' · ');
}

/** The lock's reason as the record shows it: who may change the record now. */
export const lockText = (bolt: Pick<ViewBolt, 't'>, a: RowApproval | null): string =>
	a === null
		? msg(bolt, 'approval.locked', 'Under approval: only its approvers or requester may change it')
		: msg(bolt, 'approval.lockedBy', 'Under approval: {who} may change it', {
				who: a.waitingOn.join(` ${msg(bolt, 'approval.or', 'or')} `)
			});
