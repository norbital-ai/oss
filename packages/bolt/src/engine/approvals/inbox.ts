import { Option, Schema } from 'effect';
import type { ApprovalStep } from '../../decl/access/policy.ts';
import type { Authority, RowData, Sql } from '../contracts.ts';
import { actorRef } from '../write/commit.ts';
import { canApprove, canSupersede, rolesOf } from './route.ts';
import { Snapshot } from './snapshot.ts';
import { decisionsFor, type ApprovalDecision, type ApprovalState } from './machine.ts';

/**
 * An open request in the caller's inbox: what it holds, its state at `step` of its named `steps`, who asked, and the
 * decisions the caller may take now (machine.ts). The requester sees their own pending status; saving the record in
 * ChangesRequested resubmits it.
 */
export type InboxRequest = {
	id: string;
	collection: string;
	record: string;
	action: string;
	status: Extract<ApprovalState, 'Pending' | 'ChangesRequested'>;
	step: number;
	steps: readonly ApprovalStep[];
	at: string;
	requestor: string;
	by: string;
	mine: boolean;
	canDecide: boolean;
	canSupersede: boolean;
	moves: readonly { decision: ApprovalDecision; reason: 'required' | 'optional' }[];
};

// Eligibility filters the bounded candidate set; these are private rows, never a caller's collection read.
export const openRequests: Sql = {
	text: `SELECT a.id::text AS id, a.state, a.collection, a.record, a.action, a.requestor, a.step, a.route, a.at::text AS at,
	coalesce(u.name, u.email, a.requestor) AS by FROM bolt_approvals a LEFT JOIN sys_user u ON a.requestor = 'member:' || u.id
	WHERE a.state IN ('Pending', 'ChangesRequested') ORDER BY a.at DESC LIMIT 2000`,
	params: []
};
const Open = Schema.Struct({
	id: Schema.String,
	state: Schema.Literals(['Pending', 'ChangesRequested']),
	collection: Schema.String,
	record: Schema.String,
	action: Schema.String,
	requestor: Schema.String,
	step: Schema.Number,
	route: Snapshot,
	at: Schema.String,
	by: Schema.String
});
const decodeOpen = Schema.decodeUnknownOption(Open);
export function inboxRequests(rows: readonly RowData[], auth: Authority): InboxRequest[] {
	const actor = auth.actor;
	if (actor.kind !== 'member' || actor.external) return [];
	const me = actorRef(actor),
		requests: InboxRequest[] = [];
	for (const raw of rows) {
		// a malformed stored row names nobody
		const row = Option.getOrUndefined(decodeOpen(raw));
		if (row === undefined) continue;
		const moves = decisionsFor(row.state, rolesOf(row, auth));
		const mine = row.requestor === me;
		if (moves.length === 0 && !mine) continue;
		requests.push({
			id: row.id,
			collection: row.collection,
			record: row.record,
			action: row.action,
			status: row.state,
			step: row.step,
			steps: row.route.steps,
			at: row.at,
			requestor: row.requestor,
			by: row.by,
			mine,
			canDecide: row.state === 'Pending' && canApprove(row, actor),
			canSupersede: row.state === 'Pending' && canSupersede(row, auth),
			moves
		});
		if (requests.length === 200) break;
	}
	return requests;
}
