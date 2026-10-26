// A request's flow snapshot (spec §8) and who may act on it: a step is decided by its teams' members or its users.
import type { Authority, EngineActor } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { actorRef } from '../write/commit.ts';
import { OPEN, type ApprovalRole, type ApprovalState } from './machine.ts';
import type { Snapshot } from './snapshot.ts';

/** A team handle the snapshot names that the workspace does not declare (an authoring error). */
export const unknownTeam = (m: Pick<EngineManifest, 'teams'>, s: Snapshot): string | undefined =>
	[...s.steps.flatMap((step) => step.teams), ...s.superseded_by].find(
		(handle) => !Object.hasOwn(m.teams, handle)
	);
/** Two snapshots route alike: the same steps (names and approvers). */
export const sameFlow = (a: Snapshot, b: Snapshot): boolean =>
	JSON.stringify(a.steps) === JSON.stringify(b.steps);

/** The durable request as a decision reads it. */
export type Request = {
	state: ApprovalState;
	step: number;
	requestor: string;
	route: Snapshot;
};

/** A member's own team (`teams[0]`): eligibility never walks the team tree; static identities have none. */
const member = (a: EngineActor) =>
	a.kind === 'member' ? { id: a.id, team: a.teams[0] } : undefined;
/** Rule 46: an approver of the current step: a member of one of its teams, or one of its users. */
export const canApprove = (r: Request, a: EngineActor): boolean => {
	const step = r.route.steps[r.step],
		m = member(a);
	return (
		step !== undefined &&
		m !== undefined &&
		((m.team !== undefined && step.teams.includes(m.team)) || step.users.includes(m.id))
	);
};
/** An administrator or a member of a `supersededBy` team decides in any step's place. */
export const canSupersede = (r: Request, auth: Authority): boolean => {
	const team = member(auth.actor)?.team;
	return (
		auth.actor.kind === 'member' &&
		(auth.admin || (team !== undefined && r.route.superseded_by.includes(team)))
	);
};
/** The caller's roles on a request (machine.ts): the current step's approver, the requester, a superseder. */
export const rolesOf = (r: Request, auth: Authority): ReadonlySet<ApprovalRole> =>
	new Set<ApprovalRole>([
		...(canApprove(r, auth.actor) ? (['approver'] as const) : []),
		...(r.requestor === actorRef(auth.actor) ? (['requester'] as const) : []),
		...(canSupersede(r, auth) ? (['superseder'] as const) : [])
	]);
/** Who participates in an open request: requestor, current approver, superseder. */
export const participant = (r: Request, auth: Authority): boolean =>
	OPEN.includes(r.state) && rolesOf(r, auth).size > 0;
