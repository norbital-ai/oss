import type { ModelDeclaration } from './models-schema.js';
import type { SYSTEM_COLLECTION_MODELS } from './system-models.js';
import type { RemoteQuery as ClientRemoteQuery } from '@norbital-ai/std/collection';
import type { TableName, TablesForModels } from './contracts-schema.js';
export type { AutomationContext, AutomationTrigger } from './automations-schema.js';
export { describeHooks, compileModel } from './model-introspection.js';
export { describeEnvoy, describePolicy } from './policy-introspection.js';
export { describeIntegrations, manifestIntegrations } from './integration-introspection.js';
export { agentTools } from './workspace-schema.js';

/** Owns generated model registration without changing the inferred authored declaration types. */
export const defineModels = <const M extends Readonly<Record<string, ModelDeclaration>>>(
	models: M
): M => models;

/**
 * An endpoint names a column and nothing more. There is no `.through(...)`: a many-to-many is two
 * ordinary edges on its join collection, which is a first-class collection here — the helper
 * proxies never implemented traversal, so a type that offered it crashed at compile time in the
 * one place the types said it would work.
 */
type RelationshipColumn = import('drizzle-orm/pg-core').AnyPgColumnBuilder;
type RelationshipCollection<
	M extends Readonly<Record<string, ModelDeclaration>>,
	Name extends keyof M & string
> = {
	readonly [Field in keyof M[Name]['columns']]: M[Name]['columns'][Field] & RelationshipColumn;
} & { readonly id: RelationshipColumn };
type RelationFactories<M extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly [Name in keyof M & string]: (
		input?: Readonly<Record<string, unknown>>
	) => Readonly<Record<string, unknown>>;
} & Readonly<
	Record<string, (input?: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>>
>;
type RelationshipHelpers<M extends Readonly<Record<string, ModelDeclaration>>> = Readonly<{
	readonly one: RelationFactories<M>;
	readonly many: RelationFactories<M>;
	/**
	 * The identity table, reachable as a foreign-key target and nothing else.
	 *
	 * `schema-migrations.ts` resolves this name to the compiled system user table so `r.one.user(...)` points an
	 * ownership column at the only description of a person Bolt has. `team` and `team_members` sat
	 * beside it until identity became runtime-owned: teams are a jsonb array on that same row now,
	 * so those two named tables the migration compiler could not resolve, and `r.one.team(...)`
	 * typechecked its way into a compiler crash.
	 */
	readonly user: { readonly id: RelationshipColumn };
}> & { readonly [Name in keyof M & string]: RelationshipCollection<M, Name> };
export type PlatformRelationshipsFor<M extends Readonly<Record<string, ModelDeclaration>>> = (
	helpers: RelationshipHelpers<M>
) => Readonly<Record<string, unknown>>;

export type { TablesForModels } from './contracts-schema.js';

/**
 * A person, as much of one as a workspace may read.
 *
 * Two fields, because the system read policy grants `user` with exactly that field mask —
 * `findMany` masks every row it returns, so the address, roles and teams are not merely unselected
 * here, they cannot be read at all. Typing the full row would promise authored code something the
 * runtime refuses.
 *
 * This replaces `user`, `team` and `team_members`, which were declared here long after the tables
 * themselves stopped existing: identity became runtime-owned and merged into `user`, and
 * teams became a jsonb array on that row rather than records of their own. Nothing removed the
 * types, so `db.user.findMany(...)` went on typechecking in three workspace screens and failing at
 * run time against a table that is not in `information_schema`.
 */
type PlatformModelTables = TablesForModels<typeof SYSTEM_COLLECTION_MODELS>;
export type PlatformSchema = {
	readonly tables: PlatformModelTables;
	readonly relations: Readonly<Record<string, unknown>>;
};

/**
 * The one runtime-owned collection intentionally published to authored browser code.
 *
 * Every other platform table is implementation state: identity, credentials, conversations,
 * automation execution and notifications belong to Bolt's own shell and server. Keeping the
 * authored schema separate from `PlatformSchema` prevents a private table from becoming public just
 * because the framework adds it to its internal registry.
 */
export type PublicPlatformSchema = {
	readonly tables: Pick<PlatformModelTables, 'approval_request'>;
	readonly relations: Readonly<Record<string, unknown>>;
};
/**
 * The browser client's view of a workspace's collections.
 *
 * `Inputs` is the same generated map `Api` takes, and it types `client.db.<collection>.mutate` from
 * the same `export const input` the server's `api.db.<collection>.mutate` reads. One declaration,
 * both callers — which is the property the old `create.input`/`update.input` pair could not have,
 * since it was two of them and neither reached the client at all.
 */
export type CollectionRegistryFor<
	S extends import('./contracts-schema.js').AnySchema,
	Inputs = unknown
> = {
	readonly [N in TableName<S>]: {
		readonly row: import('./contracts-schema.js').SchemaRow<S, N>;
		readonly mutation: import('./contracts-schema.js').MutationValuesFor<S, N, Inputs>;
	};
};
export type InvokeClientApi<
	Invoke extends Readonly<Record<string, { readonly handler: (...arguments_: never[]) => unknown }>>
> = {
	readonly [K in keyof Invoke]: (
		input: Parameters<Invoke[K]['handler']>[0]
	) => ClientRemoteQuery<HandlerSuccess<ReturnType<Invoke[K]['handler']>>>;
};
type HandlerSuccess<Value> = Value extends import('effect').Effect.Effect<
	infer Success,
	unknown,
	never
>
	? Success
	: Awaited<Value>;
