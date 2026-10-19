// Source route matching and exact team eligibility for approval requests.
import type { ApprovalRoute, Authority, Bindings, EngineActor, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { catalogOf, toPred } from '../access/pred.ts';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { actorRef } from '../write/commit.ts';
import { canonical } from '../write/sql.ts';
import { OPEN, type ApprovalRole, type ApprovalState } from './machine.ts';

type Match = {
	record?: unknown;
	previous?: unknown;
	changed?: readonly string[];
	requestor?: 'in_team' | 'no_team' | { team: readonly string[] };
	and?: readonly Match[];
	or?: readonly Match[];
	not?: Match;
};
/** A root row as the engine will write it: the post-image (null on delete), the stored row, the changed fields. */
export type RouteRow = {
	op: 'create' | 'update' | 'delete';
	pre: RowData | null;
	post: RowData | null;
	changed: readonly string[];
};
/** The snapshot a request carries (rule 44): authored team handles, so a later release cannot restate it. */
type Snapshot = { steps: readonly (readonly string[])[]; superseded_by: readonly string[] };
/** Malformed stored handles narrow eligibility to nobody. */
export function routeSnapshot(value: unknown): Snapshot {
	const teams = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((team): team is string => typeof team === 'string') : [];
	const steps =
		typeof value === 'object' && value !== null && 'steps' in value ? value.steps : undefined;
	const superseders =
		typeof value === 'object' && value !== null && 'superseded_by' in value
			? value.superseded_by
			: undefined;
	return { steps: Array.isArray(steps) ? steps.map(teams) : [], superseded_by: teams(superseders) };
}
/** The durable request as a decision reads it. */
export type Request = {
	state: ApprovalState;
	step: number;
	requestor: string;
	route: Snapshot;
};

const same = (a: string, b: string | undefined) => b !== undefined && a === b;
/** `teams[0]`: eligibility never walks the team tree; static identities have none. */
const ownTeam = (a: EngineActor): string | undefined =>
	a.kind === 'member' ? a.teams[0] : undefined;

export function matches(
	m: EngineManifest,
	c: string,
	b: Bindings,
	auth: Authority,
	match: Match | undefined,
	row: RouteRow,
	prepared?: EvalEnv
): boolean {
	if (match === undefined) return true;
	const env = prepared ?? { cat: catalogOf(m), bindings: b, authority: auth };
	const is = (w: unknown, r: RowData | null) => r !== null && evaluate(env, c, toPred(m, c, w), r);
	const team = ownTeam(auth.actor),
		req = match.requestor,
		again = (x: Match) => matches(m, c, b, auth, x, row, prepared);
	return (
		(match.record === undefined || is(match.record, row.post ?? row.pre)) &&
		(match.previous === undefined || (row.op === 'update' && is(match.previous, row.pre))) &&
		(match.changed === undefined || match.changed.some((f) => row.changed.includes(f))) &&
		(req === undefined ||
			(req === 'in_team'
				? team !== undefined
				: req === 'no_team'
					? team === undefined
					: req.team.some((t) => same(t, team)))) &&
		(match.and ?? []).every(again) &&
		(match.or === undefined || match.or.some(again)) &&
		(match.not === undefined || !again(match.not))
	);
}

/**
 * Rule 44: one route for the batch. A row matching no route rides the batch's route; two rows resolving to different
 * routes are `split`; no routed row is `null` (the write commits directly).
 */
export function resolve(
	m: EngineManifest,
	c: string,
	b: Bindings,
	auth: Authority,
	rows: readonly (RouteRow & { routes: readonly ApprovalRoute[] })[]
): Snapshot | 'split' | null {
	let chosen: Snapshot | null = null;
	for (const row of rows) {
		const r = row.routes.find((x) => matches(m, c, b, auth, x.match as Match | undefined, row));
		if (r === undefined) continue;
		const snap: Snapshot = { steps: r.steps, superseded_by: r.superseded_by ?? [] };
		if (chosen !== null && canonical(chosen) !== canonical(snap)) return 'split';
		chosen ??= snap;
	}
	return chosen;
}

/** Rule 46: an approver of the current step (`teams[0]`, exact source handle). */
export const canApprove = (r: Request, a: EngineActor): boolean =>
	(r.route.steps[r.step] ?? []).some((t) => same(t, ownTeam(a)));
/** An administrator or a `superseded_by` team finishes every remaining step. */
export const canSupersede = (r: Request, auth: Authority): boolean =>
	auth.admin || r.route.superseded_by.some((t) => same(t, ownTeam(auth.actor)));
/** The caller's roles on a request (machine.ts): the current step's approver, the requester, a superseder. */
export const rolesOf = (r: Request, auth: Authority): ReadonlySet<ApprovalRole> =>
	new Set<ApprovalRole>([
		...(canApprove(r, auth.actor) ? (['approver'] as const) : []),
		...(r.requestor === actorRef(auth.actor) ? (['requester'] as const) : []),
		...(canSupersede(r, auth) ? (['superseder'] as const) : []),
		...(auth.admin ? (['administrator'] as const) : [])
	]);
/** Who participates in an open request: requestor, current approver, superseder, administrator. */
export const participant = (r: Request, auth: Authority): boolean =>
	OPEN.includes(r.state) && rolesOf(r, auth).size > 0;
