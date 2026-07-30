import type {
	AnySchema,
	DefaultAppName,
	DefaultWorkspaceSchema,
	SchemaRow,
	TableName
} from '../schema/types.js';
import type { MergedWorkspaceSchema } from '../schema/system-workspace.js';
import type { SchemaWhere } from '../schema/types.js';

export type PolicyAction = 'create' | 'read' | 'update' | 'delete';

type PolicyCollection<S extends AnySchema> = TableName<MergedWorkspaceSchema<S>>;

type PolicyGrantFor<S extends AnySchema, C extends PolicyCollection<S>> = {
	readonly collection: C;
	readonly action: PolicyAction;
	readonly where?: SchemaWhere<SchemaRow<MergedWorkspaceSchema<S>, C>>;
	/**
	 * Route matching mutations through an approval flow instead of applying them directly. Reads cannot
	 * be gated, so this is only meaningful on `create`, `update`, and `delete`.
	 */
	readonly approval?: Record<string, unknown> | null;
};

/**
 * One grant: an action on a collection, optionally narrowed to matching rows.
 *
 * Written as a mapped-then-indexed union rather than a generic with a default so each member pairs a
 * collection with *its own* row type. A single generic would check `where` against the union of every
 * collection's columns, which accepts `{ owner_id }` on a collection that has no such column — a
 * filter that then matches nothing while reading like a grant. Distributing makes the pair exact.
 */
export type PolicyGrant<S extends AnySchema = DefaultWorkspaceSchema> = {
	[C in PolicyCollection<S>]: PolicyGrantFor<S, C>;
}[PolicyCollection<S>];

/**
 * A named set of grants, declared in `src/policies/+<name>.policy.ts`.
 *
 * The filename is the key, the same way a collection directory names a collection — so there is no
 * registry to keep in step and no way for a policy's identity to drift from its file.
 *
 * Policies are *definitions*; who holds them is not. `team.policy_id` still points at a policy row and
 * `team_members` still assigns people, because membership changes at runtime while the shape of a
 * permission set is a property of the workspace. Declaring the definitions means a fresh database has
 * working permissions with nothing seeded, which is what makes `pod start` usable.
 */
export type PolicyDefinition<S extends AnySchema = DefaultWorkspaceSchema> = {
	readonly name: string;
	readonly description?: string | null;
	/**
	 * App ids this policy may open. Omitted means every app.
	 *
	 * Bound to the generated `AppName` union, because this is the one field whose mistakes are entirely
	 * silent: the id is compared by exact string match when the sidebar is built, so a typo, a stray
	 * space, or the wrong case grants nothing *and* revokes the app the author meant to allow — with no
	 * error anywhere.
	 */
	readonly apps?: readonly DefaultAppName[];
	readonly grants: readonly PolicyGrant<S>[];
};

/**
 * Identity function that exists for its inference; a policy file gets checked on write.
 *
 * Prefer `satisfies Policy` from the generated `$types.js` — it binds the workspace schema, so
 * collection names and `where` columns are exact. This overload is the escape hatch for a policy
 * assembled by a helper rather than written literally.
 */
export function definePolicy<const TPolicy extends PolicyDefinition>(policy: TPolicy): TPolicy {
	if (!policy.name.trim()) throw new Error('Policy name cannot be empty');
	if (policy.grants.length === 0) {
		throw new Error(`Policy "${policy.name}" declares no grants; remove the file or add one`);
	}
	for (const grant of policy.grants) {
		if (grant.action === 'read' && grant.approval) {
			throw new Error(
				`Policy "${policy.name}" gates a read behind approval; only create, update, and delete can be gated`
			);
		}
	}
	return policy;
}

/** A policy plus the key the compiler derived from its filename. */
export type PolicyDeclaration = PolicyDefinition & { readonly key: string };
