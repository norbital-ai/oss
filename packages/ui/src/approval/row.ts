// A read row's `$approval` (the host attaches it to every record an open approval request holds) and its one-line text.
import type { RowApproval, ViewBolt } from '../client/contract.js';
import { msg } from '../text/messages.js';

const strings = (v: unknown): boolean =>
	Array.isArray(v) && v.every((s: unknown) => typeof s === 'string');
const isStep = (v: unknown): boolean =>
	typeof v === 'object' &&
	v !== null &&
	'name' in v &&
	typeof v.name === 'string' &&
	'teams' in v &&
	strings(v.teams) &&
	'users' in v &&
	strings(v.users);
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
	Array.isArray(v.steps) &&
	v.steps.every(isStep) &&
	'requestedBy' in v &&
	typeof v.requestedBy === 'string';

/** The row's open approval, or null. */
export const approvalOf = (row: unknown): RowApproval | null =>
	typeof row === 'object' && row !== null && '$approval' in row && isApproval(row.$approval)
		? row.$approval
		: null;

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
