import { Effect, Result, Schema } from 'effect';
import type { RemoteQuery } from '@norbital-ai/std/collection';
export type { RemoteQuery } from '@norbital-ai/std/collection';
import { ApprovalState } from '#lib/runtime/approvals/approvals.js';
import { createSyncClient, decodeChanges, decodeCursor } from '#lib/client/replica/sync-client.js';
import {
	ANY_COLLECTION,
	cacheKeyFor,
	collectionsFor,
	createQueryCache,
	type QueryCache
} from '#lib/client/replica/query-cache.js';
import {
	createLiveQueryRegistry,
	type LiveQueryRegistry
} from '#lib/client/replica/live-queries.js';
import type { SyncChange } from '#lib/runtime/sync/sync.js';
import {
	type CollectionPendingApproval as ProtocolPendingApproval,
	EnvironmentName,
	InvocationScope,
	pendingApprovalOf,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { createBoltClient, type BoltClient, type BoltTransport } from '#lib/client.js';
import { createRemoteQuery } from './remote-query.svelte.js';
import { projectRemoteQuery } from '#lib/client/replica/query-projection.svelte.js';
import { CollectionMutationState } from './collection-mutation.svelte.js';
import { workspaceSession } from '#lib/client/session.js';
import { openLocalDatabase, type BootstrapTransport } from '#lib/client/replica/bootstrap.js';
import { createLocalReader, type LocalReader } from '#lib/client/replica/local-reads.js';
import { subscribeToChanges, type Subscription } from '#lib/client/replica/subscribe.js';
import {
	executeReplicaStatement,
	type PGliteLike,
	type ProvisioningStep,
	replicaStatement
} from '#lib/client/replica/pglite-sql.js';
import { openPGlite } from '#lib/client/replica/pglite-loader.js';
import type { LocalSql } from '#lib/client/replica/pglite-sql.js';
import { createSystemClient } from '#lib/client/system-client.js';
export type { SystemClientApi } from '#lib/client/system-client.js';

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
}

/**
 * A collection mutation the server accepted into its approval workflow instead of committing.
 *
 * Promise types cannot describe a rejection channel, so callers that care about this outcome catch
 * this exported class while the ordinary mutation result remains `Promise<void>`. A mutation is a
 * command, not a read: write-only policies may authorize it while denying the stored row, and live
 * queries own the refreshed value when the caller can read it.
 */
export class CollectionMutationPendingApproval extends Error {
	readonly pending = true as const;
	readonly requestId: string;
	readonly collection: string;
	readonly id: string;
	readonly action: ProtocolPendingApproval['action'];

	constructor(outcome: ProtocolPendingApproval) {
		super(
			`${outcome.action} for ${outcome.collection} ${outcome.id} is pending approval ${outcome.requestId}`
		);
		this.name = 'CollectionMutationPendingApproval';
		this.requestId = outcome.requestId;
		this.collection = outcome.collection;
		this.id = outcome.id;
		this.action = outcome.action;
	}
}

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

/**
 * `Array.isArray` does not narrow a `readonly` array out of a union, so the true branch stayed
 * `JsonArray | JsonObject`. Testing the array case first and returning early narrows what is left.
 */
/**
 * `Array.isArray` narrows `any[]`, not `readonly Json[]`, so no arrangement of these guards makes
 * TypeScript discard the array member of `Schema.Json`. The checks are exhaustive; the assertion
 * only states what they already established.
 */
const asJsonRecord = (input: unknown): Readonly<Record<string, Schema.Json>> => {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
	const record: Record<string, Schema.Json> = {};
	for (const [key, value] of Object.entries(input)) {
		// Optional query properties are routinely assembled as `key: undefined`. Undefined has no JSON
		// representation and means exactly the same thing as omission here, so remove it before the
		// command schema validates the input. Keeping it made every first page (`after: undefined`) fail
		// locally with "Expected JSON value" without ever reaching the transport.
		if (value !== undefined) record[key] = value as Schema.Json;
	}
	return record;
};

export type CollectionCatalogField = Readonly<{
	readonly name: string;
	readonly kind: string;
	readonly nullable: boolean;
	/** A column the database computes; a form must not offer it as editable. */
	readonly readOnly?: boolean;
	readonly search?: boolean;
	readonly values?: ReadonlyArray<string>;
}>;

export type CollectionCatalogRelation = Readonly<{
	readonly name: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
	/** Whether deleting an owner recursively deletes records reached through this edge. */
	readonly cascade?: true;
}>;

export type CollectionCatalogEntry = Readonly<{
	readonly name: string;
	readonly recordLabel?: string;
	readonly fields: ReadonlyArray<CollectionCatalogField>;
	readonly relationships?: ReadonlyArray<CollectionCatalogRelation>;
}>;

export type CollectionCatalog = Readonly<Record<string, CollectionCatalogEntry>>;

type QueryFilter = Readonly<{
	readonly path: ReadonlyArray<string>;
	readonly operator: string;
	readonly operand?: Schema.Json;
}>;

type QueryOptions = Readonly<{
	readonly filters?: ReadonlyArray<QueryFilter>;
}>;

/** Nests a CollectionTable filter path into the JSON where compileWhere already understands. */
const filterToWhere = (filter: QueryFilter): Schema.Json => {
	const leaf = filter.path[filter.path.length - 1];
	if (leaf === undefined) return {};
	let node: Record<string, Schema.Json> = {
		[leaf]:
			filter.operand === undefined
				? { [filter.operator]: true }
				: { [filter.operator]: filter.operand }
	};
	for (let index = filter.path.length - 2; index >= 0; index -= 1) {
		const key = filter.path[index];
		if (key === undefined) continue;
		node = { [key]: node };
	}
	return node;
};

const mergeWhere = (
	query: Readonly<Record<string, Schema.Json>>,
	options?: QueryOptions
): Readonly<Record<string, Schema.Json>> => {
	const filters = options?.filters ?? [];
	if (filters.length === 0) return query;
	const clauses = filters.map(filterToWhere);
	const existing = query.where;
	const combined =
		existing === undefined
			? clauses.length === 1
				? clauses[0]
				: { AND: clauses }
			: { AND: [existing, ...clauses] };
	return combined === undefined ? query : { ...query, where: combined };
};

/**
 * Reads the rows out of a collection read, whichever shape it arrived in.
 *
 * Exported because callers that go straight to `transport.command` face the same page object as the
 * query layer does. Every one of them previously guarded with `Array.isArray` and fell back to an
 * empty list, so the page shape turned into "no records" rather than an error — the failure that
 * looks exactly like a collection legitimately having nothing in it.
 */
export const rowsFrom = (value: unknown): ReadonlyArray<Schema.Json> | undefined => {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === 'object' && value !== null) {
		const rows = Reflect.get(value, 'rows');
		if (Array.isArray(rows)) return rows;
	}
	return undefined;
};

const countFrom = (value: Schema.Json | undefined): number | undefined => {
	if (typeof value === 'number') return value;
	if (typeof value === 'object' && value !== null) {
		const count = Reflect.get(value, 'count');
		if (typeof count === 'number') return count;
	}
	return undefined;
};

const cursorFrom = (value: Schema.Json | undefined): string | null => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const cursor = Reflect.get(value, 'nextCursor');
		return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
	}
	return null;
};

/** Adapts the Promise-based public Bolt client once at the Effect-native runtime boundary. */
const commandEffect = (
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json
): Effect.Effect<Schema.Json, unknown> =>
	Effect.tryPromise(() => runtime.bolt.command(command, input, Schema.Json));

const decodedCommandEffect = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	output: Output,
	signal?: AbortSignal
): Effect.Effect<Output['Type'], unknown> =>
	Effect.tryPromise(() => runtime.bolt.command(command, input, output, signal));

/** Owns stateful remote-query construction without introducing a module-global runtime singleton. */
const RemoteQueries = {
	make: <
		Input extends Schema.ConstraintDecoder<Schema.Json>,
		Output extends Schema.ConstraintDecoder<Schema.Json>
	>(
		runtime: WorkspaceClientRuntime,
		command: string,
		input: Input['Type'],
		inputSchema: Input,
		outputSchema: Output,
		signal?: AbortSignal
	): RemoteQuery<Output['Type']> => {
		const cache = runtime.cache;
		const registry = runtime.queries;
		// Every read goes through here — `db.*`, `invoke.*`, `records`, `history`, `approvals` — which
		// is why the cache is attached at this single point rather than per API surface. A surface added
		// later is cached by construction instead of by remembering to.
		const caching =
			cache === undefined || registry === undefined
				? undefined
				: {
						cache,
						registry,
						key: cacheKeyFor(command, input),
						collections: collectionsFor(command, input)
					};
		/**
		 * The replica answers first when it can, and declines by returning `undefined` — at which point
		 * this is exactly the request it always was. The cache still sits in front of both, so a local
		 * answer is cached on the same terms a remote one is and invalidated by the same collections.
		 */
		return createRemoteQuery(
			() =>
				Effect.gen(function* () {
					const checked = yield* Schema.decodeUnknownEffect(inputSchema)(input);
					const reader = runtime.local?.current;
					const answered =
						reader === undefined ? undefined : yield* reader.answer(command, checked);
					if (answered !== undefined)
						return yield* Schema.decodeUnknownEffect(outputSchema)(answered);
					return yield* decodedCommandEffect(runtime, command, checked, outputSchema, signal);
				}),
			caching,
			outputSchema
		);
	}
};

const PageQueries = {
	make: (
		runtime: WorkspaceClientRuntime,
		command: string,
		input: Schema.Json
	): CollectionPageQuery<ReadonlyArray<Schema.Json>> => {
		const query = RemoteQueries.make(runtime, command, input, Schema.Json, Schema.Json);
		const projected = projectRemoteQuery(query, rowsFrom, (value) => rowsFrom(value) ?? []);
		const page: CollectionPageQuery<ReadonlyArray<Schema.Json>> = {
			get current() {
				return projected.current;
			},
			get nextCursor() {
				return cursorFrom(query.current);
			},
			get error() {
				return query.error;
			},
			get loading() {
				return query.loading;
			},
			refresh: projected.refresh,
			then: projected.then
		};
		return page;
	}
};

const CountQueries = {
	make: (runtime: WorkspaceClientRuntime, input: Schema.Json): RemoteQuery<number> => {
		const query = RemoteQueries.make(runtime, 'collections.count', input, Schema.Json, Schema.Json);
		const projected = projectRemoteQuery(query, countFrom, (value) => {
			const count = countFrom(value);
			if (count === undefined) throw new Error('Collection count completed without a value');
			return count;
		});
		return {
			get current() {
				return projected.current;
			},
			get error() {
				return query.error;
			},
			get loading() {
				return query.loading;
			},
			refresh: projected.refresh,
			then: projected.then
		};
	}
};

type GroupedJsonRows = Readonly<Record<string, Array<Schema.Json>>>;

/** Groups one fetched collection page while retaining the source query's lifecycle state. */
const groupRows = (
	rows: ReadonlyArray<Schema.Json>,
	by: string,
	lanes: ReadonlyArray<Schema.Json>
): GroupedJsonRows => {
	const grouped: Record<string, Array<Schema.Json>> = Object.fromEntries(
		lanes.map((lane) => [String(lane), []])
	);
	for (const row of rows) {
		const record = asJsonRecord(row);
		const lane = String(record[by] ?? '');
		(grouped[lane] ??= []).push(row);
	}
	return grouped;
};

const GroupedQueries = {
	make: (
		runtime: WorkspaceClientRuntime,
		collection: string,
		input: Schema.Json,
		options?: QueryOptions
	): RemoteQuery<GroupedJsonRows> => {
		const merged = mergeWhere(asJsonRecord(input), options);
		const group = asJsonRecord(merged.group);
		const by = typeof group.by === 'string' ? group.by : '';
		const lanes = Array.isArray(group.lanes) ? group.lanes : [];
		const pageInput: Record<string, Schema.Json> = { collection };
		for (const [key, value] of Object.entries(merged)) {
			if (key !== 'group') pageInput[key] = value;
		}
		// A board has no pagination control. Respect an authored ceiling and otherwise request the
		// command boundary's maximum page so it does not silently stop at the ordinary table default.
		if (typeof pageInput.limit !== 'number') pageInput.limit = 500;
		const source = PageQueries.make(runtime, 'collections.findMany', pageInput);
		return projectRemoteQuery(
			source,
			(rows) => groupRows(rows, by, lanes),
			(rows) => groupRows(rows, by, lanes)
		);
	}
};

type InvokeMethod = ReturnType<() => (input: Schema.Json) => RemoteQuery<Schema.Json>>;

/** Groups workspace API construction with the stateful remote-query factory it exposes. */
const WorkspaceApis = {
	create: (runtime: WorkspaceClientRuntime, catalog: CollectionCatalog = {}) => ({
		db: ClientDatabase.database(runtime, catalog),
		system: createSystemClient(runtime, (command, input, inputSchema, outputSchema, signal) =>
			RemoteQueries.make(runtime, command, input, inputSchema, outputSchema, signal)
		),
		invoke: new Proxy<Record<string, InvokeMethod>>(
			{},
			{
				get: (_target, property) =>
					typeof property === 'string'
						? (input: Schema.Json) =>
								RemoteQueries.make(
									runtime,
									`invoke.${property}`,
									{ input },
									Schema.Json,
									Schema.Json
								)
						: undefined
			}
		),
		collections: new Proxy<Record<string, CollectionCatalogEntry>>(
			{},
			{
				get: (_target, property) => {
					if (typeof property !== 'string') return undefined;
					return catalog[property] ?? { name: property, fields: [], relationships: [] };
				}
			}
		),
		records: {
			findMany: (collection: string, input: Schema.Json = {}) =>
				PageQueries.make(runtime, 'collections.findMany', { collection, ...asJsonRecord(input) })
		},
		history: {
			findMany: (collection: string, recordId: string) =>
				RemoteQueries.make(
					runtime,
					'collections.history',
					{ collection, id: recordId },
					Schema.Json,
					Schema.Json
				)
		},
		approvals: {
			findMany: (approvalId: string) =>
				PageQueries.make(runtime, 'collections.findMany', {
					collection: 'approval_request',
					where: { id: { eq: approvalId } },
					limit: 1
				}),
			process: (input: {
				readonly approvalRequestId: string;
				readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';
				readonly comments?: string;
			}) =>
				Effect.runPromise(
					Effect.gen(function* () {
						const state = yield* commandEffect(runtime, 'approvals.status', {
							requestId: input.approvalRequestId
						});
						const decision =
							input.action === 'APPROVED'
								? 'approve'
								: input.action === 'REQUEST_FOR_CHANGE'
									? 'request_changes'
									: 'reject';
						const decodedState = Schema.decodeUnknownResult(ApprovalState)(state);
						if (Result.isFailure(decodedState)) return;
						yield* commandEffect(runtime, 'approvals.decide', {
							state: decodedState.success,
							decision,
							...(input.comments === undefined ? {} : { reason: input.comments })
						});
						yield* Effect.sync(() => invalidateApproval(runtime));
					})
				),
			withdraw: (approvalRequestId: string) =>
				Effect.runPromise(
					Effect.gen(function* () {
						const state = yield* commandEffect(runtime, 'approvals.status', {
							requestId: approvalRequestId
						});
						const decodedState = Schema.decodeUnknownResult(ApprovalState)(state);
						if (Result.isFailure(decodedState)) return;
						yield* commandEffect(runtime, 'approvals.withdraw', {
							state: decodedState.success
						});
						yield* Effect.sync(() => invalidateApproval(runtime));
					})
				)
		}
	})
};

export const createWorkspaceApiProxy = WorkspaceApis.create;

/**
 * The transport the host declared, resolved per call.
 *
 * It used to be a second HTTP client written out here — its own `fetch`, its own endpoint literal,
 * and a credential sniffed from `document.documentElement.dataset`. That made two implementations of
 * "post a Bolt command" that could disagree about where commands go and who is making them, and the
 * one that read the document was wrong on every page that was not itself a served document.
 */
const browserTransport: BoltTransport = {
	command: (command, input, signal) => workspaceSession().transport.command(command, input, signal)
};

/**
 * Drops this collection's cached answers and re-runs the queries reading it.
 *
 * Called on the write path rather than left to the sync engine, because the replica drains on demand
 * and not on a timer: waiting for the outbox to report a write this client just made would leave the
 * table the user is looking at showing the row as it was before their own edit.
 */
const invalidateWrite = (
	runtime: WorkspaceClientRuntime,
	collections: ReadonlyArray<string>
): void => {
	runtime.cache?.invalidate(collections);
	runtime.queries?.refreshAffected(collections);
};

/** Names the root and every explicitly synchronized relationship for immediate query invalidation. */
const mutationCollections = (
	catalog: CollectionCatalog,
	collection: string,
	values: Readonly<Record<string, Schema.Json>>
): ReadonlyArray<string> => {
	const affected = new Set([collection]);
	const cascadesVisited = new Set<string>();
	const addCascadeDescendants = (name: string): void => {
		if (cascadesVisited.has(name)) return;
		cascadesVisited.add(name);
		for (const relation of catalog[name]?.relationships ?? []) {
			if (relation.cardinality !== 'many' || relation.cascade !== true) continue;
			affected.add(relation.target);
			addCascadeDescendants(relation.target);
		}
	};
	const visit = (name: string, record: Readonly<Record<string, Schema.Json>>): void => {
		const definition = catalog[name];
		if (definition === undefined) return;
		for (const relation of definition.relationships ?? []) {
			if (relation.cardinality !== 'many') continue;
			const children = record[relation.name];
			if (!Array.isArray(children)) continue;
			affected.add(relation.target);
			// A submitted empty array and an omitted stored child carry no values to recurse through,
			// but deleting that child may cascade through collections below it. Walk ownership metadata
			// rather than the submitted rows; non-cascade descendants remain untouched.
			addCascadeDescendants(relation.target);
			for (const child of children) visit(relation.target, asJsonRecord(child));
		}
	};
	visit(collection, values);
	return [...affected];
};

/**
 * Drops every cached answer and re-runs every live query, after an approval decision.
 *
 * An approval decision is not a `db.*` write, so it never passed through `invalidateWrite`. The one
 * table that happened to own the open sheet refreshed its own rows by hand, and every other surface
 * showing the same record — a board, a second table, a nested sheet — stayed stale until something
 * else refetched. The decision commits against a record this call cannot name a collection for, so
 * `ANY_COLLECTION` is the honest scope: something changed, and nothing held is provably still true.
 * Approvals are rare and deliberate, which is what makes a full re-read the cheap half of the trade.
 */
const invalidateApproval = (runtime: WorkspaceClientRuntime): void => {
	runtime.cache?.invalidate([ANY_COLLECTION]);
	runtime.queries?.refreshAffected([ANY_COLLECTION]);
};

/** Owns collection proxy behavior at the client boundary so validation and typed semantics stay consistent for every caller. */
const ClientDatabase = {
	collection: (runtime: WorkspaceClientRuntime, catalog: CollectionCatalog, collection: string) => {
		const mutation = new CollectionMutationState();
		return {
			findMany: (input: Schema.Json = {}, options?: QueryOptions) =>
				PageQueries.make(runtime, 'collections.findMany', {
					collection,
					...mergeWhere(asJsonRecord(input), options)
				}),
			findFirst: (input: Schema.Json = {}) =>
				RemoteQueries.make(
					runtime,
					'collections.findFirst',
					{ collection, ...asJsonRecord(input) },
					Schema.Json,
					Schema.Json
				),
			findGrouped: (input: Schema.Json, options?: QueryOptions) =>
				GroupedQueries.make(runtime, collection, input, options),
			count: (input: Schema.Json = {}, options?: QueryOptions) =>
				CountQueries.make(runtime, { collection, ...mergeWhere(asJsonRecord(input), options) }),
			/**
			 * Synchronizes one declarative graph.
			 *
			 * An included relationship is its complete desired state; omission leaves it untouched. The
			 * server performs the recursive reconciliation atomically. The browser owns no
			 * create/update/delete vocabulary and does no handwritten relational diffing. It also does not
			 * require a stored-row readback: a write-only policy can authorize this command while denying
			 * the corresponding read. Query invalidation makes a readable stored value the query's concern.
			 */
			mutate: (input: Schema.Json) => {
				const values = asJsonRecord(input);
				const affected = mutationCollections(catalog, collection, values);
				return mutation.run(
					Effect.gen(function* () {
						const response = yield* commandEffect(runtime, 'collections.mutate', {
							collection,
							values
						});
						const pending = pendingApprovalOf(response);
						if (pending !== undefined)
							return yield* Effect.fail(new CollectionMutationPendingApproval(pending));
					}).pipe(
						// A command can commit and then fail while settling an after-hook. The wire failure
						// cannot prove that no state changed, so every outcome conservatively invalidates the
						// submitted graph. This also covers approval acquisition before its typed rejection.
						// Non-collection queries depend on ANY_COLLECTION, so the same names refresh approval
						// status and timeline readers without component-owned refresh state.
						Effect.ensuring(Effect.sync(() => invalidateWrite(runtime, affected)))
					)
				);
			},
			get pending() {
				return mutation.pending;
			}
		};
	},
	database: (
		runtime: WorkspaceClientRuntime,
		catalog: CollectionCatalog
	): Readonly<Record<string, unknown>> => {
		const collections = new Map<string, unknown>();
		return new Proxy<Record<string, unknown>>(
			{},
			{
				get: (_target, property) => {
					if (typeof property !== 'string') return undefined;
					const existing = collections.get(property);
					if (existing !== undefined) return existing;
					const created = ClientDatabase.collection(runtime, catalog, property);
					collections.set(property, created);
					return created;
				}
			}
		);
	}
};

/**
 * Starts the replica as a real local PostgreSQL, provisioned from the tenant's own migrations.
 *
 * The engine is opened through a callback so this module never imports the wasm bundle: it is several
 * megabytes, and loading it before first paint would make every page slower to open in exchange for
 * making it faster to re-open. The caller imports it after the page is interactive, and a workspace
 * whose browser cannot run it keeps working over the wire — degraded to what it had before, never
 * broken.
 *
 * The order — provision, snapshot, then follow — is not arrangeable differently. Streaming before the
 * snapshot would apply updates to rows the replica does not hold; snapshotting before provisioning has
 * nowhere to put them.
 */
/** The Postgres channel the leader announces on, so every tab invalidates off one applied batch. */
const REPLICA_CHANNEL = 'bolt_replica_changed';

/**
 * The replicas already running in this document, keyed by the scope they hold.
 *
 * Starting one is expensive and not idempotent: it opens a PGlite engine, snapshots the workspace
 * and subscribes to the change stream. Two callers for the same scope therefore meant two engines
 * over one storage directory and two streams holding host connections — and two callers is the
 * ordinary case, because a component that remounts asks again for something it cannot see it already
 * has. Handing back the running one makes "start the replica" the idempotent request every caller
 * already assumed it was.
 *
 * Keyed by scope rather than by runtime, because the storage a replica opens is keyed by scope: two
 * runtimes for one workspace would otherwise collide in exactly the place this is protecting. The
 * maps live inside one document-lifetime owner rather than as ambient mutable collections.
 */
type RuntimeAccessState = {
	current: string;
	cache: QueryCache;
	readonly cacheNamespace: (accessScope: string) => string;
};

const RuntimeStates = {
	make: () => {
		const replicas = new Map<string, Effect.Effect<LocalReplica, unknown>>();
		const accessStates = new WeakMap<WorkspaceClientRuntime, RuntimeAccessState>();
		return {
			replica: (key: string) => replicas.get(key),
			rememberReplica: (key: string, replica: Effect.Effect<LocalReplica, unknown>) => {
				replicas.set(key, replica);
			},
			forgetReplica: (key: string) => {
				replicas.delete(key);
			},
			access: (runtime: WorkspaceClientRuntime) => accessStates.get(runtime),
			rememberAccess: (runtime: WorkspaceClientRuntime, state: RuntimeAccessState) => {
				accessStates.set(runtime, state);
			}
		};
	}
};

const runtimeStates = RuntimeStates.make();

const normalizedAccessScope = (value: string): string => value.trim() || 'operator';

const accessScopeFor = (runtime: WorkspaceClientRuntime): string =>
	runtimeStates.access(runtime)?.current ?? normalizedAccessScope(workspaceSession().accessScope);

/**
 * Moves one mounted client between policy scopes without rebuilding its component tree.
 *
 * The cache object is a stable delegate, so already-mounted queries immediately read from the new
 * access-scoped cache. The old local reader is withdrawn synchronously; subsequent reads go over
 * the wire until the matching replica has bootstrapped. Authorization still belongs to the server —
 * this boundary prevents data that was correctly returned for one authority from being reused for
 * another authority in the browser.
 */
export const switchWorkspaceAccessScope = (
	runtime: WorkspaceClientRuntime,
	accessScope: string
): void => {
	const state = runtimeStates.access(runtime);
	if (state === undefined) return;
	const next = normalizedAccessScope(accessScope);
	if (state.current === next) return;
	state.current = next;
	state.cache = createQueryCache(state.cacheNamespace(next));
	if (runtime.local !== undefined) delete runtime.local.current;
	runtime.queries?.refreshAffected([ANY_COLLECTION]);
};

export const startLocalReplica = (
	runtime: WorkspaceClientRuntime,
	open?: (steps: ReadonlyArray<ProvisioningStep>) => Effect.Effect<PGliteLike, unknown>,
	options: {
		readonly accessScope?: string;
		readonly onChange?: (applied: number) => void;
		readonly onError?: (cause: unknown) => void;
	} = {}
) => {
	const accessScope = normalizedAccessScope(options.accessScope ?? accessScopeFor(runtime));
	switchWorkspaceAccessScope(runtime, accessScope);
	const key = `${runtime.bolt.scope.tenantId}::${runtime.bolt.scope.environment}::${accessScope}`;
	let running = runtimeStates.replica(key);
	if (running === undefined) {
		// Cache the Effect, not a Promise: callers share the startup fiber while internal control flow
		// remains in Effect. `runPromise` below is only the exported browser API adapter.
		running = Effect.runSync(
			Effect.cached(
				startReplica(runtime, open, { ...options, accessScope }).pipe(
					Effect.map((replica) => ({
						...replica,
						stop: () => {
							runtimeStates.forgetReplica(key);
							replica.stop();
						}
					})),
					Effect.tapError(() => Effect.sync(() => runtimeStates.forgetReplica(key)))
				)
			)
		);
		runtimeStates.rememberReplica(key, running);
	}
	return Effect.runPromise(running);
};

const startReplica = (
	runtime: WorkspaceClientRuntime,
	open:
		((steps: ReadonlyArray<ProvisioningStep>) => Effect.Effect<PGliteLike, unknown>) | undefined,
	options: {
		readonly accessScope: string;
		readonly onChange?: (applied: number) => void;
		readonly onError?: (cause: unknown) => void;
	}
): Effect.Effect<LocalReplica, unknown> =>
	Effect.gen(function* () {
		const cache = runtime.cache;
		const registry = runtime.queries;
		// Scoped to the workspace, because browser storage is shared across every workspace this browser
		// has signed into and two built from the same template share a fingerprint.
		const scope = `${runtime.bolt.scope.tenantId}::${runtime.bolt.scope.environment}::${options.accessScope}`;
		const openEngine =
			open ?? ((steps: ReadonlyArray<ProvisioningStep>) => openPGlite(steps, scope));
		const transport: BootstrapTransport = {
			command: (command, input) =>
				accessScopeFor(runtime) === options.accessScope
					? commandEffect(runtime, command, input)
					: Effect.fail(new Error('Local replica access scope changed during startup'))
		};
		const local = yield* openLocalDatabase(transport, openEngine);
		if (accessScopeFor(runtime) !== options.accessScope) {
			yield* local.close();
			return yield* Effect.fail(new Error('Local replica access scope changed during startup'));
		}
		// The snapshot brought in rows no cursor accounts for, so everything cached predates it.
		cache?.clear();
		registry?.refreshAffected([ANY_COLLECTION]);

		const invalidateNamed = (collections: ReadonlyArray<string>): void => {
			if (cache === undefined || registry === undefined) return;
			cache.invalidate(collections);
			registry.refreshAffected(collections);
		};

		const collectionsIn = (changes: ReadonlyArray<SyncChange>): ReadonlyArray<string> =>
			changes.some((change) => change.operation === 'reset')
				? [ANY_COLLECTION]
				: [...new Set(changes.map((change) => change.collection))];

		/**
		 * Tells the other tabs what this one just applied.
		 *
		 * Only the leader streams, so without this a second tab would hold a database moving quietly
		 * underneath it while its own cache and rendered queries stayed on the old rows — stale in exactly
		 * the way the replica exists to prevent, and invisible because nothing errored.
		 *
		 * `pg_notify` rather than a `BroadcastChannel`: the notification travels with the database, so it
		 * cannot outrun the rows it describes, and a tab with no shared engine simply has no listener and
		 * loses nothing.
		 */
		// The collections are JSON-stringified into a positional payload, never used as statements.
		const announceToTabs = (collections: ReadonlyArray<string>): Effect.Effect<void> =>
			collections.length === 0
				? Effect.void
				: executeReplicaStatement(
						local.engine,
						replicaStatement('select pg_notify($1, $2)', [
							REPLICA_CHANNEL,
							JSON.stringify(collections)
						])
					).pipe(
						Effect.catch(() => Effect.void),
						Effect.asVoid
					);

		const client = yield* createSyncClient({
			transport: {
				head: () => commandEffect(runtime, 'sync.head', null).pipe(Effect.map(decodeCursor)),
				diff: (cursor, limit) =>
					commandEffect(runtime, 'sync.diff', { cursor, limit }).pipe(Effect.map(decodeChanges))
			},
			sink: {
				apply: (changes) =>
					Effect.gen(function* () {
						yield* Effect.forEach(changes, local.sql.applyChange, { discard: true });
						const collections = collectionsIn(changes);
						yield* Effect.sync(() => invalidateNamed(collections));
						yield* announceToTabs(collections);
					}),
				reset: () =>
					Effect.gen(function* () {
						yield* local.sql.reset();
						yield* Effect.sync(() => {
							cache?.clear();
							registry?.refreshAffected([ANY_COLLECTION]);
						});
						yield* announceToTabs([ANY_COLLECTION]);
					})
			},
			initialCursor: local.cursor,
			// Recorded in the replica's own database, in the same place as the rows it explains, so a reload
			// resumes exactly where this session stopped rather than re-reading the whole workspace.
			onAdvance: (cursor) => local.record(cursor).pipe(Effect.catch(() => Effect.void)),
			onError: options.onError
		});
		/**
		 * One drain in flight at a time, and one more queued behind it.
		 *
		 * A burst of writes produces a burst of frames, and starting a drain per frame would have several
		 * reading the same cursor and applying the same batch. `drain()` already collapses concurrent
		 * callers, so this only has to make sure a frame that arrives mid-drain is not lost: the trailing
		 * pass picks up whatever the in-flight one did not see.
		 */
		let draining = false;
		let pending = false;
		const catchUp = (): void => {
			if (draining) {
				pending = true;
				return;
			}
			draining = true;
			Effect.runFork(
				client.drain().pipe(
					Effect.tap((applied) =>
						Effect.sync(() => {
							if (applied > 0) options.onChange?.(applied);
						})
					),
					Effect.catch((cause) => Effect.sync(() => options.onError?.(cause))),
					Effect.ensuring(
						Effect.sync(() => {
							draining = false;
							if (!pending) return;
							pending = false;
							catchUp();
						})
					)
				)
			);
		};

		/**
		 * Exactly one tab streams.
		 *
		 * The database is shared, so a per-tab sync loop would have every open tab fetching the same
		 * diffs and applying them to the same rows — N times the requests and N times the writes to reach
		 * one outcome, with the cursor being advanced by whichever tab got there first. Leadership is
		 * already decided for us: the tab holding the database is the one that should feed it.
		 *
		 * A tab that is not the leader opens no stream at all, which is the point — one SSE connection
		 * per browser instead of one per tab. Browsers cap concurrent connections per host, so tabs used
		 * to compete for that budget with the very requests the pages were waiting on.
		 */
		// An absent `isLeader` means an unshared engine — the test harness, or a browser without workers —
		// which is the same thing as being the only tab.
		const leads = (): boolean => local.engine.isLeader !== false;

		let subscription: Subscription | undefined;
		const streamIfLeading = (): void => {
			if (!leads() || subscription !== undefined) return;
			// The host tells us when to look; nothing here asks on a timer. A frame names the collections
			// that changed, but the cursor decides what is actually fetched, so the names are not read
			// here — acting on them would be a second, weaker version of the ordering `sync.diff` gives.
			subscription = subscribeToChanges({
				onChange: () => catchUp(),
				// A reconnect can span a gap in which anything might have happened, so every open catches
				// up rather than waiting for the next write to arrive.
				onOpen: () => catchUp(),
				onError: options.onError
			});
		};
		streamIfLeading();

		/**
		 * Leadership moves when the leading tab closes, and the sync loop has to move with it.
		 *
		 * Without this, closing the one tab that happened to be elected would leave every remaining tab
		 * holding a live database that nothing was feeding: no stream, no drain, and no error — the
		 * workspace would simply stop updating until someone reloaded. The inherited stream catches up on
		 * open, so the gap between the old leader dying and the new one connecting is closed by the
		 * cursor rather than lost.
		 */
		/**
		 * From here on, reads this replica can answer identically are answered from it.
		 *
		 * Installed after the snapshot rather than before: until the rows are in, a local answer would be
		 * a confident empty result, which is worse than a slow correct one.
		 */
		if (runtime.local !== undefined && accessScopeFor(runtime) === options.accessScope) {
			runtime.local.current = createLocalReader(local.engine, local.shape, local.readable);
		}

		const stopWatchingLeader = local.engine.onLeaderChange(() => {
			if (leads()) {
				streamIfLeading();
				catchUp();
				return;
			}
			// Demotion is possible in principle; drop the stream rather than stream in duplicate.
			subscription?.stop();
			subscription = undefined;
		});

		/**
		 * Every tab listens, including the leader's followers who never fetch anything themselves.
		 *
		 * This is what makes a second tab correct rather than merely cheap: it holds no stream and runs
		 * no drain, so the only way it learns that its rendered queries are stale is the leader saying so
		 * through the database they share.
		 */
		const stopListening = yield* local.engine
			.listen(REPLICA_CHANNEL, (payload) => {
				// The leader already invalidated its own; this is for everybody else.
				if (leads()) return;
				// The payload is `JSON.stringify(collections)`, and an unreadable announcement still means
				// something changed — refreshing everything is the safe reading of it.
				const named = Result.getOrElse(
					Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(Schema.String)))(payload),
					() => null
				);
				invalidateNamed(named ?? [ANY_COLLECTION]);
			})
			.pipe(Effect.catch(() => Effect.succeed(() => Effect.void)));

		return {
			sql: local.sql,
			fingerprint: local.fingerprint,
			rows: local.rows,
			poke: catchUp,
			leader: leads,
			stop: () => {
				// Withdrawn first: a closed database that is still being asked would fail every read that
				// had been succeeding, rather than quietly going back to the wire.
				if (runtime.local !== undefined) delete runtime.local.current;
				stopWatchingLeader?.();
				subscription?.stop();
				client.stop();
				Effect.runFork(
					Effect.all(
						[
							stopListening().pipe(Effect.catch(() => Effect.void)),
							local.close().pipe(Effect.catch(() => Effect.void))
						],
						{ concurrency: 'unbounded', discard: true }
					)
				);
			}
		};
	});

export type LocalReplica = Readonly<{
	readonly sql: LocalSql;
	readonly fingerprint: string;
	/** Rows loaded by the initial snapshot, for a host that wants to report the bootstrap. */
	readonly rows: number;
	readonly poke: () => void;
	/** Whether this tab holds the shared database and therefore runs the sync loop. */
	readonly leader: () => boolean;
	readonly stop: () => void;
}>;

/**
 * Creates the browser runtime for the session the host declared.
 *
 * The scope was read from `data-bolt-*` attributes with `local`/`development` defaults behind it.
 * Those defaults are what let a page that carried no routing decision still render — as somebody
 * else's workspace, against a query cache namespaced to a tenant it was not showing. The session is
 * required instead, and stating a scope explicitly is still allowed for a caller that has one.
 */
export const createBrowserWorkspaceRuntime = (
	options: BrowserWorkspaceRuntimeOptions = {}
): WorkspaceClientRuntime => {
	const session = workspaceSession();
	const scope = InvocationScope.make({
		tenantId: TenantId.make(options.tenantId ?? session.tenantId),
		environment: EnvironmentName.make(options.environment ?? session.environment),
		releaseId: ReleaseId.make(options.releaseId ?? session.releaseId)
	});
	const bolt = createBoltClient(scope, options.transport ?? browserTransport);
	// Namespaced by tenant, environment, and access scope: browser storage is shared across every
	// workspace this browser has signed into, and an administrator's answers must not be reused while
	// they preview a restricted team (or vice versa) for as long as revalidation takes.
	const cacheNamespace = (accessScope: string): string =>
		`${scope.tenantId}::${scope.environment}::${normalizedAccessScope(accessScope)}`;
	const accessState: RuntimeAccessState = {
		current: normalizedAccessScope(session.accessScope),
		cache: createQueryCache(cacheNamespace(session.accessScope)),
		cacheNamespace
	};
	const cache: QueryCache = {
		get hydrated() {
			return accessState.cache.hydrated;
		},
		read: (key) => accessState.cache.read(key),
		write: (key, value, collections) => accessState.cache.write(key, value, collections),
		invalidate: (collections) => accessState.cache.invalidate(collections),
		clear: () => accessState.cache.clear()
	};
	const runtime: {
		bolt: BoltClient;
		db: Readonly<Record<string, unknown>>;
		local: { current?: LocalReader };
		cache: QueryCache;
		queries: LiveQueryRegistry;
	} = {
		bolt,
		db: {},
		local: {},
		cache,
		queries: createLiveQueryRegistry()
	};
	runtimeStates.rememberAccess(runtime, accessState);
	runtime.db = ClientDatabase.database(runtime, {});
	return runtime;
};
