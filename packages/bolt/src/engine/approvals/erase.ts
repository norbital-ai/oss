import { capturePiece } from '../db/captured.ts';
import type { Chain } from '../write/sql.ts';

/** Purge requests and their dependent rows in the owning captured statement. */
export function purgeProposals(
	c: Chain,
	where: string,
	otherNotices?: string
): void {
	capturePiece(c, 'approvals_gone', 'bolt_approvals', `DELETE FROM bolt_approvals a WHERE ${where}`);
	capturePiece(c, 'approval_requestors_gone', 'requestor',
		'DELETE FROM requestor WHERE approval_request_id IN (SELECT id FROM approvals_gone)');
	capturePiece(c, 'approval_requests_gone', 'approval_request',
		`DELETE FROM approval_request WHERE id IN (SELECT id FROM approvals_gone)
		AND (SELECT count(*) FROM approval_requestors_gone) >= 0`);
	capturePiece(c, 'notices_gone', 'sys_notification', `DELETE FROM sys_notification n WHERE
		EXISTS (SELECT 1 FROM approvals_gone a WHERE n.once LIKE a.id::text || ':%')${otherNotices === undefined ? '' : ` OR (${otherNotices})`}`);
}
