// repository-health:allow SEM_PARALLEL -- siblings of one identity module sharing its vocabulary; distinct responsibilities (static stub vs live subject).
import type * as Identity from '#lib/runtime/identity/identity.js';

/**
 * The static identities this runtime mints, and the one rule they all obey.
 *
 * A static identity is declared in source, compiled into the release, and minted **in memory per
 * invocation**. It never has a `user` row. The set of them changes only by deploying a
 * different release — declare a fifth envoy and there is a fifth identity, arriving by deploying
 * rather than by anything being inserted.
 *
 * That replaces a reconciler that wrote a service row into the same table people are in, placed it
 * in a team chosen from the declaration, and gave it an undeliverable `@channels.invalid` address so
 * the lookup by email would find it. Everything about that arrangement was plumbing in service of
 * one fact — which policies apply — and the fact is in the declaration, so the plumbing is gone.
 *
 * **A static identity holds no team.** `teamPath` is empty, so it inherits nothing from `+teams.ts`
 * and, because `approvals.decide` matches a step's approvers against the subject's team, **it can
 * approve nothing.** It can cause work that requires approval and can never be the one who grants
 * it. That is not a limitation to work around; it is the property that makes a public surface safe.
 */

/** The `subject_id` an envoy's rows and audit lines carry. Rendered into a label from the manifest. */
export const envoyPrincipalId = (envoyName: string): string => `envoy:${envoyName}`;
/** The `subject_id` an automation's rows and audit lines carry. */
export const automationPrincipalId = (automationName: string): string =>
	`automation:${automationName}`;

/**
 * The subject one envoy turn runs as, given the envoy's declaration and whoever the sender turned
 * out to be.
 *
 * This is the whole of the rule, in one place, because it is the rule that must not be got wrong:
 *
 * - **Capability is the declaration's, always.** `policies` is copied from the envoy whether or not
 *   a sender was matched, and `teamPath` stays empty. That is what makes the declared policies the
 *   ceiling for everybody — a linked contractor who administers the web app reaches exactly what an
 *   anonymous sender reaches, no more.
 * - **Identity is the sender's, and only narrows.** `userId` becomes the matched account's, so a
 *   grant carrying `subject.id` resolves to that person and returns *their* rows where
 *   the bare principal would match none. A narrowing, never a widening.
 * - **`admin` is dropped.** Administrative status selects narrow built-in controls that do not
 *   belong to an envoy turn. Carrying it across would widen the declared envoy principal even
 *   though tenant data still requires an explicit policy.
 *
 * Extracted rather than left inline in `receive` so it can be asserted on directly. An invariant
 * that can only be tested by running an agent turn is an invariant that gets tested once.
 */
export const envoySubject = (
	envoy: { readonly name: string; readonly policies: ReadonlyArray<string> },
	tenantId: string,
	linked: Readonly<{ readonly userId: string; readonly email?: string }> | undefined
): Identity.Subject => {
	const subject = {
		userId: linked?.userId ?? envoyPrincipalId(envoy.name),
		tenantId,
		teamPath: [],
		policies: [...envoy.policies],
		admin: false
	};
	return linked?.email === undefined ? subject : { ...subject, email: linked.email };
};

/**
 * The subject one automation run acts under.
 *
 * An automation's authority is a property of the automation, not of whoever tripped it. It used to
 * inherit the caller's subject, so the same automation ran with different authority depending on
 * who that was — and when an administrator tripped it, it ran as an administrator, on a schedule,
 * against every row in the workspace.
 */
export const automationSubject = (
	automation: { readonly name: string; readonly policies: ReadonlyArray<string> },
	tenantId: string
): Identity.Subject => ({
	userId: automationPrincipalId(automation.name),
	tenantId,
	teamPath: [],
	policies: [...automation.policies],
	admin: false
});

/**
 * The seeder, which exists only to be a name in a history row.
 *
 * It holds no policy and grants nothing: `seed-from-bank` writes rows over the host's own connection
 * to a database it just created and never crosses the authorization boundary. What it needs is an
 * attributable `subject_id`, because a seeded record with no creation event has no creator to show —
 * which is why the client renders nothing at all for seeded data today.
 */
export const SEED_PRINCIPAL_ID = 'colony-seed';

export const seedSubject = (tenantId: string): Identity.Subject => ({
	userId: SEED_PRINCIPAL_ID,
	tenantId,
	teamPath: [],
	policies: [],
	admin: false
});
