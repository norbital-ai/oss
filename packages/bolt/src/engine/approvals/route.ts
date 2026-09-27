// Approval routing and eligibility (rules 44, 46; `docs/access/approvals.md`), pure: the first route whose `match`
// matches a root row supplies the steps; a batch shares one route; who may decide or write under a hold.
import type { ApprovalRoute, Authority, Bindings, EngineActor, EngineManifest, RowData } from '../contracts.ts';
import { catalogOf, toPred } from '../access/pred.ts';
import { evaluate } from '../query/eval.ts';
import { actorRef } from '../write/commit.ts';
import { canonical } from '../write/sql.ts';

type Match = {
	record?: unknown; previous?: unknown; changed?: readonly string[];
	requestor?: 'in_team' | 'no_team' | { team: readonly string[] };
	and?: readonly Match[]; or?: readonly Match[]; not?: Match;
};
/** A root row as the engine will write it: the post-image (null on delete), the stored row, the changed fields. */
export type RouteRow = { op: 'create' | 'update' | 'delete'; pre: RowData | null; post: RowData | null; changed: readonly string[] };
/** The snapshot a request carries (rule 44): team names only, so a later release cannot restate it. */
export type Snapshot = { steps: readonly (readonly string[])[]; superceded_by: readonly string[] };
/** The durable request as a decision reads it. */
export type Request = { state: 'Pending' | 'Approved' | 'Rejected' | 'ChangesRequested' | 'Withdrawn'; step: number; requestor: string; route: Snapshot };

const same = (a: string, b: string | undefined) => b !== undefined && a.toLowerCase() === b.toLowerCase();
/** `teamPath[0]`: eligibility never walks the team tree; static identities have none. */
const ownTeam = (a: EngineActor): string | undefined => a.kind === 'member' ? a.teamPath[0] : undefined;

export function matches(m: EngineManifest, c: string, b: Bindings, auth: Authority, match: Match | undefined, row: RouteRow): boolean {
	if (match === undefined) return true;
	const env = { cat: catalogOf(m), bindings: b, authority: auth };
	const is = (w: unknown, r: RowData | null) => r !== null && evaluate(env, c, toPred(m, c, w), r);
	const team = ownTeam(auth.actor), req = match.requestor, again = (x: Match) => matches(m, c, b, auth, x, row);
	return (match.record === undefined || is(match.record, row.post ?? row.pre))
		&& (match.previous === undefined || (row.op === 'update' && is(match.previous, row.pre)))
		&& (match.changed === undefined || match.changed.some((f) => row.changed.includes(f)))
		&& (req === undefined || (req === 'in_team' ? team !== undefined : req === 'no_team' ? team === undefined : req.team.some((t) => same(t, team))))
		&& (match.and ?? []).every(again) && (match.or === undefined || match.or.some(again)) && (match.not === undefined || !again(match.not));
}

/**
 * Rule 44: one route for the batch. A row matching no route rides the batch's route; two rows resolving to different
 * routes are `split`; no routed row is `null` (the write commits directly).
 */
export function resolve(m: EngineManifest, c: string, b: Bindings, auth: Authority,
	rows: readonly (RouteRow & { routes: readonly ApprovalRoute[] })[]): Snapshot | 'split' | null {
	let chosen: Snapshot | null = null;
	for (const row of rows) {
		const r = row.routes.find((x) => matches(m, c, b, auth, x.match as Match | undefined, row));
		if (r === undefined) continue;
		const snap: Snapshot = { steps: r.steps, superceded_by: r.superceded_by ?? [] };
		if (chosen !== null && canonical(chosen) !== canonical(snap)) return 'split';
		chosen ??= snap;
	}
	return chosen;
}

/** Rule 46: an approver of the current step (`teamPath[0]`, case-insensitive). */
export const canApprove = (r: Request, a: EngineActor): boolean => (r.route.steps[r.step] ?? []).some((t) => same(t, ownTeam(a)));
/** An administrator or a `superceded_by` team finishes every remaining step. */
export const canSupersede = (r: Request, auth: Authority): boolean => auth.admin || r.route.superceded_by.some((t) => same(t, ownTeam(auth.actor)));
/** Who may write under the hold while the request is pending: requestor, current approver, superseder, administrator. */
export const participant = (r: Request, auth: Authority): boolean =>
	r.state === 'Pending' && (auth.admin || r.requestor === actorRef(auth.actor) || canApprove(r, auth.actor) || canSupersede(r, auth));
