import type {
	CollectionDefinition,
	FieldDefinition,
	RelationDefinition
} from './workspace-schema.js';

/**
 * Where `schema()` reads a collection's declared shape from.
 *
 * `schema('time_entries', …)` names a collection and nothing else, so something has to answer what
 * that collection's columns and relations are. The answer already exists — it is three members of
 * the `WorkspaceDefinition` the compiler emits — and this is the one place that holds them, so the
 * shape primitive resolves against the same description the query path, the access layer and the
 * schema plan resolve against rather than a second one written for it.
 *
 * The registration is module-scoped, which is exactly the lifetime it should have: a workspace's
 * modules are loaded into an isolate of their own, so one heap holds one workspace and the slot
 * cannot be contended. Nothing is merged and nothing accumulates — a second registration replaces
 * the first, because two workspaces in one heap would be a bug in the host, not a case to support.
 *
 * Registration is deliberately late. `export const input = schema('payroll_runs', …)` runs at module
 * init in a `+hooks.ts`, which may be evaluated before the workspace module that registers, so
 * `schema()` reads nothing here until the schema it returns is first used — see `Schema.suspend` in
 * `schema.ts`. Import order is therefore not something an author has to know about.
 *
 * Every import here is type-only, so this module has no runtime dependency of its own and can be
 * imported from anywhere in the authoring graph without closing a cycle.
 */

/** One collection's columns, keyed by name, exactly as `describeModel` reports them. */
type CollectionFields = Readonly<Record<string, FieldDefinition>>;

/**
 * The three facts a shape is assembled from.
 *
 * They are named the way `WorkspaceDefinition` already names them so a caller hands the definition
 * straight over — a reshaped copy would be a second description of the same thing, which is the
 * failure this module exists to avoid.
 */
export interface WorkspaceShape {
	readonly collections: ReadonlyArray<CollectionDefinition<CollectionFields>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	/**
	 * Authored custom-type definitions, keyed by declared name.
	 *
	 * Held as `unknown` for the reason `WorkspaceDefinition.customTypes` holds it as `unknown`: a
	 * definition's `schema` is a Standard Schema from whichever library the author used, and the one
	 * thing that reads it — `describeInvalidCustomValue` — reaches it through `~standard`.
	 */
	readonly customTypes?: Readonly<Record<string, unknown>>;
}

let registered: WorkspaceShape | undefined;

/** Publishes the workspace whose collections `schema()` resolves names against. */
export const registerWorkspaceShape = (shape: WorkspaceShape): void => {
	registered = shape;
};

/** The columns a collection declares, or `undefined` when no workspace declares that collection. */
export const declaredFields = (collection: string): CollectionFields | undefined =>
	registered?.collections.find((entry) => entry.name === collection)?.fields;

/**
 * One authored relationship edge, resolved the way a read resolves it: by the collection
 * it leaves from and the name the `with` clause used.
 */
export const declaredRelation = (source: string, name: string): RelationDefinition | undefined =>
	registered?.relations.find((candidate) => candidate.source === source && candidate.name === name);

/** The custom-type registry a `custom()` column's value is validated against. */
export const declaredCustomTypes = (): Readonly<Record<string, unknown>> | undefined =>
	registered?.customTypes;
