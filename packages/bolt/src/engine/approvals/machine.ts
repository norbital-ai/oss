// The approval state machine (rules 44–46): the one table the engine enforces and the approval view's buttons read.
// A routed write is committed at once (provisional); the request decides whether that change stands or rolls back.

export type ApprovalState =
	'Pending' | 'ChangesRequested' | 'Approved' | 'Rejected' | 'Withdrawn' | 'Superseded';
export type ApprovalMove =
	| 'approve'
	| 'reject'
	| 'requestChanges'
	| 'resubmit'
	| 'withdraw'
	| 'supersede'
	| 'comment'
	| 'close';
/**
 * Who takes a move: the current step's approver, the requester, a superseder (an administrator or a `superseded_by`
 * team), an administrator.
 */
export type ApprovalRole = 'approver' | 'requester' | 'superseder' | 'administrator';
type Edge = {
	readonly by: readonly ApprovalRole[];
	/** `next`: the following step, or `Approved` after the last one. */
	readonly to: ApprovalState | 'next';
	readonly reason: 'required' | 'optional';
	/** The provisional change is rolled back to the request's checkpoint. */
	readonly rollback?: true;
	/**
	 * The only move once a release removed the request's collection or record: every other move is refused then, and
	 * this one is refused while the source still exists.
	 */
	readonly sourceGone?: true;
};
const ANYONE: readonly ApprovalRole[] = ['approver', 'requester', 'superseder'];
const close: Edge = {
	by: ['administrator'],
	to: 'Withdrawn',
	reason: 'optional',
	rollback: true,
	sourceGone: true
};

export const MACHINE: { readonly [S in ApprovalState]: { readonly [M in ApprovalMove]?: Edge } } = {
	Pending: {
		approve: { by: ['approver'], to: 'next', reason: 'optional' },
		reject: { by: ['approver'], to: 'Rejected', reason: 'optional', rollback: true },
		requestChanges: { by: ['approver'], to: 'ChangesRequested', reason: 'required' },
		withdraw: { by: ['requester'], to: 'Withdrawn', reason: 'optional', rollback: true },
		supersede: { by: ['superseder'], to: 'Superseded', reason: 'required' },
		comment: { by: ANYONE, to: 'Pending', reason: 'required' },
		close
	},
	ChangesRequested: {
		resubmit: { by: ['requester'], to: 'Pending', reason: 'optional' },
		reject: { by: ['approver'], to: 'Rejected', reason: 'optional', rollback: true },
		withdraw: { by: ['requester'], to: 'Withdrawn', reason: 'optional', rollback: true },
		comment: { by: ANYONE, to: 'ChangesRequested', reason: 'required' },
		close
	},
	Approved: {},
	Rejected: {},
	Withdrawn: {},
	Superseded: {}
};
/** Pending and ChangesRequested hold the record's lock; every other state is terminal. */
export const OPEN: readonly ApprovalState[] = ['Pending', 'ChangesRequested'];
/** The reason a `close` records when none is given. */
export const SOURCE_CHANGED = 'source changed';

const MOVES: readonly ApprovalMove[] = [
	'approve',
	'reject',
	'requestChanges',
	'resubmit',
	'withdraw',
	'supersede',
	'comment',
	'close'
];
const allowed = (edge: Edge | undefined, roles: ReadonlySet<ApprovalRole>, sourceGone: boolean) =>
	edge !== undefined &&
	(edge.sourceGone === true) === sourceGone &&
	edge.by.some((role) => roles.has(role));
/** The moves `roles` may take from `state`, with their reason requirement: the approval view's buttons. */
export const movesFor = (
	state: ApprovalState,
	roles: ReadonlySet<ApprovalRole>,
	sourceGone = false
) =>
	MOVES.flatMap((move) => {
		const edge = MACHINE[state][move];
		return edge !== undefined && allowed(edge, roles, sourceGone)
			? [{ move, reason: edge.reason }]
			: [];
	});

export type Step = { state: ApprovalState; step: number };
/** The edge `move` takes from `at`, or why it is refused. */
export function transition(
	at: Step,
	steps: number,
	move: ApprovalMove,
	roles: ReadonlySet<ApprovalRole>,
	reason: string,
	sourceGone = false
):
	| { next: Step; edge: Edge }
	| { refused: 'invalidMove' | 'forbidden' | 'reason' | 'sourceChanged'; message: string } {
	const edge = MACHINE[at.state][move];
	if (edge === undefined)
		return {
			refused: 'invalidMove',
			message: OPEN.includes(at.state)
				? `A request in ${at.state} cannot ${move}.`
				: `This request is ${at.state}; it no longer changes.`
		};
	if ((edge.sourceGone === true) !== sourceGone)
		return {
			refused: 'sourceChanged',
			message: sourceGone
				? 'The collection changed: its record is no longer declared; an administrator closes this request.'
				: 'This request is closed only once a release removed its collection or record.'
		};
	if (!edge.by.some((role) => roles.has(role)))
		return { refused: 'forbidden', message: `Only the ${edge.by.join(' or ')} may ${move}.` };
	if (edge.reason === 'required' && reason === '')
		return {
			refused: 'reason',
			message: `${move === 'comment' ? 'A comment' : 'This decision'} needs a reason.`
		};
	const next: Step =
		edge.to === 'next'
			? at.step + 1 < steps
				? { state: 'Pending', step: at.step + 1 }
				: { state: 'Approved', step: at.step }
			: move === 'resubmit'
				? { state: 'Pending', step: 0 }
				: { state: edge.to, step: at.step };
	return { next, edge };
}
