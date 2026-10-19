/** Native SQL pieces for purging the requests holding an erased record, and their readable projections.
 * `where` is a trusted, gated predicate on approval alias `a`; `otherNotices` is an optional predicate on alias `n`. */
export function purgeProposals(
	where: string,
	otherNotices?: string
): Readonly<Record<string, string>> {
	return {
		approvals_gone: `DELETE FROM bolt_approvals a WHERE ${where} RETURNING id`,
		approval_requestors_gone: `DELETE FROM requestor WHERE approval_request_id IN (SELECT id FROM approvals_gone) RETURNING id`,
		// Delete dependent requestors before their referenced request.
		approval_requests_gone: `DELETE FROM approval_request WHERE id IN (SELECT id FROM approvals_gone)
			AND (SELECT count(*) FROM approval_requestors_gone) >= 0 RETURNING id`,
		notices_gone: `DELETE FROM sys_notification n WHERE
			EXISTS (SELECT 1 FROM approvals_gone a WHERE n.once LIKE a.id::text || ':%')${otherNotices === undefined ? '' : ` OR (${otherNotices})`}`
	};
}
