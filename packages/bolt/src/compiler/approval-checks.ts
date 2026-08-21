import type { WorkspaceDefinition } from '../authoring/workspace-schema.js';
import { approvalSteps } from '../runtime/identity/approver-teams.js';

/**
 * What a build refuses to ship, checked where the whole release is in hand at once.
 *
 * An approval binds authored artifacts by *name*: a grant's `approval.steps[].approvers` names a
 * team, `+teams.ts` maps team names to policy names, and a policy file declares one. Nothing in the
 * type system holds them together — they are strings in separate files.
 *
 * The failure mode they share is silence. Neither defect below throws: a step nobody can decide
 * simply never gets decided, and a team holding a policy that does not exist simply holds less than
 * its file says. Both read from every surface as "nothing has happened yet", which is also what
 * working looks like before somebody acts. The release has every declaration in one place, so it can
 * refuse rather than let a workspace discover this at the first approval it raises.
 *
 * **What is deliberately not here, first: whether `+teams.ts` declares the approver.** It reads like
 * the obvious rule and it is wrong. `reconcileApproverTeams` creates a `bolt_team` row for every
 * approver name a release declares, precisely so a name that has no row gets one — and
 * `Approvals.decide` matches `subject.team` against `step.approvers` by **name**, never by policy.
 * So a team absent from `+teams.ts` holds no policies and can still decide, which is a real and
 * supported shape: an approver who reviews without otherwise being able to act. Refusing it would
 * have made the reconciler's whole purpose unreachable, and its own tests said so.
 *
 * **What is deliberately not here, second: whether an approver can see the record.** An earlier draft
 * checked that each approver team held a `read` grant on the guarded collection, and it was wrong in
 * both directions. It cannot decide a `where` — those are `$sql` predicates evaluated per request
 * against rows that do not exist at build time — so it would pass a team whose grant excludes every
 * row it will ever be asked about. And `rowPredicate` *unions* matching grants, so any static answer
 * is optimistic by construction. Visibility is granted at runtime instead, by the approval itself:
 * being asked to approve a record is what entitles somebody to read it. A build gate that implied
 * otherwise would be answering a question it cannot ask.
 */
export type ApprovalDiagnostic = Readonly<{
	/** Which rule refused, so a suppression or a test can name one without matching prose. */
	readonly rule: 'empty-approvers' | 'undeclared-team-policy';
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
	 * A team holding a policy that no file declares.
	 *
	 * Already detected, at the wrong time and in the wrong tone: `policiesHeldByTeam` emits a
	 * `console.warn` per unresolved name, deduplicated in a module-level `Set`, on the authorization
	 * path, in production, where nobody reads it. Dropping the name there is right — a workspace must
	 * not fall over because a rename left a string pointing at nothing — but *shipping* it is not,
	 * and this is pure name resolution over two artifacts the compiler already holds.
	 */
	const declaredPolicies = new Set(definition.policies.map((policy) => fold(policy.name)));
	for (const [team, held] of Object.entries(teams)) {
		for (const policy of held) {
			if (declaredPolicies.has(fold(policy))) continue;
			diagnostics.push({
				rule: 'undeclared-team-policy',
				message: `+teams.ts gives "${team}" the policy "${policy}", which no policy file declares. The name is dropped at runtime, so members of that team silently hold less than the file says.`
			});
		}
	}

	return diagnostics;
};

/**
 * The diagnostics as one refusal, or nothing.
 *
 * Every rule here is a hard failure rather than a warning, for three reasons: each catches a total
 * failure, not a degradation — an approval nobody can decide, or a team holding nothing; there is no
 * legitimate workspace shape that trips one; and a warning printed among build output is a warning
 * nobody reads, which is precisely how the `console.warn` this replaces went unnoticed.
 */
export const approvalRefusal = (definition: WorkspaceDefinition): string | undefined => {
	const diagnostics = approvalDiagnostics(definition);
	if (diagnostics.length === 0) return undefined;
	return [
		`This workspace declares ${diagnostics.length} approval binding${diagnostics.length === 1 ? '' : 's'} that cannot resolve:`,
		...diagnostics.map(({ message }) => `  - ${message}`)
	].join('\n');
};
