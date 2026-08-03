import type {
	ManifestPolicyApproval,
	ManifestPolicyApprovalStep,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';

/**
 * The narrowest client this needs.
 *
 * Reconciliation runs from two places — `pod migrate`, which holds a raw pg client inside the
 * migration transaction, and a host provisioning a tenant — so it takes a query function rather than a
 * workspace context. Anything wider would tie it to whichever caller happened to come first.
 */
export type PolicyReconcileClient = {
	query(
		text: string,
		values: readonly unknown[]
	): Promise<{ rows: readonly Record<string, unknown>[] }>;
};

/** One approver reference that had no team to point at, named where it was written. */
export type UnresolvedApproverTeam = {
	readonly policy: string;
	readonly collection: string;
	readonly action: string;
	readonly team: string;
};

export type PolicyReconcileResult = {
	readonly created: number;
	readonly updated: number;
	/**
	 * Approver team names left unresolved because the tenant has no teams yet.
	 *
	 * Empty on a tenant that has been seeded. Non-empty means the gates listed are stored but not yet
	 * actionable — see {@link resolveApproverTeams}.
	 */
	readonly unresolvedApproverTeams: readonly UnresolvedApproverTeam[];
};

/**
 * Bring `policy` rows into line with the policies the workspace declares.
 *
 * Declared policies are the authority: a workspace shipping `src/policies/+field_agent.policy.ts` has
 * that policy on a database nobody seeded, which is what makes `pod start` usable and what makes a
 * permission change reviewable in a diff instead of a row somebody has to remember to apply.
 *
 * Three rules, each load-bearing:
 *
 * - Matched by `key`, not by id, so a policy keeps its identity across deploys and every
 *   `team.policy_id` pointing at it stays valid. Delete-and-recreate would unassign every team.
 * - Undeclared rows are left alone rather than deleted. A workspace can hold policies created through
 *   the tenant configuration surface, and reconciliation is not a mandate to own every row — removing
 *   one would revoke access nobody asked to revoke.
 * - `is_active` is never overwritten on an existing row. Deactivating a policy is an operational act,
 *   and a deploy must not silently re-enable one somebody switched off.
 */
/**
 * Refuse a condition that will not survive storage, at the last moment before it is stored.
 *
 * A callback in a `where` is dropped by serialisation, and the grant then lands with `conditions: {}`
 * — which the permission guard reads as *unconditional access to the whole collection*. A narrowing
 * that silently inverts into a widening is the worst failure a permission rule has, so it is refused
 * here as well as in the type.
 *
 * Belt and braces on purpose. The type stops it being written; this stops it being stored, including
 * when a manifest arrives from somewhere the compiler never saw.
 */
function assertStorableCondition(
	policyKey: string,
	collection: string,
	where: unknown,
	path = 'where'
): void {
	if (where == null || typeof where !== 'object') return;
	for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
		const here = `${path}.${key}`;
		if (typeof value === 'function') {
			throw new Error(
				`Policy "${policyKey}" grant on "${collection}" has a function at ${here}. It cannot be ` +
					'stored, so the grant would reconcile as unconditional. Use `$sql` instead of `RAW`.'
			);
		}
		if (Array.isArray(value)) {
			value.forEach((entry, index) =>
				assertStorableCondition(policyKey, collection, entry, `${here}[${index}]`)
			);
			continue;
		}
		assertStorableCondition(policyKey, collection, value, here);
	}
}

function eachStep(
	steps: readonly ManifestPolicyApprovalStep[]
): readonly ManifestPolicyApprovalStep[] {
	return steps.flatMap((step) => [step, ...eachStep(step.steps ?? [])]);
}

/** Every team name a declared approval mentions, with the grant it was written on. */
function collectApproverTeams(manifest: NorbitalManifest): readonly UnresolvedApproverTeam[] {
	const found: UnresolvedApproverTeam[] = [];
	for (const policy of Object.values(manifest.policies ?? {})) {
		for (const grant of policy.grants) {
			if (!grant.approval) continue;
			const names = [
				...(grant.approval.supercededBy ?? []),
				...eachStep(grant.approval.steps).flatMap((step) => step.approvers)
			];
			for (const team of new Set(names)) {
				found.push({
					policy: policy.key,
					collection: grant.collection,
					action: grant.action,
					team
				});
			}
		}
	}
	return found;
}

/**
 * Bind every declared approver team name to the `team.norbital_id` it means, on this tenant.
 *
 * A team is a runtime row, so an approval cannot carry an id and reconciliation cannot assume the row
 * is there. Three outcomes, and the difference between them is the whole design:
 *
 * - **Resolved.** The name matched exactly one team. Normal case.
 * - **Missing, on a tenant that has teams.** Something is wrong with the declaration — a typo, or a
 *   team that was renamed out from under it. Thrown, naming the policy, the grant and the team,
 *   because the alternative is a gate that exists in source and not in the database.
 * - **Missing, on a tenant with no teams at all.** Not a mistake: `pod migrate` runs before anything
 *   seeds a team, and refusing to boot a fresh database because its teams do not exist yet would make
 *   `pod start` impossible. The reference is *deferred*, and reconciliation is idempotent, so the next
 *   run — which `pod seed` now performs immediately after seeding — binds it.
 *
 * Deferral never produces an ungated grant. `approval_config` stays on the grant, so the guard still
 * routes the mutation through approval; what it loses is approvers, so the request is raised and
 * nobody can act on it. That fails closed: a write is blocked, never silently applied. It is also
 * reported — returned from reconciliation and warned about here — because a permanently unactionable
 * gate is a real problem, just a smaller one than an unreviewed write.
 *
 * An ambiguous name is refused too. `team.name` carries no unique constraint, so two teams may share
 * one, and picking either would route approvals to a team chosen by row order.
 */
async function resolveApproverTeams(
	client: PolicyReconcileClient,
	references: readonly UnresolvedApproverTeam[]
): Promise<{
	readonly idByName: ReadonlyMap<string, string>;
	readonly unresolved: readonly UnresolvedApproverTeam[];
}> {
	const names = [...new Set(references.map((reference) => reference.team))];
	if (names.length === 0) return { idByName: new Map(), unresolved: [] };

	const rows = await client.query(`SELECT norbital_id::text AS id, name FROM team`, []);
	const idsByName = new Map<string, string[]>();
	for (const row of rows.rows) {
		const name = String(row.name);
		idsByName.set(name, [...(idsByName.get(name) ?? []), String(row.id)]);
	}

	const ambiguous = names.filter((name) => (idsByName.get(name)?.length ?? 0) > 1);
	if (ambiguous.length > 0) {
		const where = references
			.filter((reference) => ambiguous.includes(reference.team))
			.map(
				(reference) =>
					`policy "${reference.policy}", ${reference.action} on "${reference.collection}" → team "${reference.team}"`
			);
		throw new Error(
			`Approval names a team that is not unique: ${[...new Set(where)].join('; ')}. ` +
				'`team.name` has no unique constraint, so resolving it would pick an approver by row ' +
				'order. Rename the duplicate team, or remove it.'
		);
	}

	const idByName = new Map(
		names
			.map((name) => [name, idsByName.get(name)?.[0]] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== undefined)
	);
	const unresolved = references.filter((reference) => !idByName.has(reference.team));
	if (unresolved.length === 0) return { idByName, unresolved: [] };

	const where = unresolved.map(
		(reference) =>
			`policy "${reference.policy}", ${reference.action} on "${reference.collection}" → team "${reference.team}"`
	);
	if (rows.rows.length > 0) {
		throw new Error(
			`Approval names a team that does not exist: ${where.join('; ')}. ` +
				'Approvers are named by `team.name` and resolved against this tenant; the tenant has ' +
				'teams, so this is a typo or a team that was renamed. Storing the gate without approvers ' +
				'would leave a write nobody can approve, and storing no gate would let it through ' +
				'unreviewed — neither is a reconciliation this can perform.'
		);
	}
	return { idByName, unresolved };
}

/**
 * Say out loud that a gate landed without approvers.
 *
 * Warned here rather than left to the caller because the callers are two hosts and a caller that
 * ignores the return value turns this back into the silent case. The result carries the same list for
 * anything that wants to act on it.
 */
function warnDeferredApprovers(unresolved: readonly UnresolvedApproverTeam[]): void {
	const lines = unresolved.map(
		(reference) =>
			`  policy "${reference.policy}", ${reference.action} on "${reference.collection}" → team "${reference.team}"`
	);
	console.warn(
		`[pod] ${unresolved.length} approval reference(s) could not be resolved: this tenant has no ` +
			'teams yet.\n' +
			lines.join('\n') +
			'\nThe gates are stored and still block the write — they simply have no approvers, so nothing ' +
			'can be approved until the teams exist. Reconciliation is idempotent; seeding the teams and ' +
			'reconciling again binds them.'
	);
}

function resolveStep(
	step: ManifestPolicyApprovalStep,
	idByName: ReadonlyMap<string, string>
): Record<string, unknown> {
	return {
		id: step.id,
		name: step.name,
		teams_that_can_approve: step.approvers
			.map((name) => idByName.get(name))
			.filter((id): id is string => id !== undefined),
		description: step.description ?? null,
		conditions: step.where ?? {},
		nextSteps: (step.steps ?? []).map((next) => resolveStep(next, idByName))
	};
}

/**
 * Translate a declared approval into the `approval_config` the engine already reads.
 *
 * The rename is not cosmetic: the authoring shape says `approvers` because it holds names, and the
 * stored shape says `teams_that_can_approve` because it holds ids. Keeping one word for both is what
 * let a Core seed uuid sit in public template source for as long as it did.
 */
function resolveApproval(
	approval: ManifestPolicyApproval,
	idByName: ReadonlyMap<string, string>
): Record<string, unknown> {
	return {
		norbital_id: approval.id,
		approval_name: approval.name,
		supercede_teams: (approval.supercededBy ?? [])
			.map((name) => idByName.get(name))
			.filter((id): id is string => id !== undefined),
		conditions: approval.where ?? {},
		approval_step_nodes: approval.steps.map((step) => resolveStep(step, idByName))
	};
}

export async function reconcileDeclaredPolicies(
	client: PolicyReconcileClient,
	manifest: NorbitalManifest
): Promise<PolicyReconcileResult> {
	const declared = Object.values(manifest.policies ?? {});
	if (declared.length === 0) return { created: 0, updated: 0, unresolvedApproverTeams: [] };

	const { idByName, unresolved } = await resolveApproverTeams(
		client,
		collectApproverTeams(manifest)
	);
	if (unresolved.length > 0) warnDeferredApprovers(unresolved);

	let created = 0;
	let updated = 0;
	for (const policy of declared) {
		// The stored grant shape is the engine's, not the author's: `where` becomes `conditions` and
		// `approval` becomes `approval_config`. Translating on write means the engine reads exactly what
		// it read before policies moved into source.
		const grants = policy.grants.map((grant, index) => {
			assertStorableCondition(policy.key, grant.collection, grant.where);
			// A read cannot be gated, and quietly dropping the approval is the failure this whole path
			// exists to prevent: the grant would land as an ordinary unconditional read. `definePolicy`
			// says the same thing, but no policy file calls it — `satisfies Policy` does not.
			if (grant.action === 'read' && grant.approval) {
				throw new Error(
					`Policy "${policy.key}" gates a read on "${grant.collection}" behind approval. Only ` +
						'create, update, and delete can be gated; storing this would drop the gate silently.'
				);
			}
			return {
				id: `${policy.key}:${index}`,
				collection_name: grant.collection,
				action: grant.action,
				conditions: grant.where ?? {},
				...(grant.action === 'read'
					? {}
					: {
							approval_config: grant.approval ? resolveApproval(grant.approval, idByName) : null
						})
			};
		});

		const result = await client.query(
			`INSERT INTO policy (key, name, description, is_active, accessible_applications, grants)
			      VALUES ($1, $2, $3, TRUE, $4::jsonb, $5::jsonb)
			 ON CONFLICT (key) DO UPDATE
			      SET name = EXCLUDED.name,
			          description = EXCLUDED.description,
			          accessible_applications = EXCLUDED.accessible_applications,
			          grants = EXCLUDED.grants
			   RETURNING (xmax = 0) AS inserted`,
			[
				policy.key,
				policy.name,
				policy.description ?? null,
				JSON.stringify(policy.apps ? [...policy.apps] : []),
				JSON.stringify(grants)
			]
		);
		if (result.rows[0]?.inserted === true) created += 1;
		else updated += 1;
	}
	return { created, updated, unresolvedApproverTeams: unresolved };
}
