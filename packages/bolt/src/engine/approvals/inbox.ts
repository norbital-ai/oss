import type { Authority, RowData, Sql } from '../contracts.ts';
import { actorRef } from '../write/commit.ts';
import { canApprove, canSupersede, rolesOf, routeSnapshot } from './route.ts';
import { movesFor, type ApprovalState } from './machine.ts';
import { STATUS, STATUS_OF, type DecisionStatus } from './approvals.ts';

/** The requestor's display name, the request's state and the caller's current moves (machine.ts). */
export type InboxRequest = {
	id: string;
	collection: string;
	record: string;
	action: string;
	status: string;
	step: number;
	steps: number;
	at: string;
	requestor: string;
	by: string;
	mine: boolean;
	canDecide: boolean;
	canSupersede: boolean;
	moves: readonly { status: DecisionStatus; reason: 'required' | 'optional' }[];
};

// Eligibility filters the bounded candidate set; these are private rows, never a caller's collection read.
export const openRequests: Sql = {
	text: `SELECT a.id::text AS id, a.state, a.collection, a.record, a.action, a.requestor, a.step, a.route, a.at::text AS at,
	coalesce(u.name, u.email, a.requestor) AS by FROM bolt_approvals a LEFT JOIN sys_user u ON a.requestor = 'member:' || u.id
	WHERE a.state IN ('Pending', 'ChangesRequested') ORDER BY a.at DESC LIMIT 2000`,
	params: []
};
export function inboxRequests(rows: readonly RowData[], auth: Authority): InboxRequest[] {
	const actor = auth.actor;
	if (actor.kind !== 'member' || actor.external) return [];
	const me = actorRef(actor),
		requests: InboxRequest[] = [];
	for (const row of rows) {
		const state: ApprovalState =
			row['state'] === 'ChangesRequested' ? 'ChangesRequested' : 'Pending';
		const request = {
			state,
			step: Number(row['step']),
			requestor: String(row['requestor']),
			route: routeSnapshot(row['route'])
		};
		const moves = movesFor(state, rolesOf(request, auth)).filter((m) => m.move !== 'comment');
		if (moves.length === 0) continue;
		requests.push({
			id: String(row['id']),
			collection: String(row['collection']),
			record: String(row['record']),
			action: String(row['action']),
			status: STATUS[state],
			step: request.step,
			steps: request.route.steps.length,
			at: String(row['at']),
			requestor: request.requestor,
			by: String(row['by']),
			mine: request.requestor === me,
			canDecide: state === 'Pending' && canApprove(request, actor),
			canSupersede: state === 'Pending' && canSupersede(request, auth),
			moves: moves.map(({ move, reason }) => ({ status: STATUS_OF[move], reason }))
		});
		if (requests.length === 200) break;
	}
	return requests;
}
