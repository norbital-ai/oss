// repository-health:allow SEM_PARALLEL -- contract <-> runtime: runtime.ts consumes the client contract surface, linked through the #lib/client alias my probe cannot see.
import type { RemoteQuery } from '@norbital-ai/std/collection';
import type { InvocationScope } from '@norbital-ai/bolt-protocol';
import type { Schema } from 'effect';
import type { QueryCache } from './replica/query-cache.js';
import type { LiveQueryRegistry } from './replica/live-queries.js';
import type { LocalReader } from './replica/local-reads.js';

/** The transport a bolt client speaks over; the seam between a page and the workspace runtime. */
export type BoltTransport = Readonly<{
	readonly command: (command: string, input: Schema.Json, signal?: AbortSignal) => Promise<unknown>; // repository-health:allow EFF2 -- Fetch-compatible transports expose the browser Promise protocol and createBoltClient immediately adapts it with Effect.tryPromise.
}>;

/** The typed browser command seam; every internal workflow immediately adapts its decoded Promise into Effect. */
export type BoltClient = Readonly<{
	readonly scope: InvocationScope;
	readonly command: <S extends Schema.ConstraintDecoder<unknown>>(
		command: string,
		input: Schema.Json,
		output: S,
		signal?: AbortSignal
	) => Promise<S['Type']>; // repository-health:allow EFF2 -- BoltClient is the public browser command seam; every internal workflow immediately adapts its decoded Promise into Effect.
}>;

export type { RemoteQuery };

/** The schemas the generated client declaration may build mutation graphs from. */
type MutationSchema = Readonly<{
	readonly tables: Readonly<
		Record<
			string,
			Readonly<{
				readonly $inferSelect: object;
				readonly $inferInsert: object;
			}>
		>
	>;
	readonly relations: Readonly<Record<string, unknown>>;
}>;

type MutationTableName<S extends MutationSchema> = keyof S['tables'] & string;
type MutationRow<
	S extends MutationSchema,
	N extends MutationTableName<S>
> = S['tables'][N]['$inferSelect'];
type MutationInsert<
	S extends MutationSchema,
	N extends MutationTableName<S>
> = S['tables'][N]['$inferInsert'];
type SystemMutationKey =
	'id' | 'created_at' | 'updated_at' | 'sys_period' | 'row_version' | 'approval_id';
type AuthoredMutationInsert<S extends MutationSchema, N extends MutationTableName<S>> = Omit<
	MutationInsert<S, N>,
	SystemMutationKey
>;
type MutationIdentity<S extends MutationSchema, N extends MutationTableName<S>> =
	MutationRow<S, N> extends { readonly id: infer Identity } ? Identity : string;

type RelationsFor<
	S extends MutationSchema,
	N extends MutationTableName<S>
> = N extends keyof S['relations'] ? S['relations'][N] : never;
type ManyRelation<S extends MutationSchema, N extends MutationTableName<S>> = {
	readonly [K in keyof RelationsFor<S, N>]: RelationsFor<S, N>[K] extends {
		readonly cardinality: 'many';
		readonly target: MutationTableName<S>;
		readonly column: infer Column;
		readonly parentColumn: infer ParentColumn;
	}
		? [Column] extends [never]
			? never
			: [ParentColumn] extends [never]
				? never
				: Column extends PropertyKey
					? [ParentColumn] extends ['id']
						? K
						: never
					: never
		: never;
}[keyof RelationsFor<S, N>];
type RelationTarget<
	S extends MutationSchema,
	N extends MutationTableName<S>,
	K extends ManyRelation<S, N>
> = RelationsFor<S, N>[K] extends { readonly target: infer Target extends MutationTableName<S> }
	? Target
	: never;
type RelationColumn<
	S extends MutationSchema,
	N extends MutationTableName<S>,
	K extends ManyRelation<S, N>
> = RelationsFor<S, N>[K] extends { readonly column: infer Column extends PropertyKey }
	? Column
	: never;

type WithoutKey<Value, Key extends PropertyKey> = Value extends unknown
	? Omit<Value, Extract<Key, keyof Value>>
	: never;

/**
 * A declarative record is either a new insert or an identified partial update.
 *
 * Identity lives inside the record at every level. Its presence is the operation discriminator;
 * callers cannot supply a separate id whose meaning changes between roots and children.
 */
type MutationRecord<S extends MutationSchema, N extends MutationTableName<S>> =
	| AuthoredMutationInsert<S, N>
	| (Readonly<{ id: MutationIdentity<S, N> }> & Partial<AuthoredMutationInsert<S, N>>);

type MutationChildren<S extends MutationSchema, N extends MutationTableName<S>> = {
	readonly [K in ManyRelation<S, N>]?: ReadonlyArray<
		WithoutKey<CollectionMutationValues<S, RelationTarget<S, N, K>>, RelationColumn<S, N, K>>
	>;
};

/**
 * The precise graph accepted by `client.db.<collection>.mutate`.
 *
 * Only declared `many` relationships with an unambiguous child foreign key and the supported
 * parent `id` join may be included. Each is optional so omission means untouched; when present, its
 * array is the complete desired state and is checked recursively. The child's owning foreign key is
 * absent because the server derives it from the parent.
 */
export type CollectionMutationValues<
	S extends MutationSchema,
	N extends MutationTableName<S>
> = MutationRecord<S, N> & MutationChildren<S, N>;

export type WorkspaceClientRuntime = Readonly<{
	readonly db: Readonly<Record<string, unknown>>;
	readonly bolt: BoltClient;
	/**
	 * The sync engine's read cache and the live queries it invalidates.
	 *
	 * Optional together: a runtime built without them — the test harness, a caller outside a browser —
	 * issues every read over the wire exactly as before, rather than taking a second code path through
	 * a cache that has nowhere to persist to.
	 */
	readonly cache?: QueryCache;
	readonly queries?: LiveQueryRegistry;
	/**
	 * Where the replica installs its reader once it is up.
	 *
	 * A mutable slot rather than a constructor argument because the ordering is fixed the other way:
	 * pages are rendering, and therefore reading, long before several megabytes of WebAssembly have
	 * finished loading. Reads before that go to the server, which is simply how it worked before.
	 */
	readonly local?: { current?: LocalReader };
}>;

export type BrowserWorkspaceRuntimeOptions = Readonly<{
	readonly transport?: BoltTransport;
	readonly tenantId?: string;
	readonly environment?: string;
	readonly releaseId?: string;
}>;
