import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

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

export type PolicyReconcileResult = {
	readonly created: number;
	readonly updated: number;
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

export async function reconcileDeclaredPolicies(
	client: PolicyReconcileClient,
	manifest: NorbitalManifest
): Promise<PolicyReconcileResult> {
	const declared = Object.values(manifest.policies ?? {});
	if (declared.length === 0) return { created: 0, updated: 0 };

	let created = 0;
	let updated = 0;
	for (const policy of declared) {
		// The stored grant shape is the engine's, not the author's: `where` becomes `conditions` and
		// `approval` becomes `approval_config`. Translating on write means the engine reads exactly what
		// it read before policies moved into source.
		const grants = policy.grants.map((grant, index) => {
			assertStorableCondition(policy.key, grant.collection, grant.where);
			return {
				id: `${policy.key}:${index}`,
				collection_name: grant.collection,
				action: grant.action,
				conditions: grant.where ?? {},
				...(grant.action === 'read' ? {} : { approval_config: grant.approval ?? null })
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
	return { created, updated };
}
