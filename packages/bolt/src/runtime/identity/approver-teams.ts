import { Effect, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import * as Database from '#lib/runtime/facilities/database.js';

/**
 * The one field of an approval configuration that binds it to a team row.
 *
 * Deliberately narrower than the configuration `Approvals` decodes — no `id`, no `name`, no step
 * names. What is being read here is the *name of a team*, and a grant that carries a half-authored
 * configuration still names the teams it expects to exist; refusing to look at it because a sibling
 * field was missing would leave exactly the approval nobody can decide that this exists to prevent.
 */
const ApproverSteps = Schema.Struct({
	steps: Schema.Array(
		Schema.Struct({
			/** Present after `describePolicy`, derived from the author's `key`. Absent before it. */
			id: Schema.optionalKey(Schema.String),
			approvers: Schema.Array(Schema.NonEmptyString)
		})
	)
});

/**
 * Every team name the release's approval steps expect to exist, deduplicated case-insensitively.
 *
 * `step.approvers` and `team.name` are the same string — that is the whole binding, and it is
 * the reason a typo in one is invisible until somebody tries to decide an approval and finds that
 * nobody is eligible. Folding is how the rest of the runtime compares team names (`TEAM_LOOKUP_SQL`
 * resolves with `lower("name") = lower($1)`, `policiesHeld` folds both sides), so two steps
 * spelling one team differently ask for one row, not two.
 *
 * The *authored* spelling is what survives deduplication, because that is what an operator reading
 * the settings surface should see next to the code they wrote.
 */
type ApprovalStep = Readonly<{
	/** The policy the step was declared in, so a diagnostic can name the file to open. */
	readonly policy: string;
	/** The collection the guarded grant is on — what an approver is being asked to look at. */
	readonly collection: string;
	readonly action: string;
	/** Position within the grant's `steps`, which is what an operator sees in the approval UI. */
	readonly index: number;
	/**
	 * The step's derived id, `<policy>:<collection>:<action>:<key>`, when the policy has been
	 * described. Absent while the grant is still the raw authored shape.
	 *
	 * It is here so a diagnostic can name the step the way a log line and an approval row do, rather
	 * than by an index that means nothing outside the array it came from.
	 */
	readonly id?: string | undefined;
	readonly approvers: ReadonlyArray<string>;
}>;

/**
 * Every approval step a release declares, flattened.
 *
 * One walk with two readers. `declaredApproverTeams` reconciles `team` rows from it at
 * activation, and the compiler's `approval-checks` refuses a build from it — and those two were
 * always going to be asked to agree about what an approval step *is*. Written twice, a change to
 * the shape would have moved one and left the other reconciling rows for steps the build no longer
 * has, or refusing builds over steps activation ignores.
 */
export const approvalSteps = (definition: WorkspaceDefinition): ReadonlyArray<ApprovalStep> => {
	const steps: Array<ApprovalStep> = [];
	for (const policy of definition.policies) {
		for (const grant of policy.grants ?? []) {
			if (!Schema.is(ApproverSteps)(grant.approval)) continue;
			grant.approval.steps.forEach((step, index) => {
				steps.push({
					policy: policy.name,
					collection: grant.collection,
					action: grant.action,
					index,
					id: step.id,
					approvers: step.approvers
				});
			});
		}
	}
	return steps;
};

export const declaredApproverTeams = (definition: WorkspaceDefinition): ReadonlyArray<string> => {
	const byFoldedName = new Map<string, string>();
	for (const step of approvalSteps(definition)) {
		for (const approver of step.approvers) {
			const name = approver.trim();
			if (name === '') continue;
			const folded = name.toLocaleLowerCase();
			if (!byFoldedName.has(folded)) byFoldedName.set(folded, name);
		}
	}
	return [...byFoldedName.values()];
};

/**
 * Makes sure every team an approval step names exists, creating the missing ones empty.
 *
 * **It never refuses a release.** Its temperament is `policiesHeldByTeam`'s, and for the same
 * reason: the two sides are bound by a string and they move independently — the team is a row an
 * operator edits, the `approvers` entry ships with a release — so a mismatch is an ordinary state
 * and not a reason to take a workspace down. Each name is attempted on its own and a failure is
 * reported and stepped over, so one unwritable row cannot cost the other nine their teams, and the
 * error channel is `never` rather than something the caller has to remember to catch.
 *
 * An *empty* team is the correct thing to create. Membership is an operator's decision and there is
 * nobody this could sensibly put in one; what the empty row buys is that the name now resolves, the
 * team appears in `identity.workspaceAccess` — which lists teams from `team` rather than
 * deriving them from who is in one, precisely so this row is visible — and putting somebody in it
 * is a `teams.assign` away. Without the row there is nothing to see, nothing to fill, and an
 * approval that no subject in the workspace can ever be eligible for.
 *
 * `Effect.logWarning` rather than `console.warn`: this runs inside an activation, which has a
 * logger and a host reading its output. `policiesHeldByTeam` uses `console.warn` only because it is
 * a synchronous predicate on the authorization path with no Effect to log into.
 */
export const reconcileApproverTeams = Effect.fn('Bolt.reconcileApproverTeams')(function* (
	effectId: EffectId,
	definition: WorkspaceDefinition
) {
	const database = yield* Database.Service;
	const created: Array<string> = [];
	for (const name of declaredApproverTeams(definition)) {
		const inserted = yield* database
			.execute(EffectId.make(`${effectId}:approver-team:${name.toLocaleLowerCase()}`), {
				_tag: 'Query',
				// Guarded by a folded `not exists` rather than `on conflict`, because the unique index on
				// `name` is case-sensitive while every comparison of a team name in this runtime is
				// folded: `on conflict` would let `approvers: ['hr manager']` mint a second row beside
				// `HR Manager` and make which one an approval matched an accident of spelling.
				//
				// Created at the root, with no parent. A team the release conjured holds nothing on its own
				// and sits under nobody: descent is unconditional, so *where* a team is placed is the
				// whole of what it composes, and placing one is an operator's decision in `teams.update`
				// rather than something the reconciler makes on their behalf.
				sql: `insert into "team" ("id", "name")
				      select gen_random_uuid(), $1::text
				       where not exists (select 1 from "team" where lower("name") = lower($1::text))
				   returning "name"`,
				parameters: [name]
			})
			.pipe(
				Effect.catch((failure) =>
					Effect.logWarning(
						`activation: could not reconcile the team "${name}" that an approval step names: ${failure.message}. ` +
							`Approvals routed to it cannot be decided until the team exists.`
					).pipe(Effect.as(undefined))
				)
			);
		if (inserted !== undefined && inserted.rows[0] !== undefined) {
			created.push(name);
			// Loud, and at the one moment somebody is watching: a deploy. A team that appeared out of
			// nowhere is worth a line, and so is the reverse reading — a name here that nobody expected
			// is a typo in `approvers` showing itself before it strands an approval.
			yield* Effect.logInfo(
				`activation: created empty team "${name}", named by an approval step and absent from "team"`
			);
		}
	}
	return created;
});
