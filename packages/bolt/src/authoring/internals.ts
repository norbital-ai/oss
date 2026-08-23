import type { ModelDeclaration } from './models-schema.js';
import type { SYSTEM_COLLECTION_MODELS } from './system-models.js';
import type { RemoteQuery as ClientRemoteQuery } from '@norbital-ai/std/collection';
export type { RemoteQuery } from '@norbital-ai/std/collection';
export type { AutomationContext, AutomationTrigger } from './automations-schema.js';
export {
	describeHooks,
	describeModel,
	describeModelColumns,
	compileModel
} from './model-introspection.js';
export {
	approvalConfigurationId,
	approvalStepId,
	describeEnvoy,
	describePolicy
} from './policy-introspection.js';
export { describeIntegrations, manifestIntegrations } from './integration-introspection.js';
export { agentTools, describeMcpServer, describeSkill } from './workspace-schema.js';
export type {
	AuthoredIntegrationBinding,
	AuthoredIntegrationModule,
	DescribedIntegrations,
	IntegrationBindingInput,
	IntegrationsModuleInput
} from './integration-introspection.js';
import type {
	BeforeApi,
	DefaultWorkspaceSchema,
	InputValuesForTables as ContractInputValuesForTables,
	TableName,
	TablesForModels
} from './contracts-schema.js';

/** Owns generated registry assembly without changing the inferred authored declaration types. */
const RuntimeAuthoring = {
	models: <const M extends Readonly<Record<string, ModelDeclaration>>>(models: M): M => models,
	registry: <const M extends Readonly<Record<string, ModelDeclaration>>>(
		input: RuntimeRegistryInput<M>
	): RuntimeRegistry<M> => ({
		tables: input.models,
		collection: (name, definition) => ({ name, definition })
	}),
	collection: <M extends Readonly<Record<string, ModelDeclaration>>>(
		registry: RuntimeRegistry<M>,
		name: keyof M & string,
		definitions: ReadonlyArray<Readonly<Record<string, unknown>>>
	) => registry.collection(name, Object.assign({}, ...definitions)),
	workspace: <M extends Readonly<Record<string, ModelDeclaration>>, const Workspace>(
		_registry: RuntimeRegistry<M>,
		workspace: Workspace
	): Workspace => workspace
};

export const defineModels = RuntimeAuthoring.models;

type RelationshipColumn = import('drizzle-orm/pg-core').AnyPgColumnBuilder & {
	readonly through: (column: import('drizzle-orm/pg-core').AnyPgColumnBuilder) => unknown;
};
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
export type RelationshipHelpers<M extends Readonly<Record<string, ModelDeclaration>>> = Readonly<{
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
export type InputValuesForTables<
	T extends Readonly<Record<string, import('./contracts-schema.js').TableShape<unknown, unknown>>>
> = import('./contracts-schema.js').InputValuesForTables<T>;
export type MutationInsertFor<
	S extends import('./contracts-schema.js').AnySchema,
	N extends import('./contracts-schema.js').TableName<S>
> = import('./contracts-schema.js').MutationInsertFor<S, N>;

export const platformIdentityTables: Readonly<Record<string, never>> = {};

type RuntimeRegistry<M extends Readonly<Record<string, ModelDeclaration>>> = {
	readonly tables: M;
	readonly collection: (
		name: keyof M & string,
		definition: Readonly<Record<string, unknown>>
	) => { readonly name: keyof M & string; readonly definition: Readonly<Record<string, unknown>> };
};
export type RuntimeRegistryInput<M extends Readonly<Record<string, ModelDeclaration>>> = Readonly<{
	readonly models: M;
	readonly relationships: unknown;
	readonly customTypes?: Readonly<Record<string, unknown>>;
	readonly platformTables?: Readonly<Record<string, unknown>>;
}>;

export const defineRuntimeRegistry = RuntimeAuthoring.registry;
export const defineRuntimeCollection = RuntimeAuthoring.collection;
export const defineRuntimeWorkspace = RuntimeAuthoring.workspace;

export type WorkspaceAppDef = Readonly<{
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly icon?: string;
	readonly thumbnail?: string;
	readonly banner?: string;
	readonly group?: string;
	readonly component?: Readonly<Record<string, WorkspaceAppDef>>;
	readonly defaultChild?: string;
}>;
export type GroupDefinition = import('./models-schema.js').BoltGroupDefinition;
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
	readonly inputs: ContractInputValuesForTables<PlatformModelTables>;
};
export type CollectionRegistryFor<
	S extends import('./contracts-schema.js').AnySchema,
	_Hooks = never
> = {
	readonly [N in TableName<S>]: {
		readonly create: Partial<import('./contracts-schema.js').MutationInsertFor<S, N>>;
		readonly update: import('./contracts-schema.js').MutationUpdateFor<S, N>;
		readonly row: import('./contracts-schema.js').SchemaRow<S, N>;
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
export type InvokeClientRuntime<
	S extends import('./contracts-schema.js').AnySchema = DefaultWorkspaceSchema
> = Readonly<{ readonly api: BeforeApi<S> }>;
