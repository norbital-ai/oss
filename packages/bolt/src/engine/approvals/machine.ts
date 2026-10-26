// The approval state machine (rules 44–46, spec §8): the one table the engine enforces and the approval view's buttons
// read. A routed write is committed at once (provisional); the request decides whether that change stands or rolls back.

export type ApprovalState = 'Pending' | 'ChangesRequested' | 'Approved' | 'Rejected' | 'Superseded';
/** `resubmit` is the engine's own move: the requester's save in ChangesRequested takes it (approvals.ts `resubmit`). */
export type ApprovalMove = 'approve' | 'reject' | 'requestChanges' | 'resubmit' | 'supersede';
/**
 * Who takes a move: the current step's approver (its teams or users), the requester, a superseder (an administrator or a
 * `supersededBy` team).
 */
export type ApprovalRole = 'approver' | 'requester' | 'superseder';
type Edge = {
	readonly by: readonly ApprovalRole[];
	/** `next`: the following step, or `Approved` after the last one; `resubmit` lands on the step its caller names. */
	readonly to: ApprovalState | 'next';
	readonly reason: 'required' | 'optional';
	/** The provisional change is rolled back to the request's checkpoint. */
	readonly rollback?: true;
};
const DECIDERS: readonly ApprovalRole[] = ['approver', 'superseder'];
const reject: Edge = { by: DECIDERS, to: 'Rejected', reason: 'required', rollback: true };

export const MACHINE: { readonly [S in ApprovalState]: { readonly [M in ApprovalMove]?: Edge } } = {
	Pending: {
		approve: { by: ['approver'], to: 'next', reason: 'optional' },
		reject,
		requestChanges: { by: DECIDERS, to: 'ChangesRequested', reason: 'required' },
		supersede: { by: ['superseder'], to: 'Superseded', reason: 'required' }
	},
	ChangesRequested: {
		resubmit: { by: ['requester'], to: 'Pending', reason: 'optional' },
		reject
	},
	Approved: {},
	Rejected: {},
	Superseded: {}
};
/** Pending and ChangesRequested hold the record's lock; every other state is terminal. */
export const OPEN: readonly ApprovalState[] = ['Pending', 'ChangesRequested'];

/** What a person decides (`bolt.approvals.decide`): the approve button is a superseder's supersede. */
export type ApprovalDecision = 'approve' | 'reject' | 'requestChanges';
/** The move `decision` takes for `roles`: an approver approves, a superseder who is not one supersedes. */
export const moveOf = (
	decision: ApprovalDecision,
	roles: ReadonlySet<ApprovalRole>
): ApprovalMove =>
	decision === 'approve' && !roles.has('approver') && roles.has('superseder')
		? 'supersede'
		: decision;
/** The decisions `roles` may take from `state`, with their reason requirement: the approval view's buttons. */
export const decisionsFor = (state: ApprovalState, roles: ReadonlySet<ApprovalRole>) =>
	(['approve', 'reject', 'requestChanges'] as const).flatMap((decision) => {
		const edge = MACHINE[state][moveOf(decision, roles)];
		return edge !== undefined && edge.by.some((role) => roles.has(role))
			? [{ decision, reason: edge.reason }]
			: [];
	});

export type Step = { state: ApprovalState; step: number };
/** The edge `move` takes from `at` (`resubmit` to step `to`), or why it is refused. */
export function transition(
	at: Step,
	steps: number,
	move: ApprovalMove,
	roles: ReadonlySet<ApprovalRole>,
	reason: string,
	to = 0
):
	| { next: Step; edge: Edge }
	| { refused: 'invalidMove' | 'forbidden' | 'reason'; message: string } {
	const edge = MACHINE[at.state][move];
	if (edge === undefined)
		return {
			refused: 'invalidMove',
			message: OPEN.includes(at.state)
				? `A request in ${at.state} cannot ${move}.`
				: `This request is ${at.state}; it no longer changes.`
		};
	if (!edge.by.some((role) => roles.has(role)))
		return { refused: 'forbidden', message: `Only the ${edge.by.join(' or ')} may ${move}.` };
	if (edge.reason === 'required' && reason === '')
		return { refused: 'reason', message: 'This decision needs a reason.' };
	const next: Step =
		edge.to === 'next'
			? at.step + 1 < steps
				? { state: 'Pending', step: at.step + 1 }
				: { state: 'Approved', step: at.step }
			: move === 'resubmit'
				? { state: 'Pending', step: to }
				: { state: edge.to, step: at.step };
	return { next, edge };
}
