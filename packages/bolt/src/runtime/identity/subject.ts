/**
 * The authenticated-subject contract: the schema every identity flow mints, the Effect context key
 * the invocation boundary provides it under, and the accessor facilities read it through.
 *
 * Identity owns the runtime service that answers subjects; the subject *shape* is the contract all
 * of them share, so it lives here rather than in a file the database facility would have to import.
 */
import { Context, Effect, Schema } from 'effect';

export const Subject = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	/**
	 * The team names whose declared policies this subject holds: its own team first, then the teams
	 * beneath it in the hierarchy.
	 *
	 * Names, not policies. The mapping from a team name to the policies it holds is authored — it
	 * lives in the compiled release, not in a row — so only `AccessControl` resolves it, and identity
	 * stays ignorant of what any policy grants.
	 *
	 * The subject's own team is `teamPath[0]`, and there is deliberately no second field carrying it.
	 * There used to be: the SQL computed `team` as `tree.depth = 1` and `teamPath` as the same tree
	 * ordered by depth, so the two could never disagree — but two fields carrying one fact are two
	 * places to read it from, and `approvals.decide` and `AccessControl` read different ones.
	 */
	teamPath: Schema.Array(Schema.NonEmptyString),
	/**
	 * The policies this subject holds directly, named by a declaration rather than through a team.
	 *
	 * Empty for a person: a person belongs to one team, and the team names what it holds. Non-empty
	 * for a static identity — an envoy, an automation — which has no team at all and carries the
	 * policies its declaration named.
	 *
	 * It is a `MINTED_IDENTITY` field, refused when it arrives in a payload exactly as `system` is,
	 * and no database column produces it. That is what makes "the sender cannot widen it" a
	 * structural fact rather than a review comment: there is no string a sender can send that adds a
	 * policy, and no row that confers one.
	 */
	policies: Schema.Array(Schema.NonEmptyString),
	/**
	 * Whether this is the host acting under a verified gateway signature rather than a person.
	 *
	 * Minted by `SystemPrincipal.systemSubject` and by nothing else. It is a `MINTED_IDENTITY` field,
	 * so a payload claiming it is refused rather than honoured, and no database column produces it.
	 */
	system: Schema.optionalKey(Schema.Boolean),
	email: Schema.optionalKey(Schema.NonEmptyString),
	/**
	 * Whether this subject administers the workspace, from `user.status`.
	 *
	 * Optional, and absent means `normal`. That polarity is the whole point: every construction of a
	 * subject that predates this field — an external subject, a test fixture, a machine invocation —
	 * reads as an ordinary user rather than as an administrator, so the failure mode of forgetting to
	 * set it is a refusal rather than a grant.
	 */
	admin: Schema.optionalKey(Schema.Boolean),
	impersonatedBy: Schema.optionalKey(Schema.NonEmptyString)
});
export interface Subject extends Schema.Schema.Type<typeof Subject> {}

/**
 * The context key the invocation boundary provides the authenticated subject under, when one is
 * present.
 *
 * Absent for invocations that have no person behind them — scheduled tasks, activations, the health
 * probe. A facility that needs one must refuse those rather than invent a default.
 */
export const CurrentSubject = Context.Service<Subject>('@norbital-ai/bolt/CurrentSubject');

/** The authenticated subject, or `None` for machine-run work. */
export const currentSubject = Effect.serviceOption(CurrentSubject);
