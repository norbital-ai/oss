import type { PolicyDeclaration, WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { approvalSteps } from '../runtime/identity/approver-teams.js';

/**
 * What a build refuses to ship, checked where the whole release is in hand at once.
 *
 * Two families of defect live here, and they share a failure mode: silence. An approval nobody can
 * decide simply never gets decided; a policy composition that widens a narrowed grant simply returns
 * more rows than the author meant. Neither throws, and both read from every surface as "nothing has
 * happened yet", which is also what working looks like before somebody acts. The release has every
 * declaration in one place, so it can refuse rather than let a workspace discover this at the first
 * approval it raises or the first row it should not have returned.
 *
 * **What is deliberately not here: whether an approver can see the record.** An earlier draft checked
 * that each approver team held a `read` grant on the guarded collection, and it was wrong in both
 * directions. It cannot decide a `where` — those are `$sql` predicates evaluated per request against
 * rows that do not exist at build time — so it would pass a team whose grant excludes every row it
 * will ever be asked about. And `rowPredicate` *unions* matching grants, so any static answer is
 * optimistic by construction. Visibility is granted at runtime instead, by the approval itself: being
 * asked to approve a record is what entitles somebody to read it.
 *
 * **What used to be here and is now a type.** This module carried the note that `+teams.ts` need not
 * declare an approver, because `reconcileApproverTeams` creates a `bolt_team` row for every approver
 * name a release declares and `Approvals.decide` matches by name rather than by policy. That reading
 * lost: `approvers` is typed as `TeamName`, a union generated from `+teams.ts`'s own keys, so a
 * misspelling is a compile error rather than an approval nobody can decide. The shape it protected —
 * an approver who reviews without otherwise being able to act — is still expressible, and is now
 * *visible*: declare the team in `+teams.ts` holding an empty policy array. Reconciliation still
 * mints the row; what changed is that the name is somewhere a reviewer can find it.
 */
export type ApprovalDiagnostic = Readonly<{
	/** Which rule refused, so a suppression or a test can name one without matching prose. */
	readonly rule:
		| 'empty-approvers'
		| 'undeclared-team-policy'
		| 'unresolvable-approver'
		| 'composition-widens-grant';
	readonly message: string;
}>;

/** `approvers` entries and `bolt_team.name` are compared folded everywhere else, so they are here. */
const fold = (value: string): string => value.trim().toLocaleLowerCase();

/** Names a step so a diagnostic points at a file and a grant rather than at an index. */
const stepLabel = (step: {
	readonly policy: string;
	readonly collection: string;
	readonly action: string;
	readonly index: number;
}): string => `${step.policy} (${step.action} on ${step.collection}, step ${step.index + 1})`;

/**
 * Whether this grant applies to every row in its collection.
 *
 * A grant with no `where` — or with an empty one — is unconditional. That is what makes it dangerous
 * beside a narrowed sibling: `rowPredicate` ORs the `where` of every matching grant, so `true OR
 * (assignee = me)` is `true` and the narrowing evaporates.
 */
const isUnconditional = (grant: { readonly where?: Readonly<Record<string, unknown>> }): boolean =>
	grant.where === undefined || Object.keys(grant.where).length === 0;

/**
 * Everything that names an array of policies, and is therefore a place composition can happen.
 *
 * One rule generates the whole model — *a holder names an array of policies; a subject's authority
 * is the union of what its holders name* — so the check that makes arrays safe has to run over every
 * kind of holder rather than over teams alone. A team was the only one before envoys and automations
 * named policies directly, which is why the hazard was documented in one template's `+teams.ts` and
 * nowhere else.
 */
type Holder = Readonly<{
	/** How to name it in a diagnostic: `team "Contractor (Controller)"`, `envoy "sales_desk"`. */
	readonly label: string;
	readonly policies: ReadonlyArray<string>;
}>;

const holdersOf = (definition: WorkspaceDefinition): ReadonlyArray<Holder> => [
	...Object.entries(definition.teams ?? {}).map(([name, policies]) => ({
		label: `team "${name}"`,
		policies
	})),
	...definition.envoys.map((envoy) => ({
		label: `envoy "${envoy.name}"`,
		policies: envoy.policies
	})),
	...definition.automations.map((automation) => ({
		label: `automation "${automation.name}"`,
		policies: automation.policies ?? []
	}))
];

export const approvalDiagnostics = (
	definition: WorkspaceDefinition
): ReadonlyArray<ApprovalDiagnostic> => {
	const diagnostics: Array<ApprovalDiagnostic> = [];
	const teams = definition.teams ?? {};
	const steps = approvalSteps(definition);

	/**
	 * A step nobody can decide, which no spelling check would catch.
	 *
	 * `ApprovalConfiguration` accepts `approvers: []`, and `Approvals.decide` then evaluates
	 * `step.approvers.some(...)` to false for every subject alive. Unlike a misspelled team there is
	 * nothing here to correct and no row to create — activation would mint a team for a typo, but it
	 * cannot mint one for a name that was never written. The step is simply unreachable, and the
	 * record it guards stays locked for the life of the release.
	 */
	for (const step of steps) {
		const named = step.approvers.filter((approver) => approver.trim() !== '');
		if (named.length > 0) continue;
		diagnostics.push({
			rule: 'empty-approvers',
			message: `${stepLabel(step)} names no approvers, so no subject can ever decide it and the record it guards stays locked. Name at least one team.`
		});
	}

	/**
	 * An approver naming a team `+teams.ts` does not declare.
	 *
	 * The type already refuses this — `approvers` is `TeamName` — so reaching it means the
	 * declaration was assembled some other way: a workspace that has not been synced, a definition
	 * built in a test, an artifact from an older release. The build still refuses, because the
	 * consequence is the same either way and it is the consequence that matters: an approval waiting
	 * on a team nobody is in, silently and forever.
	 *
	 * An approver team that grants nothing is declared with an empty array, not omitted.
	 */
	const declaredTeams = new Set(Object.keys(teams).map(fold));
	for (const step of steps) {
		for (const approver of step.approvers) {
			if (approver.trim() === '' || declaredTeams.has(fold(approver))) continue;
			diagnostics.push({
				rule: 'unresolvable-approver',
				message: `${stepLabel(step)} names the approver "${approver}", which +teams.ts does not declare. Add it there — an approver that grants nothing is declared as "${approver}": [].`
			});
		}
	}

	/**
	 * A team holding a policy that no file declares.
	 *
	 * Already detected, at the wrong time and in the wrong tone: `policiesHeld` emits a
	 * `console.warn` per unresolved name, deduplicated in a module-level `Set`, on the authorization
	 * path, in production, where nobody reads it. Dropping the name there is right — a workspace must
	 * not fall over because a rename left a string pointing at nothing — but *shipping* it is not,
	 * and this is pure name resolution over two artifacts the compiler already holds.
	 *
	 * It runs over every kind of holder now, because an envoy and an automation name policies the
	 * same way a team does, and a stale name on a public envoy is worse than a stale name on a team:
	 * the envoy goes on answering strangers with less authority than the release says it has.
	 */
	const declaredPolicies = new Map(
		definition.policies.map((policy) => [fold(policy.name), policy] as const)
	);
	for (const holder of holdersOf(definition)) {
		for (const policy of holder.policies) {
			if (declaredPolicies.has(fold(policy))) continue;
			diagnostics.push({
				rule: 'undeclared-team-policy',
				message: `${holder.label} names the policy "${policy}", which no policy file declares. The name is dropped at runtime, so it silently holds less than the declaration says.`
			});
		}
	}

	/**
	 * **The check that makes an array of policies safe, and the reason arrays are permitted at all.**
	 *
	 * `rowPredicate` unions the `where` of every matching grant, so an unconditional grant sitting
	 * beside a narrowed one on the same `(collection, action)` collapses the predicate to `true`. The
	 * holder does not get "their own jobs plus dispatch" — they get everything, and the self-scoping
	 * evaporates with nothing to say so. `Contractor (Controller)` in field-operations is exactly
	 * that shape, and two seeded people were unscoped because of it.
	 *
	 * It is a property of `rowPredicate` rather than of how many policies a holder may name — a
	 * single policy can carry an unconditional grant beside a narrowed one by itself — so the fix is
	 * a check rather than an arity limit. Which is what makes envoys and automations able to name
	 * arrays: without this, shipping arrays would spread the hazard from teams to every public
	 * surface, where the holder of the widened grant is a stranger with a phone.
	 *
	 * Decidable from the declarations alone, with no runtime state, because "is there a `where`" is a
	 * syntactic question. Deliberate composition stays possible and stays visible: the author writes
	 * one policy carrying the union they intend, or drops the narrowing. Either way the widening is
	 * something a person typed.
	 */
	for (const holder of holdersOf(definition)) {
		const held = holder.policies
			.map((name) => declaredPolicies.get(fold(name)))
			.filter((policy): policy is PolicyDeclaration => policy !== undefined);
		if (held.length < 2) continue;
		/** Every `(collection, action)` this holder reaches, with which policy said what about it. */
		const byResource = new Map<
			string,
			{ readonly unconditional: Array<string>; readonly narrowed: Array<string> }
		>();
		for (const policy of held) {
			for (const grant of policy.grants ?? []) {
				const key = `${grant.action} on ${grant.collection}`;
				const entry = byResource.get(key) ?? { unconditional: [], narrowed: [] };
				(isUnconditional(grant) ? entry.unconditional : entry.narrowed).push(policy.name);
				byResource.set(key, entry);
			}
		}
		for (const [resource, entry] of [...byResource].toSorted(([left], [right]) =>
			left.localeCompare(right)
		)) {
			if (entry.unconditional.length === 0 || entry.narrowed.length === 0) continue;
			const wide = [...new Set(entry.unconditional)].toSorted();
			const narrow = [...new Set(entry.narrowed)].toSorted();
			// A single policy carrying both is the author's own composition, stated in one file, and it
			// is refused for the same reason — but naming it as one policy rather than as a pair is what
			// makes the diagnostic actionable.
			if (wide.length === 1 && narrow.length === 1 && wide[0] === narrow[0]) {
				diagnostics.push({
					rule: 'composition-widens-grant',
					message: `Policy "${wide[0]}" grants ${resource} both unconditionally and with a where, and rowPredicate unions the two — so the narrowed grant does nothing and every row is reachable. Drop one of them.`
				});
				continue;
			}
			diagnostics.push({
				rule: 'composition-widens-grant',
				message: `${holder.label} holds ${narrow.map((name) => `"${name}"`).join(' and ')}, which narrow ${resource} with a where, alongside ${wide.map((name) => `"${name}"`).join(' and ')}, which grant it unconditionally. rowPredicate unions the where of every matching grant, so the predicate collapses to true and the narrowing is silently lost — this holder reaches every row of ${resource.split(' on ')[1] ?? resource}. Either give this holder one policy carrying the composition you intend, or drop the narrowing.`
			});
		}
	}

	return diagnostics;
};

/**
 * The diagnostics as one refusal, or nothing.
 *
 * Every rule here is a hard failure rather than a warning, for three reasons: each catches a total
 * failure, not a degradation — an approval nobody can decide, a holder holding nothing, or a
 * narrowing that silently inverted into a widening; there is no legitimate workspace shape that
 * trips one; and a warning printed among build output is a warning nobody reads, which is precisely
 * how the `console.warn` this replaces went unnoticed.
 */
export const approvalRefusal = (definition: WorkspaceDefinition): string | undefined => {
	const diagnostics = approvalDiagnostics(definition);
	if (diagnostics.length === 0) return undefined;
	return [
		`This workspace declares ${diagnostics.length} authority binding${diagnostics.length === 1 ? '' : 's'} that cannot resolve:`,
		...diagnostics.map(({ message }) => `  - ${message}`)
	].join('\n');
};
