import { Effect, Result, Schema } from 'effect';
import { ApprovalState } from '#lib/runtime/approvals/approvals.js';
import {
	ARBITRARY_QUERY_INVALIDATION,
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
import {
	compareSyncCursors,
	SyncPartitionIdentity,
	SyncPartitionStatusResponse,
	type SyncCursor
} from '#lib/runtime/sync/sync.js';
import {
	CollectionCountWindow,
	CollectionGroupedWindow,
	CollectionQueryPage,
	CollectionMutationSettlement as CollectionMutationSettlementSchema,
	EnvironmentName,
	InvocationScope,
	PROTOCOL_VERSION,
	type ReplicaSchemaMaintenance,
	type ReplicaSchemaMaintenanceClear,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { createBoltClient } from '#lib/client.js';
import type { BoltClient, BoltTransport } from '#lib/client/contracts.js';
import type {
	BrowserWorkspaceRuntimeOptions,
	CollectionMutationValues,
	RemoteQuery,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';
import { createRemoteQuery, type RemoteQueryAttempt } from './remote-query.svelte.js';
import { projectRemoteQuery } from '#lib/client/replica/query-projection.svelte.js';
import { CollectionMutationState } from './collection-mutation.svelte.js';
import { AutomationExecutionState, AutomationTaskSnapshot } from './automation-client.svelte.js';
export type {
	AutomationClientApi,
	AutomationProgression,
	AutomationRun,
	AutomationRunSnapshot,
	AutomationTaskSnapshot,
	ErasedAutomationClientApi
} from './automation-client.svelte.js';
import { workspaceSession } from '#lib/client/session.js';
import {
	openLocalDatabase,
	ReplicaStoredStateCorruption,
	type BootstrapTransport
} from '#lib/client/replica/bootstrap.js';
import {
	createCollectionMutationJournal,
	discoverCollectionMutationJournals,
	locallyDurableMutationResult,
	MUTATION_PUSH_STALE_AFTER_MS,
	mutationWireRequest,
	prepareLocalCollectionMutation,
	type CollectionMutationJournal
} from '#lib/client/replica/mutation-journal.js';
import {
	deleteInactivePGlitePartition,
	openReplicaPhysicalPartitionLease,
	replicaLocation,
	type ReplicaPhysicalPartitionLease,
	type ReplicaStorageLockManager
} from '#lib/client/replica/physical-storage.js';
import {
	createLocalReader,
	createLocalWindowRecomputer,
	type LocalReader
} from '#lib/client/replica/local-reads.js';
import {
	readableSubscriptionCollections,
	subscribeToPartition,
	type PartitionSubscription
} from '#lib/client/replica/subscribe.js';
import {
	readDurableReplicaSchema,
	ReplicaProvisioningFailure,
	writeDurableReplicaSchema,
	type PGliteLike,
	type ProvisioningStep as ProvisioningStepType
} from '#lib/client/replica/pglite-sql.js';
import {
	hasCanonicalRelationshipSelection,
	projectCollectionQueryRows
} from '#lib/runtime/collections/canonical-query.js';
import {
	createWindowLedger,
	INACTIVE_WINDOW_TTL_MILLIS,
	MAX_REPLICA_WINDOW_ROWS,
	windowDescriptorOf,
	type QueryWindowSummary,
	type WindowLedger
} from '#lib/client/replica/coverage.js';
import {
	authoritativeBaseRowsFromGroupedWindow,
	authoritativeBaseRowsFromPage,
	confirmCollectionCountWindow,
	confirmCollectionGroupedWindow,
	confirmCollectionQueryPage,
	describeClientQueryWindow,
	groupedRowIdsFromWindow,
	type ClientQueryWindowDescription
} from '#lib/client/replica/query-window.js';
import {
	createPartitionSyncCoordinator,
	type PartitionSyncCoordinator,
	type PartitionWindowMount,
	type WindowFlight,
	type WindowInstallContext
} from '#lib/client/replica/partition-sync.js';
import type { ReplicaWindowVisibility } from '#lib/client/replica/hydration-priority.js';
import {
	openReplicaInvalidationBus,
	type ReplicaSchemaControl
} from '#lib/client/replica/cross-tab-invalidation.js';
import {
	fingerprintReplicaPrincipal,
	openReplicationLeadership,
	replicaPartitionKey,
	REPLICA_FORMAT_VERSION,
	type ReplicaPartitionIdentity,
	type ReplicationLeadership,
	type WebLockManagerLike
} from '#lib/client/replica/leader.js';
import {
	createSchemaBarrierController,
	type ReplicaSchemaBarrier,
	type SchemaBarrierController,
	type SchemaBarrierHooks
} from '#lib/client/replica/barrier.js';
import {
	selectReplicaStorage,
	type ReplicaProfileEvictionCandidate,
	type ReplicaStorageDecision,
	type ReplicaStorageBudget,
	type ReplicaStorageTier
} from '#lib/client/replica/budget.js';
import {
	createRunningAutomationLeaseHooks,
	enforceIndexedReplicaProfileBudget,
	maintainReplicaLeaseOwner,
	openBrowserReplicaProfileIndex,
	profilePartition,
	profileWindowsFromLedger,
	replicaProfilePartitionId,
	type ReplicaLeaseHandle,
	type ReplicaProfileIndex,
	type ReplicaAutomationStatus
} from '#lib/client/replica/profile-index.js';
import { createSystemClient } from '#lib/client/system-client.js';
import {
	createWorkspaceSyncStatus,
	type MutableWorkspaceSyncStatusSignal
} from '#lib/client/replica/sync-status.js';
export type { SystemClientApi } from '#lib/client/system-client.js';
export type {
	CollectionMutationValues,
	LocallyDurableMutationResult,
	MutationSettlement,
	MutationSettlementHandle,
	MutationSettlementStatus,
	WorkspaceClientRuntime,
	RemoteQuery
} from '#lib/client/contracts.js';
export type {
	SyncIssue,
	WorkspaceSyncStatus,
	WorkspaceSyncStatusSignal
} from '#lib/client/replica/sync-status.js';

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
}

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
	// Surface filters are independently canonicalized narrowing. They must not be folded into the
	// authored predicate: the server enforces both, while the window identity and offline messaging
	// preserve which constraint came from the workspace and which came from the current user surface.
	const existing = query.userFilter;
	const combined =
		existing === undefined
			? clauses.length === 1
				? clauses[0]
				: { AND: clauses }
			: { AND: [existing, ...clauses] };
	return combined === undefined ? query : { ...query, userFilter: combined };
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

/** Authoritative query pages retain trailing lookahead, but the public query exposes only its page. */
const visibleRowsFrom = (value: Schema.Json | undefined): ReadonlyArray<Schema.Json> | undefined => {
	const rows = rowsFrom(value);
	if (rows === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
		return rows;
	}
	const lookahead = Reflect.get(value, 'lookahead');
	return typeof lookahead === 'number' && Number.isSafeInteger(lookahead) && lookahead >= 0
		? rows.slice(0, Math.max(0, rows.length - lookahead))
		: rows;
};

const projectedVisibleRowsFrom = (
	value: Schema.Json | undefined,
	input: Schema.Json
): ReadonlyArray<Schema.Json> | undefined => {
	const rows = visibleRowsFrom(value);
	if (rows === undefined) return undefined;
	const query = asJsonRecord(input);
	return projectCollectionQueryRows(
		rows as ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
		query['columns'],
		query['with']
	);
};

const countFrom = (value: Schema.Json | undefined): number | undefined => {
	if (typeof value === 'number') return value;
	if (typeof value === 'object' && value !== null) {
		const count = Reflect.get(value, 'count');
		if (typeof count === 'number') return count;
	}
	return undefined;
};

type GroupedJsonRows = Readonly<Record<string, ReadonlyArray<Schema.Json>>>;

type MutationRowReference = Readonly<{ readonly collection: string; readonly recordId: string }>;

/** Identified graph nodes whose authoritative O3 versions fence an offline mutation. */
const mutationRowReferences = (
	catalog: CollectionCatalog,
	collection: string,
	values: Readonly<Record<string, Schema.Json>>
): ReadonlyArray<MutationRowReference> => {
	const references: Array<MutationRowReference> = [];
	const visit = (name: string, row: Readonly<Record<string, Schema.Json>>): void => {
		const id = row['id'];
		if (typeof id === 'string' && id.length > 0) references.push({ collection: name, recordId: id });
		for (const relation of catalog[name]?.relationships ?? []) {
			if (relation.cardinality !== 'many') continue;
			const children = row[relation.name];
			if (!Array.isArray(children)) continue;
			for (const child of children) {
				if (child !== null && typeof child === 'object' && !Array.isArray(child))
					visit(relation.target, child as Readonly<Record<string, Schema.Json>>);
			}
		}
	};
	visit(collection, values);
	return references;
};

const groupsFrom = (value: Schema.Json | undefined): GroupedJsonRows | undefined => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
	const groups = Reflect.get(value, 'groups');
	if (groups === null || typeof groups !== 'object' || Array.isArray(groups)) return undefined;
	for (const rows of Object.values(groups)) if (!Array.isArray(rows)) return undefined;
	return groups as GroupedJsonRows;
};

const projectedGroupsFrom = (
	value: Schema.Json | undefined,
	input: Schema.Json
): GroupedJsonRows | undefined => {
	const groups = groupsFrom(value);
	if (groups === undefined) return undefined;
	const query = asJsonRecord(input);
	return Object.fromEntries(
		Object.entries(groups).map(([key, rows]) => [
			key,
			projectCollectionQueryRows(
				rows as ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
				query['columns'],
				query['with']
			)
		])
	);
};

const cursorFrom = (value: Schema.Json | undefined): string | null => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const cursor = Reflect.get(value, 'pageCursor') ?? Reflect.get(value, 'nextCursor');
		return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
	}
	return null;
};

/** Adapts the Promise-based public Bolt client once at the Effect-native runtime boundary. */
const commandEffect = (
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	signal?: AbortSignal
): Effect.Effect<Schema.Json, unknown> =>
	Effect.tryPromise({
		try: () => runtime.bolt.command(command, input, Schema.Json, signal),
		catch: (cause) => cause
	});

const collectionWindowKind = (
	command: string
): 'findMany' | 'count' | 'findGrouped' | undefined => {
	if (command === 'collections.findMany') return 'findMany';
	if (command === 'collections.count') return 'count';
	if (command === 'collections.findGrouped') return 'findGrouped';
	return undefined;
};

const ApprovalCapabilityInput = Schema.Struct({ requestId: Schema.NonEmptyString });
const ApprovalCapabilityRows = Schema.Array(
	Schema.Struct({
		id: Schema.NonEmptyString,
		status: Schema.NonEmptyString,
		canDecide: Schema.Boolean,
		canSupersede: Schema.Boolean,
		canWithdraw: Schema.Boolean
	})
);

const decodedCommandEffect = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	output: Output,
	signal?: AbortSignal
): Effect.Effect<Output['Type'], unknown> =>
	Effect.tryPromise({
		try: () => runtime.bolt.command(command, input, output, signal),
		catch: (cause) => cause
	});

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
		signal?: AbortSignal,
		afterRemote?: (
			value: Output['Type'],
			flight?: WindowFlight
		) => Effect.Effect<void, never>
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
						collections: collectionsFor(command, input),
						// Private runtime collections used by Bolt's internal shell still use the ordinary
						// live-query registry so their registered `collections.findMany` reads can re-execute
						// when the authenticated source advances. Their
						// server-only page is never a replica window, though, and must not become a second
						// durable copy in IndexedDB merely because all queries share this cache seam.
						retain: (value: Schema.Json) => asJsonRecord(value)['serverOnly'] !== true
					};
		/**
		 * The replica answers first when it can, and declines by returning `undefined` — at which point
		 * this is exactly the request it always was. Replica-backed answers use the shared durable cache;
		 * a response the server marks private remains registered for live invalidation but memory-only.
		 */
		return createRemoteQuery(
			(attempt: RemoteQueryAttempt) =>
				Effect.gen(function* () {
					const checked = yield* Schema.decodeUnknownEffect(inputSchema)(input);
					const reader = runtime.local?.current;
					const answered =
						reader === undefined ? undefined : yield* reader.answer(command, checked);
					if (answered !== undefined) {
						const state = runtimeStates.access(runtime);
						for (const [token, tracked] of state?.visibleQueries ?? []) {
							if (cacheKeyFor(tracked.command, tracked.input) !== cacheKeyFor(command, checked)) {
								continue;
							}
								if (
									tracked.queryKey !== undefined &&
									tracked.queryKey !== answered.queryKey
								) {
									// This releases both the canonical window mount and its physical profile lease.
									// The new key is mounted below and trackVisibleQuery then acquires its exact lease.
									if (state?.releaseVisibleQuery !== undefined) state.releaseVisibleQuery(token);
									else tracked.releaseWindow?.();
								} else {
									tracked.releaseWindow?.();
								}
								tracked.queryKey = answered.queryKey;
								tracked.lastAccessAt = Date.now();
							const releaseWindow = state?.partitionSync?.mountWindow(
								answered.queryKey,
								answered.dependencies,
								// Only a getter read in a visible document promotes this platform mount to P0.
								tracked.visibility,
								{ relationDependency: answered.relationDependency }
							);
							if (releaseWindow === undefined) delete tracked.releaseWindow;
							else tracked.releaseWindow = releaseWindow;
							state?.trackVisibleQuery?.(token);
						}
						const stale =
							answered.status === 'stale' ||
							(answered.proofOwner === 'server' &&
								state?.syncStatus.current().offlineRetainedOnly === true);
						if (stale) {
							state?.staleWindowKeys.add(answered.queryKey);
							state?.syncStatus.patch({
								staleServerProofWindows: state.staleWindowKeys.size
							});
							state?.partitionSync?.requestRefill(answered.queryKey);
						} else if (state?.staleWindowKeys.delete(answered.queryKey) === true) {
							state.syncStatus.patch({
								staleServerProofWindows: state.staleWindowKeys.size
							});
						}
						const decoded = yield* Schema.decodeUnknownEffect(outputSchema)(answered.value);
							return decoded;
					}
					const flight =
						collectionWindowKind(command) === undefined
							? undefined
							: yield* beginAuthoritativeQueryFlight(runtime, command, checked);
					const attempted = yield* Effect.result(
						decodedCommandEffect(runtime, command, checked, outputSchema, signal)
					);
					if (Result.isFailure(attempted)) {
						if (flight !== undefined)
							runtimeStates.access(runtime)?.partitionSync?.cancelWindowFlight(flight);
						return yield* Effect.fail(attempted.failure);
					}
					const remote = attempted.success;
					// A superseded response may still warm transport caches, but it cannot install a
					// window/proof that would outlive the newer request which replaced it.
					if (afterRemote !== undefined && attempt.isCurrent()) yield* afterRemote(remote, flight);
					else if (flight !== undefined)
						runtimeStates.access(runtime)?.partitionSync?.cancelWindowFlight(flight);
						return remote;
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
		const query = RemoteQueries.make(
			runtime,
			command,
			input,
			Schema.Json,
			Schema.Json,
			undefined,
			(value, flight) =>
				Effect.sync(() => captureAuthoritativeQuery(runtime, command, input, value, flight))
		);
		const projected = projectRemoteQuery(
			query,
			(value) => projectedVisibleRowsFrom(value, input),
			(value) => projectedVisibleRowsFrom(value, input) ?? []
		);
		let visibleToken: string | undefined;
		const page: CollectionPageQuery<ReadonlyArray<Schema.Json>> = {
			get current() {
				touchVisibleQuery(runtime, visibleToken);
				return projected.current;
			},
			get nextCursor() {
				touchVisibleQuery(runtime, visibleToken);
				return cursorFrom(query.current);
			},
			get error() {
				touchVisibleQuery(runtime, visibleToken);
				return query.error;
			},
			get loading() {
				touchVisibleQuery(runtime, visibleToken);
				return query.loading;
			},
			then: projected.then
		};
		visibleToken = trackVisibleQuery(runtime, command, input, page);
		return page;
	}
};

const CountQueries = {
	make: (runtime: WorkspaceClientRuntime, input: Schema.Json): RemoteQuery<number> => {
		const query = RemoteQueries.make(
			runtime,
			'collections.count',
			input,
			Schema.Json,
			Schema.Json,
			undefined,
			(value, flight) =>
				Effect.sync(() => captureAuthoritativeQuery(runtime, 'collections.count', input, value, flight))
		);
		const projected = projectRemoteQuery(query, countFrom, (value) => {
			const count = countFrom(value);
			if (count === undefined) throw new Error('Collection count completed without a value');
			return count;
		});
		let visibleToken: string | undefined;
		const counted: RemoteQuery<number> = {
			get current() {
				touchVisibleQuery(runtime, visibleToken);
				return projected.current;
			},
			get error() {
				touchVisibleQuery(runtime, visibleToken);
				return query.error;
			},
			get loading() {
				touchVisibleQuery(runtime, visibleToken);
				return query.loading;
			},
			then: projected.then
		};
		visibleToken = trackVisibleQuery(runtime, 'collections.count', input, counted);
		return counted;
	}
};

const GroupedQueries = {
	make: (
		runtime: WorkspaceClientRuntime,
		collection: string,
		input: Schema.Json,
		options?: QueryOptions
	): RemoteQuery<GroupedJsonRows> => {
		const merged = mergeWhere(asJsonRecord(input), options);
		const groupedInput: Schema.Json = { collection, ...merged };
		const source = RemoteQueries.make(
			runtime,
			'collections.findGrouped',
			groupedInput,
			Schema.Json,
			Schema.Json,
			undefined,
			(value, flight) =>
				Effect.sync(() =>
					captureAuthoritativeQuery(
						runtime,
						'collections.findGrouped',
						groupedInput,
						value,
						flight
					)
				)
		);
		const projected = projectRemoteQuery(
			source,
			(value) => projectedGroupsFrom(value, groupedInput),
			(value) => {
				const groups = projectedGroupsFrom(value, groupedInput);
				if (groups === undefined) throw new Error('Grouped collection query completed without groups');
				return groups;
			}
		);
		let visibleToken: string | undefined;
		const grouped: RemoteQuery<GroupedJsonRows> = {
			get current() {
				touchVisibleQuery(runtime, visibleToken);
				return projected.current;
			},
			get error() {
				touchVisibleQuery(runtime, visibleToken);
				return source.error;
			},
			get loading() {
				touchVisibleQuery(runtime, visibleToken);
				return source.loading;
			},
			then: projected.then
		};
		visibleToken = trackVisibleQuery(runtime, 'collections.findGrouped', groupedInput, grouped);
		return grouped;
	}
};

type InvokeMethod = ReturnType<() => (input: Schema.Json) => RemoteQuery<Schema.Json>>;
const AutomationStartResponse = Schema.Struct({ taskId: Schema.NonEmptyString });
const AutomationStopResponse = Schema.Struct({ stopped: Schema.Literal(true) });
const AutomationResumeResponse = Schema.Struct({ resumed: Schema.Literal(true) });
const AutomationRunRow = Schema.Struct({
	task_id: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'paused', 'resuming', 'running', 'done', 'failed']),
	attempts: Schema.Number,
	max_attempts: Schema.Number,
	error: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Schema.Json),
	progress: Schema.NullOr(
		Schema.Struct({ progress: Schema.Number, text: Schema.NullOr(Schema.String) })
	),
	progress_sequence: Schema.Number,
	progress_updated_at: Schema.NullOr(Schema.String),
	next_run_at: Schema.NullOr(Schema.String)
});
type AutomationRunRow = Schema.Schema.Type<typeof AutomationRunRow>;
const projectAutomationRun = (row: AutomationRunRow | null): AutomationTaskSnapshot | null =>
	row === null
		? null
		: {
				status: row.status,
				attempts: row.attempts,
				maxAttempts: row.max_attempts,
				error: row.error,
				result: row.result,
				progress: row.progress,
				progressSequence: row.progress_sequence,
				progressUpdatedAt: row.progress_updated_at,
				nextRunAt: row.next_run_at
			};

/** Stable per-name automation state; the generated declaration supplies the exact registry. */
const automationClient = (runtime: WorkspaceClientRuntime) => {
	const surfaces = new Map<string, unknown>();
	return new Proxy<Record<string, unknown>>(
		{},
		{
			get: (_target, property) => {
				if (typeof property !== 'string') return undefined;
				const existing = surfaces.get(property);
				if (existing !== undefined) return existing;
				const state = new AutomationExecutionState(
					(input) =>
						decodedCommandEffect(
							runtime,
							'automations.start',
							{ name: property, input },
							AutomationStartResponse
						),
					(taskId) => {
						const page = PageQueries.make(runtime, 'collections.findMany', {
							collection: 'automation_run',
							where: { task_id: { eq: taskId } },
							limit: 1
						});
						const source = projectRemoteQuery(
							page,
							(rows) => rows[0] === undefined
								? null
								: Schema.decodeUnknownSync(AutomationRunRow)(rows[0]),
							(rows) => rows[0] === undefined
								? null
								: Schema.decodeUnknownSync(AutomationRunRow)(rows[0])
						);
						const project = (row: AutomationRunRow | null) => {
							if (row !== null) {
								void runtimeStates
									.access(runtime)
									?.automationObserved?.(taskId, row.status)
									.catch(() => undefined);
							}
							return projectAutomationRun(row);
						};
						return projectRemoteQuery(source, project, project);
					},
					(taskId) =>
						decodedCommandEffect(
							runtime,
							'automations.stop',
							{ name: property, taskId },
							AutomationStopResponse
						).pipe(Effect.asVoid),
					(taskId) =>
						decodedCommandEffect(
							runtime,
							'automations.resume',
							{ name: property, taskId },
							AutomationResumeResponse
						).pipe(Effect.asVoid)
				);
				const created = {
					run: state.run,
					stop: state.stop,
					resume: state.resume,
					get pending() {
						return state.pending;
					},
					get latest() {
						return state.latest;
					}
				};
				surfaces.set(property, created);
				return created;
			}
		}
	);
};

export type WorkspaceApiVisibility = Readonly<{
	/** Exact generic collection names published through this proxy. Omission means framework-internal. */
	readonly allowedCollections?: ReadonlyArray<string>;
	/** Published read surfaces whose framework-owned writes remain structurally absent. */
	readonly readOnlyCollections?: ReadonlyArray<string>;
	/** System commands are a Bolt shell capability, not part of an authored workspace client. */
	readonly system?: boolean;
}>;

/** Groups workspace API construction with the stateful remote-query factory it exposes. */
const WorkspaceApis = {
	create: (
		runtime: WorkspaceClientRuntime,
		catalog: CollectionCatalog = {},
		visibility: WorkspaceApiVisibility = {}
	) => {
		const state = runtimeStates.access(runtime);
		if (state !== undefined) state.catalog = catalog;
		const allowedCollections =
			visibility.allowedCollections === undefined
				? undefined
				: new Set(visibility.allowedCollections);
		const readOnlyCollections = new Set(visibility.readOnlyCollections ?? []);
		const collectionAllowed = (collection: string): boolean =>
			allowedCollections === undefined || allowedCollections.has(collection);
		const assertCollectionAllowed = (collection: string): void => {
			if (!collectionAllowed(collection))
				throw new Error(`Collection ${JSON.stringify(collection)} is private to the Bolt runtime`);
		};
		const publicApi = {
		db: ClientDatabase.database(runtime, catalog, allowedCollections, readOnlyCollections),
		automations: automationClient(runtime),
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
					if (!collectionAllowed(property)) return undefined;
					return catalog[property] ?? { name: property, fields: [], relationships: [] };
				}
			}
		),
		records: {
			findMany: (collection: string, input: Schema.Json = {}) => {
				assertCollectionAllowed(collection);
				return PageQueries.make(runtime, 'collections.findMany', {
					collection,
					...asJsonRecord(input)
				});
			}
		},
		history: {
			findMany: (collection: string, recordId: string) => {
				assertCollectionAllowed(collection);
				return RemoteQueries.make(
					runtime,
					'collections.history',
					{ collection, id: recordId },
					Schema.Json,
					Schema.Json
				);
			}
		},
		approvals: {
			findMany: (approvalId: string) =>
				RemoteQueries.make(
					runtime,
					'approvals.capabilities',
					{ requestId: approvalId },
					ApprovalCapabilityInput,
					ApprovalCapabilityRows
				),
			process: (input: {
				readonly approvalRequestId: string;
				readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED';
				readonly comments?: string;
			}) =>
				Effect.runPromise(
					Effect.gen(function* () {
						const state = yield* commandEffect(runtime, 'approvals.status', {
							requestId: input.approvalRequestId
						});
						const decision =
							input.action === 'SUPERSEDED'
								? 'supersede'
								: input.action === 'APPROVED'
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
						yield* invalidateApproval(runtime);
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
						yield* invalidateApproval(runtime);
					})
				)
		}
		};
		if (visibility.system === false) return publicApi;
		return {
			...publicApi,
			system: createSystemClient(runtime, (command, input, inputSchema, outputSchema, signal) =>
				RemoteQueries.make(runtime, command, input, inputSchema, outputSchema, signal)
			)
		};
	}
};

type WorkspaceApi = ReturnType<typeof WorkspaceApis.create>;
type PublicWorkspaceApi = Omit<WorkspaceApi, 'system'>;
type InternalWorkspaceApi = WorkspaceApi & {
	readonly system: ReturnType<typeof createSystemClient>;
};

export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	visibility: WorkspaceApiVisibility & { readonly system: false }
): PublicWorkspaceApi;
export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog?: CollectionCatalog,
	visibility?: WorkspaceApiVisibility
): InternalWorkspaceApi;
export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog = {},
	visibility: WorkspaceApiVisibility = {}
): WorkspaceApi {
	return WorkspaceApis.create(runtime, catalog, visibility);
}

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
 * Drops every cached answer and re-runs every live query, after an approval decision.
 *
 * An approval decision is not a `db.*` write, so it never passed through `invalidateWrite`. The one
 * table that happened to own the open sheet reloaded its own rows by hand, and every other surface
 * showing the same record — a board, a second table, a nested sheet — stayed stale until something
 * else refetched. The decision cannot name a collection, so withdraw every dependency actually held
 * by the durable window ledger; the arbitrary-command cache marker remains cache-only.
 */
const invalidateApproval = (runtime: WorkspaceClientRuntime): Effect.Effect<void, unknown> => {
	const state = runtimeStates.access(runtime);
	const ledger = state?.windowLedger;
	return (ledger === undefined ? Effect.succeed([]) : ledger.dependencies()).pipe(
		Effect.flatMap((dependencies) =>
			(state?.invalidateCoverage?.(dependencies) ?? Effect.void).pipe(
				Effect.andThen(Effect.sync(() => {
					const affected = [...new Set([...dependencies, ARBITRARY_QUERY_INVALIDATION])];
					invalidateRuntime(runtime, affected);
					state?.invalidation?.announce(affected);
				}))
			)
		)
	);
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
			findFirst: (input: Schema.Json = {}) => {
				const page = PageQueries.make(runtime, 'collections.findMany', {
					collection,
					...asJsonRecord(input),
					limit: 1
				});
				return projectRemoteQuery(
					page,
					(rows) => rows[0],
					(rows) => rows[0]
				);
			},
			findGrouped: (input: Schema.Json, options?: QueryOptions) =>
				GroupedQueries.make(runtime, collection, input, options),
			count: (input: Schema.Json = {}, options?: QueryOptions) =>
				CountQueries.make(runtime, { collection, ...mergeWhere(asJsonRecord(input), options) }),
			/**
			 * Synchronizes one declarative graph.
			 *
			 * An included relationship is its complete desired state; omission leaves it untouched. The
			 * server performs the recursive reconciliation atomically. The browser submits the graph as one
			 * operation and does no handwritten relational diffing. It also does not require a stored-row
			 * readback: a write-only policy can authorize this command while denying
			 * the corresponding read. Query invalidation makes a readable stored value the query's concern.
			 */
			mutate: (input: Schema.Json) => {
				const values = asJsonRecord(input);
				return mutation.run(
					Effect.gen(function* () {
						const state = runtimeStates.access(runtime);
						const serverPartitionKey = state?.serverPartitionKey;
						const localActorBinding = state?.partitionKey;
						if (
							serverPartitionKey === undefined ||
							localActorBinding === undefined ||
							state?.reflectLocalMutation === undefined ||
							state.readRowVersions === undefined
						)
							return yield* Effect.fail(
								new Error('The authoritative sync partition is not ready; wait for workspace sync before mutating.')
							);
						const rowVersions = yield* Effect.tryPromise(() =>
							state.readRowVersions?.(mutationRowReferences(catalog, collection, values)) ??
							Promise.resolve(new Map<string, number>())
						);
						const prepared = yield* Effect.try(() =>
							prepareLocalCollectionMutation({
								catalog,
								collection,
								values,
								serverPartitionKey,
								localActorBinding,
								rowVersion: (name, id) => rowVersions.get(`${name}\u0000${id}`)
							})
						);
						const journal = yield* Effect.tryPromise(() => mutationJournalFor(runtime));
						const reserved = yield* Effect.tryPromise(() => journal.reserve(prepared.draft));
						// Reservation is the public durability boundary. Lease/profile or local projection failures
						// may reduce offline UX, but cannot turn an already-durable mutation into a rejected call.
						yield* Effect.promise(async () => {
							try {
								await state.refreshOverlaySnapshot?.();
							} catch (cause) {
								state.reportError?.(cause);
								// The durable subscription will refresh the projection snapshot on its next turn.
							}
							try {
								await acquireReplicaPendingMutationLease(runtime, reserved.idempotencyKey);
							} catch (cause) {
								state.reportError?.(cause);
								void acquireReplicaPendingMutationLease(runtime, reserved.idempotencyKey)
									.catch((retryCause) => state.reportError?.(retryCause));
								// The journal itself remains the durable source and protects the overlay rows.
							}
							try {
								await state.reflectLocalMutation?.(prepared.affectedCollections);
							} catch (cause) {
								state.reportError?.(cause);
								void state.reflectLocalMutation?.(prepared.affectedCollections)
									.catch((retryCause) => state.reportError?.(retryCause));
								// The next journal subscription/stream turn retries projection from durable O4.
							}
						});
						state.scheduleMutationPush?.();
						return locallyDurableMutationResult(journal, reserved, prepared.projectedRow);
					})
				);
			},
			get pending() {
				return mutation.pending;
			}
		};
	},
	database: (
		runtime: WorkspaceClientRuntime,
		catalog: CollectionCatalog,
		allowedCollections?: ReadonlySet<string>,
		readOnlyCollections: ReadonlySet<string> = new Set()
	): Readonly<Record<string, unknown>> => {
		const collections = new Map<string, unknown>();
		return new Proxy<Record<string, unknown>>(
			{},
			{
				get: (_target, property) => {
					if (typeof property !== 'string') return undefined;
					if (allowedCollections !== undefined && !allowedCollections.has(property)) return undefined;
					const existing = collections.get(property);
					if (existing !== undefined) return existing;
					const complete = ClientDatabase.collection(runtime, catalog, property);
					const created = readOnlyCollections.has(property)
						? new Proxy(complete, {
								get: (target, member, receiver) =>
									member === 'mutate' || member === 'pending'
										? undefined
										: Reflect.get(target, member, receiver),
								has: (target, member) =>
									member !== 'mutate' && member !== 'pending' && Reflect.has(target, member),
								ownKeys: (target) =>
									Reflect.ownKeys(target).filter(
										(member) => member !== 'mutate' && member !== 'pending'
									),
								getOwnPropertyDescriptor: (target, member) =>
									member === 'mutate' || member === 'pending'
										? undefined
										: Reflect.getOwnPropertyDescriptor(target, member)
							})
						: complete;
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
 * Provisioning creates only the tenant schema and proof ledger. Authoritative queries hydrate
 * bounded windows, while the partition stream advances their shared base and proofs.
 */
/**
 * The replicas already running in this document, keyed by their runtime and scope.
 *
 * Starting one is expensive and not idempotent: it opens a PGlite engine and a partition stream
 * stream. Two callers for the same scope therefore meant two engines
 * over one storage directory and two streams holding host connections — and two callers is the
 * ordinary case, because a component that remounts asks again for something it cannot see it already
 * has. Handing back the running one makes "start the replica" the idempotent request every caller
 * already assumed it was.
 *
 * Distinct runtimes deliberately get distinct PGlite worker clients. The workers still elect one
 * database leader for the shared scope, while each runtime retains the invalidation endpoint tied to
 * its own cache and live-query registry. This matters after HMR replaces the generated client: handing
 * the new runtime the old runtime's replica makes the database look healthy while every newly mounted
 * query remains outside the registry receiving sync advances.
 */
type RuntimeAccessState = {
	current: string;
	catalog: CollectionCatalog;
	schemaFingerprint?: string;
	serverPartitionKey?: string;
	syncStatus: MutableWorkspaceSyncStatusSignal;
	staleWindowKeys: Set<string>;
	partitionSync?: PartitionSyncCoordinator;
	windowLedger?: WindowLedger;
	mutationJournal?: Promise<CollectionMutationJournal>;
	mutationJournalUnsubscribe?: () => void;
	refreshMutationStatus?: () => Promise<void>;
	refreshOverlaySnapshot?: () => Promise<void>;
	scheduleMutationPush?: () => void;
	stopMutationPush?: () => void;
	rebootstrapPartition?: () => Promise<void>;
	reflectLocalMutation?: (collections: ReadonlyArray<string>) => Promise<void>;
	cache: QueryCache;
	partitionKey?: string;
	invalidation?: ReturnType<typeof openReplicaInvalidationBus>;
	materializeQuery?: (query: AuthoritativeQueryCapture) => void;
	invalidateCoverage?: (collections: ReadonlyArray<string>) => Effect.Effect<void>;
	schemaControl?: (control: ReplicaSchemaControl) => void;
	visibleQueries: Map<
		string,
		{
			readonly owner: WeakRef<object>;
			readonly command: string;
			readonly input: Schema.Json;
			lastAccessAt: number;
			visibility: ReplicaWindowVisibility;
			queryKey?: string;
			releaseWindow?: PartitionWindowMount;
		}
	>;
	trackVisibleQuery?: (token: string) => void;
	releaseVisibleQuery?: (token: string) => void;
	requestAdjacentHydration?: (queryKey: string) => void;
	acquirePendingMutationLease?: (stableLeaseId: string) => Promise<void>;
	releasePendingMutationLease?: (stableLeaseId: string) => Promise<void>;
	readRowVersions?: (
		references: ReadonlyArray<MutationRowReference>
	) => Promise<ReadonlyMap<string, number>>;
	automationStarted?: (taskId: string) => Promise<void>;
	automationObserved?: (taskId: string, status: ReplicaAutomationStatus) => Promise<void>;
	automationSettled?: (taskId: string) => Promise<void>;
	progressListeners: Set<(progress: ReplicaBootstrapProgress) => void>;
	progress: ReplicaBootstrapProgress;
	reportError?: (cause: unknown) => void;
};

type AuthoritativeQueryCapture = Readonly<{
	readonly key: string;
	readonly command: string;
	readonly input: Schema.Json;
	readonly value: Schema.Json;
	readonly flight?: WindowFlight;
}>;

type ReplicaBootstrapProgress = Readonly<{
	readonly phase: 'preparing' | 'loading' | 'applying';
	readonly completed?: number;
	readonly total?: number;
	readonly unit?: 'rows' | 'bytes';
}>;

/** Captures one exact server query proof without delaying the response that paints it. */
function captureAuthoritativeQuery(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	value: Schema.Json,
	flight?: WindowFlight
): void {
	if (collectionWindowKind(command) === undefined) return;
	const state = runtimeStates.access(runtime);
	if (state === undefined) return;
	const query: AuthoritativeQueryCapture = {
		key: cacheKeyFor(command, input),
		command,
		input,
		value,
		...(flight === undefined ? {} : { flight })
	};
	state.materializeQuery?.(query);
}

/** Opens the per-window flight before the request so concurrent M1 deltas can be replayed after install. */
function beginAuthoritativeQueryFlight(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json
): Effect.Effect<WindowFlight | undefined, never> {
	const state = runtimeStates.access(runtime);
	const coordinator = state?.partitionSync;
	const partitionKey = state?.serverPartitionKey;
	const schemaFingerprint = state?.schemaFingerprint;
	if (
		state === undefined ||
		coordinator === undefined ||
		partitionKey === undefined ||
		schemaFingerprint === undefined
	)
		return Effect.succeed(undefined);
	const kind = collectionWindowKind(command);
	if (kind === undefined) return Effect.succeed(undefined);
	return describeClientQueryWindow(
		kind,
		asJsonRecord(input),
		state.catalog,
		{
			protocolVersion: PROTOCOL_VERSION,
			schemaFingerprint,
			partitionKey
		},
		// Reproducibility does not enter the flight key; the materializer below applies the readable-
		// field gate before it installs proof ownership.
		{ pinnedCollation: true, localRelationships: true, localSearch: true }
	).pipe(
		Effect.map((description) =>
			description === undefined
				? undefined
				: coordinator.beginWindowFlight(description.queryKey, description.dependencies)
		),
		Effect.catch(() => Effect.succeed(undefined))
	);
}

const publishReplicaProgress = (state: RuntimeAccessState, progress: ReplicaBootstrapProgress): void => {
	state.progress = progress;
	for (const listener of state.progressListeners) listener(progress);
};

type ResolvedReplicaPartition = Readonly<{
	readonly identity: ReplicaPartitionIdentity;
	readonly key: string;
	readonly principalSource: 'principal';
}>;

const RuntimeStates = {
	make: () => {
		const replicas = new WeakMap<
			WorkspaceClientRuntime,
			Map<string, Effect.Effect<LocalReplica, unknown>>
		>();
		const accessStates = new WeakMap<WorkspaceClientRuntime, RuntimeAccessState>();
		return {
			replica: (runtime: WorkspaceClientRuntime, key: string) => replicas.get(runtime)?.get(key),
			rememberReplica: (
				runtime: WorkspaceClientRuntime,
				key: string,
				replica: Effect.Effect<LocalReplica, unknown>
			) => {
				const owned = replicas.get(runtime) ?? new Map();
				owned.set(key, replica);
				replicas.set(runtime, owned);
			},
			forgetReplica: (runtime: WorkspaceClientRuntime, key: string) => {
				const owned = replicas.get(runtime);
				owned?.delete(key);
				if (owned?.size === 0) replicas.delete(runtime);
			},
			stopReplicas: (runtime: WorkspaceClientRuntime) => {
				const owned = replicas.get(runtime);
				if (owned === undefined) return;
				replicas.delete(runtime);
				for (const replica of owned.values()) {
					void Effect.runPromise(replica).then(
						(opened) => opened.stop(),
						() => undefined
					);
				}
			},
			access: (runtime: WorkspaceClientRuntime) => accessStates.get(runtime),
			rememberAccess: (runtime: WorkspaceClientRuntime, state: RuntimeAccessState) => {
				accessStates.set(runtime, state);
			}
		};
	}
};

const runtimeStates = RuntimeStates.make();

let visibleQuerySequence = 0;
const VISIBLE_QUERY_PRIORITY_EVIDENCE_MILLIS = 2_000;
const visibleQueryFinalizer =
	typeof FinalizationRegistry === 'undefined'
		? undefined
		: new FinalizationRegistry<Readonly<{ runtime: WorkspaceClientRuntime; token: string }>>(
				({ runtime, token }) => {
					const state = runtimeStates.access(runtime);
					state?.releaseVisibleQuery?.(token);
					state?.visibleQueries.delete(token);
				}
			);

/** Tracks a page object's actual reachability, rather than treating every page ever seen as visible. */
function trackVisibleQuery(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	owner: object
): string | undefined {
	const state = runtimeStates.access(runtime);
	if (state === undefined) return undefined;
	visibleQuerySequence += 1;
	const token = `collection-query:${visibleQuerySequence}`;
	state.visibleQueries.set(token, {
		owner: new WeakRef(owner),
		command,
		input,
		lastAccessAt: Date.now(),
		visibility: 'unknown'
	});
	visibleQueryFinalizer?.register(owner, { runtime, token });
	state.trackVisibleQuery?.(token);
	return token;
}

const touchVisibleQuery = (runtime: WorkspaceClientRuntime, token: string | undefined): void => {
	if (token === undefined) return;
	const state = runtimeStates.access(runtime);
	const tracked = state?.visibleQueries.get(token);
	if (tracked === undefined) return;
	tracked.lastAccessAt = Date.now();
	tracked.visibility =
		typeof document !== 'undefined' && document.visibilityState === 'visible'
			? 'visible'
			: 'hidden';
	tracked.releaseWindow?.setVisibility(tracked.visibility);
	if (tracked.queryKey !== undefined) state?.requestAdjacentHydration?.(tracked.queryKey);
};

const normalizedAccessScope = (value: string): string => value.trim() || 'operator';

let ephemeralCacheSequence = 0;
/**
 * Before WebCrypto resolves the principal fingerprint, persisted reuse would be unsafe. A
 * document-unique namespace keeps this early cache memory/persistence isolated and is replaced by
 * the complete partition namespace before local readers or cross-tab messaging are installed.
 */
const ephemeralCacheNamespace = (): string => {
	ephemeralCacheSequence += 1;
	return `bolt-ephemeral-partition:${Date.now()}:${ephemeralCacheSequence}`;
};

const legacyReplicaCompatibilityMarker = (partitionKey: string, fingerprint: string): string =>
	`bolt-replica-compatible:${partitionKey}:${encodeURIComponent(fingerprint)}`;

const replicaCompatibilityMarker = (
	tenantId: string,
	partitionKey: string,
	fingerprint: string
): string =>
	`bolt-replica-compatible:v1:${encodeURIComponent(tenantId)}:${encodeURIComponent(partitionKey)}:${encodeURIComponent(fingerprint)}`;

const persistedReplicaCompatibility = (
	tenantId: string,
	partitionKey: string,
	fingerprint: string
): boolean => {
	try {
		const marker = replicaCompatibilityMarker(tenantId, partitionKey, fingerprint);
		if (localStorage.getItem(marker) === 'ready') return true;
		const legacyMarker = legacyReplicaCompatibilityMarker(partitionKey, fingerprint);
		if (localStorage.getItem(legacyMarker) !== 'ready') return false;
		// Partition keys were already authority-issued. Migrate their earlier receipt only after the
		// authority has supplied the tenant that owns it, so existing replicas do not block once more.
		try {
			localStorage.setItem(marker, 'ready');
			localStorage.removeItem(legacyMarker);
		} catch {
			// The already-proven legacy receipt remains valid even if its best-effort migration fails.
		}
		return true;
	} catch {
		return false;
	}
};

const markReplicaCompatible = (
	tenantId: string,
	partitionKey: string,
	fingerprint: string
): void => {
	try {
		localStorage.setItem(replicaCompatibilityMarker(tenantId, partitionKey, fingerprint), 'ready');
	} catch {
		// This successful-bootstrap receipt is optional; the durable replica remains authoritative.
	}
};

const clearReplicaCompatibility = (
	tenantId: string,
	partitionKey: string,
	fingerprint: string
): void => {
	try {
		localStorage.removeItem(replicaCompatibilityMarker(tenantId, partitionKey, fingerprint));
		localStorage.removeItem(legacyReplicaCompatibilityMarker(partitionKey, fingerprint));
	} catch {
		// The database reset remains authoritative even when the receipt cannot be removed.
	}
};

const accessScopeFor = (runtime: WorkspaceClientRuntime): string =>
	runtimeStates.access(runtime)?.current ?? normalizedAccessScope(workspaceSession().accessScope);

/** Resolves the required stable principal without copying a bearer secret into browser metadata. */
const partitionFor = (
	runtime: WorkspaceClientRuntime,
	authority: string
): Promise<ResolvedReplicaPartition> => {
	const normalizedAuthority = normalizedAccessScope(authority);
	const session = workspaceSession();
	return fingerprintReplicaPrincipal(session.principal).then((principal) => {
		const identity: ReplicaPartitionIdentity = {
			tenant: runtime.bolt.scope.tenantId,
			environment: runtime.bolt.scope.environment,
			principal: principal.fingerprint,
			authority: normalizedAuthority,
			formatVersion: REPLICA_FORMAT_VERSION
		};
		return { identity, key: replicaPartitionKey(identity), principalSource: principal.source };
	});
};

const mutationJournals = new WeakMap<
	WorkspaceClientRuntime,
	Map<string, Promise<CollectionMutationJournal>>
>();

const mutationJournalKey = (
	localActorBinding: string,
	serverPartitionKey: string,
	schemaFingerprint: string
): string => `${localActorBinding}\u0000${serverPartitionKey}\u0000${schemaFingerprint}`;

const mutationJournalFor = async (
	runtime: WorkspaceClientRuntime
): Promise<CollectionMutationJournal> => {
	const state = runtimeStates.access(runtime);
	const partitionKey = state?.serverPartitionKey;
	const localActorBinding = state?.partitionKey;
	const schemaFingerprint = state?.schemaFingerprint;
	if (partitionKey === undefined || partitionKey.trim() === '')
		throw new Error('The authoritative sync partition is not ready for local mutation durability.');
	if (localActorBinding === undefined || localActorBinding.trim() === '')
		throw new Error('The authenticated local replica owner is not ready for mutation durability.');
	if (schemaFingerprint === undefined || schemaFingerprint.trim() === '')
		throw new Error('The authoritative sync schema is not ready for mutation durability.');
	if (state?.mutationJournal !== undefined) return state.mutationJournal;
	let owned = mutationJournals.get(runtime);
	if (owned === undefined) {
		owned = new Map();
		mutationJournals.set(runtime, owned);
	}
	const journalKey = mutationJournalKey(localActorBinding, partitionKey, schemaFingerprint);
	let journal = owned.get(journalKey);
	if (journal === undefined) {
		journal = createCollectionMutationJournal({
			serverPartitionKey: partitionKey,
			localActorBinding,
			schemaFingerprint
		});
		owned.set(journalKey, journal);
	}
	if (state !== undefined) state.mutationJournal = journal;
	return journal;
};

const knownMutationJournals = async (
	runtime: WorkspaceClientRuntime
): Promise<ReadonlyArray<CollectionMutationJournal>> => {
	await mutationJournalFor(runtime);
	const owned = mutationJournals.get(runtime);
	const localActorBinding = runtimeStates.access(runtime)?.partitionKey;
	if (owned === undefined || localActorBinding === undefined) return [];
	for (const identity of await discoverCollectionMutationJournals(localActorBinding)) {
		const key = mutationJournalKey(
			identity.localActorBinding,
			identity.serverPartitionKey,
			identity.schemaFingerprint
		);
		if (!owned.has(key)) owned.set(key, createCollectionMutationJournal(identity));
	}
	return Promise.all([...owned.values()]);
};

const protectedMutationRows = async (runtime: WorkspaceClientRuntime) => {
	const rows = (await Promise.all(
		(await knownMutationJournals(runtime)).map((journal) => journal.protectedRows())
	)).flat();
	return [...new Map(rows.map((row) => [`${row.collection}\u0000${row.recordId}`, row])).values()];
};

/** 408/425/429 and 5xx leave the server outcome unknown; other HTTP 4xx are terminal. */
const terminalMutationFailure = (cause: unknown): boolean => {
	if (cause === null || typeof cause !== 'object') return false;
	const status = Reflect.get(cause, 'status');
	return (
		typeof status === 'number' &&
		status >= 400 &&
		status < 500 &&
		status !== 408 &&
		status !== 425 &&
		status !== 429
	);
};

/** Invalidates this document's cache and mounted queries without rebroadcasting the message. */
const invalidateRuntime = (
	runtime: WorkspaceClientRuntime,
	collections: ReadonlyArray<string>
): void => {
	runtime.cache?.invalidate(collections);
	runtime.queries?.reexecuteAffected(collections);
};

/** Opens the invalidation endpoint owned by this runtime and its current authority. */
const openRuntimeInvalidation = (
	runtime: WorkspaceClientRuntime,
	state: RuntimeAccessState,
	physicalPartitionKey: string,
	localActorBinding: string
): void => {
	state.invalidation?.close();
	state.partitionKey = localActorBinding;
	state.invalidation = openReplicaInvalidationBus(
		physicalPartitionKey,
		(collections) => {
			invalidateRuntime(runtime, collections);
			void state.refreshMutationStatus?.();
			state.scheduleMutationPush?.();
		},
		undefined,
		(control) => state.schemaControl?.(control)
	);
};

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
	runtimeStates.stopReplicas(runtime);
	state.current = next;
	state.cache = createQueryCache(ephemeralCacheNamespace());
	state.stopMutationPush?.();
	state.mutationJournalUnsubscribe?.();
	delete state.mutationJournal;
	delete state.mutationJournalUnsubscribe;
	delete state.refreshMutationStatus;
	delete state.refreshOverlaySnapshot;
	delete state.scheduleMutationPush;
	delete state.stopMutationPush;
	delete state.rebootstrapPartition;
	delete state.reflectLocalMutation;
	delete state.serverPartitionKey;
	delete state.partitionSync;
	delete state.windowLedger;
	for (const token of state.visibleQueries.keys()) state.releaseVisibleQuery?.(token);
	state.visibleQueries.clear();
	delete state.materializeQuery;
	delete state.invalidateCoverage;
	delete state.schemaControl;
	delete state.trackVisibleQuery;
	delete state.releaseVisibleQuery;
	delete state.acquirePendingMutationLease;
	delete state.releasePendingMutationLease;
	delete state.readRowVersions;
	delete state.reportError;
	delete state.automationStarted;
	delete state.automationObserved;
	delete state.automationSettled;
	state.invalidation?.close();
	delete state.invalidation;
	delete state.partitionKey;
	if (runtime.local !== undefined) delete runtime.local.current;
	runtime.queries?.reexecuteAffected([ANY_COLLECTION]);
};

export type StartLocalReplicaOptions = Readonly<{
	readonly accessScope?: string;
	readonly onChange?: (applied: number) => void;
	readonly onError?: (cause: unknown) => void;
	/** Host/runtime hook for the wire-level schema barrier. Not an authoring API. */
	readonly schemaBarrier?: Omit<SchemaBarrierHooks, 'leader'>;
	/**
	 * Which storage tier the replica ended on, and — when that tier is `server-only` — why.
	 *
	 * The reason used to be computed and dropped. `selectReplicaStorage` distinguishes six distinct
	 * refusals and the election distinguishes three more, and every one of them arrived here as the
	 * bare word `server-only`, to a callback no caller supplied. A workspace with no browser replica
	 * at all was therefore indistinguishable from a healthy one except by the wording of a banner.
	 */
	readonly onStorageTier?: (tier: ReplicaStorageTier | 'custom', reason?: string) => void;
	/** Deletes an inactive physical PGlite location selected by the profile-wide eviction planner. */
	readonly deleteInactiveReplicaPartition?: (
		candidate: ReplicaProfileEvictionCandidate
	) => Promise<void>;
}>;

/** Protects the current physical replica while one durable mutation outcome is unknown. */
export const acquireReplicaPendingMutationLease = (
	runtime: WorkspaceClientRuntime,
	stableLeaseId: string
): Promise<void> => {
	if (stableLeaseId.trim() === '') return Promise.reject(new Error('Mutation lease id is empty'));
	return runtimeStates.access(runtime)?.acquirePendingMutationLease?.(stableLeaseId) ?? Promise.resolve();
};

/** Releases the exact durable mutation lease after acknowledgement or terminal rejection. */
export const releaseReplicaPendingMutationLease = (
	runtime: WorkspaceClientRuntime,
	stableLeaseId: string
): Promise<void> => {
	if (stableLeaseId.trim() === '') return Promise.reject(new Error('Mutation lease id is empty'));
	return runtimeStates.access(runtime)?.releasePendingMutationLease?.(stableLeaseId) ?? Promise.resolve();
};

const serverOnlyReplica = (
	partitionKey: string,
	principalSource: LocalReplica['principalSource'] = 'principal'
): LocalReplica => ({
	fingerprint: 'server-only',
	rows: 0,
	resumed: false,
	tier: 'server-only',
	partitionKey,
	principalSource,
	leader: () => false,
	clearAndRebuild: () => Promise.resolve(),
	initialCatchUpReady: Promise.resolve(),
	stop: () => undefined
});

const nativeWebLocks = (): WebLockManagerLike | undefined => {
	if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function')
		return undefined;
	return navigator.locks as unknown as WebLockManagerLike;
};

export const startLocalReplica = (
	runtime: WorkspaceClientRuntime,
	open?: (steps: ReadonlyArray<ProvisioningStepType>) => Effect.Effect<PGliteLike, unknown>,
	options: StartLocalReplicaOptions = {}
) => {
	const accessScope = normalizedAccessScope(options.accessScope ?? accessScopeFor(runtime));
	switchWorkspaceAccessScope(runtime, accessScope);
	return Effect.runPromise(
		Effect.gen(function* () {
			const partition = yield* Effect.tryPromise(() => partitionFor(runtime, accessScope)).pipe(
				Effect.catch((cause) => {
					options.onError?.(cause);
					return Effect.succeed(undefined);
				})
			);
			if (partition === undefined) {
				options.onStorageTier?.('server-only', 'The replica partition identity could not be resolved');
				return serverOnlyReplica(ephemeralCacheNamespace());
			}
			const serverPartitionStatus = yield* commandEffect(runtime, 'sync.partition', {}).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(SyncPartitionStatusResponse))
			);
			const serverPartition = serverPartitionStatus.partition;
			if (accessScopeFor(runtime) !== accessScope)
				return yield* Effect.fail(new Error('Local replica access scope changed during startup'));

			const accessState = runtimeStates.access(runtime);
			if (accessState !== undefined && accessState.serverPartitionKey !== serverPartition.key) {
				accessState.cache = createQueryCache(serverPartition.key);
				accessState.serverPartitionKey = serverPartition.key;
				accessState.schemaFingerprint = serverPartition.schemaFingerprint;
				openRuntimeInvalidation(runtime, accessState, serverPartition.key, partition.key);
			}

			const key = serverPartition.key;
			let running = runtimeStates.replica(runtime, key);
			if (running === undefined) {
				let leadership: ReplicationLeadership | undefined;
				let profileIndex: ReplicaProfileIndex | undefined;
				let physicalLease: ReplicaPhysicalPartitionLease | undefined;
				const startup = Effect.gen(function* () {
					let storage: ReplicaStorageDecision | undefined;
					if (open === undefined) {
						storage = yield* Effect.tryPromise(() => selectReplicaStorage());
						if (storage.tier === 'server-only') {
							options.onStorageTier?.('server-only', storage.reason);
							return serverOnlyReplica(serverPartition.key, partition.principalSource);
						}
						profileIndex = yield* Effect.tryPromise(() => openBrowserReplicaProfileIndex()).pipe(
							Effect.catch((cause) => {
								options.onError?.(cause);
								return Effect.succeed(undefined);
							})
						);
						if (profileIndex === undefined) {
							options.onStorageTier?.(
								'server-only',
								'The browser replica profile index could not be opened'
							);
								return serverOnlyReplica(serverPartition.key, partition.principalSource);
						}
						const locks = nativeWebLocks();
						if (locks === undefined) {
							profileIndex.close();
							profileIndex = undefined;
							options.onStorageTier?.(
								'server-only',
								'This browser exposes no Web Locks manager'
							);
								return serverOnlyReplica(serverPartition.key, partition.principalSource);
							}
							const partitionId = replicaProfilePartitionId(serverPartition.key, storage.tier);
						physicalLease = openReplicaPhysicalPartitionLease(
							partitionId,
							locks as unknown as ReplicaStorageLockManager
						);
						yield* Effect.tryPromise(() => physicalLease?.ready ?? Promise.resolve());
							const elected = openReplicationLeadership(serverPartition.key, locks);
						leadership = elected;
						yield* Effect.promise(() => elected.ready);
						if (elected.failed()) {
							elected.stop();
							yield* Effect.tryPromise(() => physicalLease?.stop() ?? Promise.resolve());
							physicalLease = undefined;
							profileIndex.close();
							profileIndex = undefined;
							options.onStorageTier?.(
								'server-only',
								'The replication leadership election was refused by the lock manager'
							);
								return serverOnlyReplica(serverPartition.key, partition.principalSource);
						}
						options.onStorageTier?.(storage.tier);
					} else {
						options.onStorageTier?.('custom');
					}
					return yield* startReplica(runtime, open, {
						accessScope,
						partition,
						serverPartition,
						...(options.onChange === undefined ? {} : { onChange: options.onChange }),
						...(options.onError === undefined ? {} : { onError: options.onError }),
						...(options.schemaBarrier === undefined
							? {}
							: { schemaBarrier: options.schemaBarrier }),
						...(options.deleteInactiveReplicaPartition === undefined
							? {}
							: { deleteInactiveReplicaPartition: options.deleteInactiveReplicaPartition }),
						...(storage === undefined ? {} : { storage }),
						...(leadership === undefined ? {} : { leadership }),
						...(profileIndex === undefined ? {} : { profileIndex }),
						...(physicalLease === undefined ? {} : { physicalLease })
					}).pipe(
						Effect.mapError((cause) => {
							if (
								!(
									cause instanceof ReplicaStoredStateCorruption ||
									cause instanceof ReplicaProvisioningFailure
								) ||
								storage === undefined ||
								storage.tier === 'server-only'
							) return cause;
							const partitionId = replicaProfilePartitionId(serverPartition.key, storage.tier);
							return new ReplicaLocalCorruption(cause.message, cause, {
								id: partitionId,
								partitionId,
								organization: serverPartition.tenantId,
								tier: storage.tier,
								location: replicaLocation(serverPartition.key, storage.tier),
								kind: 'partition',
								lastAccess: 0,
								accountedBytes: 0
							});
						})
					);
				});
				// Cache the Effect, not a Promise: callers share the startup fiber while internal control flow
				// remains in Effect. `runPromise` below is only the exported browser API adapter.
				running = Effect.runSync(
					Effect.cached(
						startup.pipe(
							Effect.map((replica) => ({
								...replica,
								stop: () => {
									runtimeStates.forgetReplica(runtime, key);
									replica.stop();
								}
							})),
							Effect.tapError(() =>
								Effect.gen(function* () {
									runtimeStates.forgetReplica(runtime, key);
									leadership?.stop();
									if (physicalLease !== undefined)
										yield* Effect.tryPromise(() => physicalLease?.stop() ?? Promise.resolve()).pipe(
											Effect.catch(() => Effect.void)
										);
									profileIndex?.close();
								})
							)
						)
					)
				);
				runtimeStates.rememberReplica(runtime, key, running);
			}
			return yield* running;
		})
	);
};

/** A failure proven to originate in reconstructible browser storage, never a network/server error. */
export class ReplicaLocalCorruption extends Error {
	readonly cause: unknown | undefined;
	readonly partition: ReplicaProfileEvictionCandidate | undefined;

	constructor(
		message: string,
		cause?: unknown,
		partition?: ReplicaProfileEvictionCandidate
	) {
		super(message);
		this.name = 'ReplicaLocalCorruption';
		this.cause = cause;
		this.partition = partition;
	}
}

/** Builds the capability object registered with the root host bootstrap loader. */
export const createWorkspaceBootstrapController = (
	runtime: WorkspaceClientRuntime,
	accessScope: string,
	options: StartLocalReplicaOptions = {}
) => {
	let starting: Promise<LocalReplica> | undefined;
	let replica: LocalReplica | undefined;
	const start = (): Promise<LocalReplica> => {
		if (starting === undefined) {
			const attempt = startLocalReplica(runtime, undefined, { ...options, accessScope })
				.catch((cause) => {
					throw cause instanceof ReplicaLocalCorruption
						? cause
						: cause instanceof ReplicaStoredStateCorruption
						? new ReplicaLocalCorruption(cause.message, cause)
						: cause;
				})
				.then((opened) => {
					replica = opened;
					return opened;
				});
			starting = attempt;
			void attempt.catch(() => {
				if (starting === attempt) starting = undefined;
			});
		}
		return starting;
	};
	const clearFailedReplica = async (cause: ReplicaLocalCorruption): Promise<void> => {
		let candidate = cause.partition;
		if (candidate === undefined) {
			const status = await Effect.runPromise(
				commandEffect(runtime, 'sync.partition', {}).pipe(
					Effect.flatMap(Schema.decodeUnknownEffect(SyncPartitionStatusResponse))
				)
			);
			const storage = await selectReplicaStorage();
			if (storage.tier === 'server-only') {
				throw new Error('No persistent replica partition is available for corruption recovery');
			}
			const partitionId = replicaProfilePartitionId(status.partition.key, storage.tier);
			candidate = {
				id: partitionId,
				partitionId,
				organization: status.partition.tenantId,
				tier: storage.tier,
				location: replicaLocation(status.partition.key, storage.tier),
				kind: 'partition',
				lastAccess: 0,
				accountedBytes: 0
			};
		}
		const accessState = runtimeStates.access(runtime);
		if (
			accessState?.serverPartitionKey !== undefined &&
			accessState.schemaFingerprint !== undefined
		) {
			clearReplicaCompatibility(
				candidate.organization,
				accessState.serverPartitionKey,
				accessState.schemaFingerprint
			);
		}
		await (options.deleteInactiveReplicaPartition ?? deleteInactivePGlitePartition)(
			candidate
		);
		starting = undefined;
		await start();
	};
	return {
		start,
		inspectCompatibility: async (): Promise<'compatible' | 'missing' | 'incompatible'> => {
			try {
				const status = await Effect.runPromise(
					commandEffect(runtime, 'sync.partition', {}).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncPartitionStatusResponse))
					)
				);
				return persistedReplicaCompatibility(
					status.partition.tenantId,
					status.partition.key,
					status.partition.schemaFingerprint
				)
					? 'compatible'
					: 'missing';
			} catch {
				return 'incompatible';
			}
		},
		subscribeProgress: (listener: (progress: ReplicaBootstrapProgress) => void): (() => void) => {
			const state = runtimeStates.access(runtime);
			if (state === undefined) return () => undefined;
			state.progressListeners.add(listener);
			listener(state.progress);
			return () => state.progressListeners.delete(listener);
		},
		// Resolves when the physical partition has drained its initial authoritative catch-up.
		initialCatchUpReady: async (): Promise<void> => {
			const opened = await start();
			await opened.initialCatchUpReady;
		},
		// The read path is already online-first. The host may remove its startup overlay without
		// cancelling background materialization.
		continueOnline: (): void => undefined,
		clearAndRebuild: (cause: unknown): undefined | (() => Promise<void>) =>
			cause instanceof ReplicaLocalCorruption
				? () => (replica === undefined ? clearFailedReplica(cause) : replica.clearAndRebuild())
				: undefined
	};
};

const startReplica = (
	runtime: WorkspaceClientRuntime,
	open:
		((steps: ReadonlyArray<ProvisioningStepType>) => Effect.Effect<PGliteLike, unknown>) | undefined,
	options: {
		readonly accessScope: string;
		readonly onChange?: (applied: number) => void;
		readonly onError?: (cause: unknown) => void;
		readonly schemaBarrier?: Omit<SchemaBarrierHooks, 'leader'>;
		readonly partition: ResolvedReplicaPartition;
		readonly serverPartition: Schema.Schema.Type<typeof SyncPartitionIdentity>;
		readonly storage?: ReplicaStorageDecision;
		readonly leadership?: ReplicationLeadership;
		readonly profileIndex?: ReplicaProfileIndex;
		readonly physicalLease?: ReplicaPhysicalPartitionLease;
		readonly deleteInactiveReplicaPartition?: (
			candidate: ReplicaProfileEvictionCandidate
		) => Promise<void>;
	}
): Effect.Effect<LocalReplica, unknown> =>
	Effect.gen(function* () {
		const cache = runtime.cache;
		const registry = runtime.queries;
		const openEngine =
			open ??
			((steps: ReadonlyArray<ProvisioningStepType>) =>
				Effect.tryPromise(() => import('#lib/client/replica/pglite-loader.js')).pipe(
					Effect.flatMap(({ openPGlite }) =>
						openPGlite(steps, options.serverPartition.key, {
							...(options.storage === undefined ? {} : { storage: options.storage }),
							...(options.leadership === undefined
								? {}
								: { leadership: options.leadership })
						})
					)
				));
		const transport: BootstrapTransport = {
			command: (command, input, signal) =>
				accessScopeFor(runtime) === options.accessScope
					? commandEffect(runtime, command, input, signal)
					: Effect.fail(new Error('Local replica access scope changed during startup'))
		};
		const local = yield* openLocalDatabase(transport, openEngine);
		const initialize = Effect.gen(function* () {
		if (accessScopeFor(runtime) !== options.accessScope) {
			yield* local.close();
			return yield* Effect.fail(new Error('Local replica access scope changed during startup'));
		}
		const coverage = yield* createWindowLedger(local.engine, local.store).pipe(
			Effect.mapError(
				(cause) =>
					new ReplicaStoredStateCorruption(
						'Replica coverage metadata could not be read or upgraded',
						cause
					)
			)
		);
		let maintenance: ReplicaSchemaMaintenance | undefined;
		const invalidateCoverage = (collections: ReadonlyArray<string>): Effect.Effect<void> =>
			coverage.invalidateDependencies(collections).pipe(
				Effect.asVoid,
				Effect.catch((cause) => Effect.sync(() => options.onError?.(cause)))
			);
		const accessState = runtimeStates.access(runtime);
		const serverPartition = options.serverPartition;
		if (serverPartition.schemaFingerprint !== local.fingerprint)
			return yield* Effect.fail(
				new Error('The local replica schema does not match the authoritative sync partition.')
			);
		if (accessState !== undefined) {
			if (options.onError === undefined) delete accessState.reportError;
			else accessState.reportError = options.onError;
			accessState.schemaFingerprint = serverPartition.schemaFingerprint;
			accessState.serverPartitionKey = serverPartition.key;
			accessState.readRowVersions = async (references) => {
				const recordIdsByCollection = new Map<string, Set<string>>();
				for (const { collection, recordId } of references) {
					const recordIds = recordIdsByCollection.get(collection) ?? new Set<string>();
					recordIds.add(recordId);
					recordIdsByCollection.set(collection, recordIds);
				}
				const rows = await Promise.all(
					[...recordIdsByCollection].map(async ([collection, recordIds]) => ({
						collection,
						rows: await Effect.runPromise(local.store.baseRows(collection, [...recordIds]))
					}))
				);
				const versions = new Map<string, number>();
				for (const group of rows) {
					for (const row of group.rows) {
						const key = `${group.collection}\u0000${row.recordId}`;
						versions.set(key, row.rowVersion);
					}
				}
				return versions;
			};
		}
		yield* Effect.tryPromise(() => mutationJournalFor(runtime));
		let overlaySnapshot: Awaited<ReturnType<CollectionMutationJournal['overlay']>> = [];
		const refreshOverlaySnapshot = async (): Promise<void> => {
			overlaySnapshot = (
				await Promise.all((await knownMutationJournals(runtime)).map((journal) => journal.overlay()))
			).flat();
		};
		const overlay = { snapshot: async () => overlaySnapshot };
		const activeOverlayCollections = async (): Promise<ReadonlyArray<string>> => [
			...new Set(
				(await overlay.snapshot()).flatMap((mutation) =>
					mutation.operations.map(({ row }) => row.collection)
				)
			)
		];
		yield* Effect.tryPromise(refreshOverlaySnapshot);
		if (accessState !== undefined) accessState.refreshOverlaySnapshot = refreshOverlaySnapshot;
		if (accessState !== undefined) accessState.invalidateCoverage = invalidateCoverage;
		const durableSchema = yield* readDurableReplicaSchema(local.engine);
		if (
			durableSchema !== undefined &&
			durableSchema.fingerprint === local.fingerprint &&
			durableSchema.protocolVersion !== PROTOCOL_VERSION
		) {
			yield* coverage.transaction(
				writeDurableReplicaSchema(local.engine, {
					...durableSchema,
					protocolVersion: PROTOCOL_VERSION
				})
			);
		}
		const createReader = (partitionKey: string): LocalReader => createLocalReader(
			local.store,
			local.shape,
			local.readable,
			coverage,
			{
				protocolVersion: PROTOCOL_VERSION,
				schemaFingerprint: local.fingerprint,
				partitionKey
			},
			{
				pinnedCollation: true,
				overlay,
				localActorBinding: options.partition.key
			}
		);
		let localReader = createReader(serverPartition.key);
		if (accessState !== undefined) publishReplicaProgress(accessState, { phase: 'loading' });

		const persistentStorage =
			options.storage !== undefined && options.storage.tier !== 'server-only'
				? options.storage
				: undefined;
		const profileIndex = persistentStorage === undefined ? undefined : options.profileIndex;
		const profilePartitionId =
			persistentStorage === undefined
				? undefined
			: replicaProfilePartitionId(serverPartition.key, persistentStorage.tier);
		const profileOwnerId = `replica-tab:${
			globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`
		}`;
		const visibleLeases = new Map<string, ReplicaLeaseHandle>();
		const visibleLeaseId = (token: string): string => `${profileOwnerId}:visible:${token}`;
		let leaseOwner: Readonly<{ readonly stop: () => Promise<void> }> | undefined;
		let automationLeases: ReturnType<typeof createRunningAutomationLeaseHooks> | undefined;
		const visibleLeaseSweep = setInterval(() => {
			void (async () => {
				if (accessState === undefined) return;
				const expiresBefore = Date.now() - INACTIVE_WINDOW_TTL_MILLIS;
				for (const [token, tracked] of accessState.visibleQueries) {
					if (tracked.owner.deref() !== undefined && tracked.lastAccessAt > expiresBefore) continue;
					accessState.releaseVisibleQuery?.(token);
					accessState.visibleQueries.delete(token);
				}
				await Effect.runPromise(
					coverage.expireInactiveWindows(await protectedMutationRows(runtime)).pipe(Effect.asVoid)
				);
			})().catch((cause) => options.onError?.(cause));
		}, 60_000);
		const demoteUnprovenVisibleQueries = (): void => {
			if (accessState === undefined) return;
			const documentVisible =
				typeof document !== 'undefined' && document.visibilityState === 'visible';
			const visibleAfter = Date.now() - VISIBLE_QUERY_PRIORITY_EVIDENCE_MILLIS;
			for (const tracked of accessState.visibleQueries.values()) {
				if (documentVisible && tracked.lastAccessAt >= visibleAfter) continue;
				tracked.visibility = 'hidden';
				tracked.releaseWindow?.setVisibility('hidden');
			}
		};
		const visiblePrioritySweep = setInterval(demoteUnprovenVisibleQueries, 1_000);
		const onDocumentVisibility = (): void => {
			if (document.visibilityState !== 'visible') demoteUnprovenVisibleQueries();
		};
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', onDocumentVisibility);
		}

		const replaceProfileWindows = (listed: ReadonlyArray<QueryWindowSummary>): Promise<void> => {
			if (profileIndex === undefined || profilePartitionId === undefined || persistentStorage === undefined)
				return Promise.resolve();
			const indexed = profileWindowsFromLedger(profilePartitionId, listed);
			return profileIndex
				.notePartition(
					profilePartition({
						id: profilePartitionId,
						organization: serverPartition.tenantId,
						tier: persistentStorage.tier,
						location: replicaLocation(serverPartition.key, persistentStorage.tier),
						windows: indexed
					})
				)
				.then(() =>
					profileIndex.replaceWindows(
						profilePartitionId,
						indexed.map(({ id, kind, accountedBytes, lastAccess }) => ({
							id,
							kind,
							accountedBytes,
							lastAccess
						}))
					)
				);
		};

		const ensureVisibleLease = (token: string): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				if (
					profileIndex === undefined ||
					profilePartitionId === undefined ||
					visibleLeases.has(token) ||
					accessState === undefined
				) return;
				const tracked = accessState.visibleQueries.get(token);
				if (tracked === undefined || tracked.owner.deref() === undefined) {
					accessState.visibleQueries.delete(token);
					return;
				}
				const queryKey = tracked.queryKey;
				if (queryKey === undefined) return;
				const listed = yield* coverage.listWindows();
				if (!listed.some(({ id }) => id === queryKey)) return;
				const ownerId = visibleLeaseId(token);
				yield* coverage.acquireWindowLease(queryKey, ownerId);
				const lease = yield* Effect.tryPromise(() =>
					profileIndex.lease({
						id: ownerId,
						ownerId: profileOwnerId,
						partitionId: profilePartitionId,
						windowId: queryKey,
						kind: 'visible-window'
					})
				).pipe(
					Effect.tapError(() => coverage.releaseWindowLease(queryKey, ownerId))
				);
				visibleLeases.set(token, lease);
			});

		if (profileIndex !== undefined && profilePartitionId !== undefined) {
			const listed = yield* coverage.listWindows();
			yield* Effect.tryPromise(() => replaceProfileWindows(listed));
			yield* Effect.tryPromise(() =>
				profileIndex.lease({
					id: `${profileOwnerId}:active`,
					ownerId: profileOwnerId,
					partitionId: profilePartitionId,
					kind: 'active-tab'
				})
			);
			leaseOwner = maintainReplicaLeaseOwner(
				profileIndex,
				profileOwnerId,
				options.onError === undefined ? {} : { onFailure: options.onError }
			);
			automationLeases = createRunningAutomationLeaseHooks({
				index: profileIndex,
				ownerId: profileOwnerId,
				partitionId: profilePartitionId
			});
			if (accessState !== undefined) {
				accessState.acquirePendingMutationLease = async (stableLeaseId) => {
					await profileIndex.lease({
						id: stableLeaseId,
						ownerId: `pending-mutation:${stableLeaseId}`,
						partitionId: profilePartitionId,
						kind: 'pending-mutation'
					});
				};
				accessState.releasePendingMutationLease = (stableLeaseId) =>
					profileIndex.releaseLease(stableLeaseId);
				accessState.trackVisibleQuery = (token) =>
					Effect.runFork(
						ensureVisibleLease(token).pipe(
							Effect.catch((cause) => Effect.sync(() => options.onError?.(cause)))
						)
					);
				accessState.releaseVisibleQuery = (token) => {
					const tracked = accessState.visibleQueries.get(token);
					tracked?.releaseWindow?.();
					if (tracked?.queryKey !== undefined) {
						Effect.runFork(
							coverage.releaseWindowLease(tracked.queryKey, visibleLeaseId(token)).pipe(
								Effect.catch((cause) => Effect.sync(() => options.onError?.(cause)))
							)
						);
					}
					const lease = visibleLeases.get(token);
					visibleLeases.delete(token);
					if (lease !== undefined) void lease.release().catch((cause) => options.onError?.(cause));
				};
				for (const token of accessState.visibleQueries.keys()) {
					accessState.trackVisibleQuery(token);
				}
			}
		}

		const reconcileAutomationLeases = (): Effect.Effect<void, unknown> => {
			if (automationLeases === undefined) return Effect.void;
			return Effect.gen(function* () {
				const activeTaskIds = new Set<string>();
				const seenCursors = new Set<string>();
				let after: string | undefined;
				for (;;) {
					const page = yield* transport.command('collections.findMany', {
						collection: 'automation_run',
						where: { status: { in: ['pending', 'resuming', 'running'] } },
						orderBy: { task_id: 'asc' },
						limit: 500,
						...(after === undefined ? {} : { after })
					});
					const rows = rowsFrom(page);
					if (rows === undefined)
						return yield* Effect.fail(
							new Error('Automation lease reconciliation received no authoritative page')
						);
					for (const value of rows) {
						const taskId = asJsonRecord(value)['task_id'];
						if (typeof taskId === 'string' && taskId.length > 0) activeTaskIds.add(taskId);
					}
					const next = cursorFrom(page);
					if (next === null) break;
					if (seenCursors.has(next))
						return yield* Effect.fail(new Error('Automation reconciliation cursor repeated'));
					seenCursors.add(next);
					after = next;
				}
				yield* Effect.tryPromise(() =>
					automationLeases?.reconcile({ complete: true, activeTaskIds: [...activeTaskIds] }) ??
					Promise.resolve()
				);
			});
		};
		if ((options.leadership?.leader() ?? local.engine.isLeader !== false) === true) {
			yield* reconcileAutomationLeases();
		}
		// Publish lifecycle callbacks only after the authoritative reconciliation succeeds. A failed
		// startup closes the profile index; exposing callbacks before this point leaves the automation
		// client holding a function that targets that closed database, so a successfully enqueued run
		// is reported as a local Effect.tryPromise failure.
		if (accessState !== undefined && automationLeases !== undefined) {
			accessState.automationStarted = automationLeases.started;
			accessState.automationObserved = automationLeases.observe;
			accessState.automationSettled = automationLeases.settled;
		}

		const enforceBudget = (): Effect.Effect<void> =>
			profileIndex === undefined ||
			profilePartitionId === undefined ||
			persistentStorage === undefined ||
			typeof navigator === 'undefined' ||
			typeof navigator.storage?.estimate !== 'function'
				? Effect.void
				: Effect.gen(function* () {
					const listed = yield* coverage.listWindows();
					yield* Effect.tryPromise(() => replaceProfileWindows(listed));
					for (const token of accessState?.visibleQueries.keys() ?? []) {
						yield* ensureVisibleLease(token);
					}
					if ((options.leadership?.leader() ?? local.engine.isLeader !== false) === false) return;
					yield* Effect.tryPromise(() =>
						enforceIndexedReplicaProfileBudget({
							index: profileIndex,
							budget: persistentStorage.budget,
							estimate: () => navigator.storage.estimate(),
							releasePhysical: async (candidate) => {
								if (
									candidate.partitionId === profilePartitionId &&
									candidate.kind !== 'partition'
								) {
									await Effect.runPromise(
										coverage.releaseWindow(
											candidate.id,
											await protectedMutationRows(runtime)
										).pipe(Effect.asVoid)
									);
									return;
								}
								if (candidate.kind === 'partition') {
									await (options.deleteInactiveReplicaPartition ?? deleteInactivePGlitePartition)(
										candidate
									);
									return;
								}
								throw new Error('No safe physical release adapter for replica eviction candidate');
							}
						})
					).pipe(Effect.asVoid);
				}).pipe(Effect.catch((cause) => Effect.sync(() => options.onError?.(cause))));

		let m3Hydrating = false;
		const materializeQuery = (captured: AuthoritativeQueryCapture): Effect.Effect<void, unknown> =>
			Effect.gen(function* () {
				const kind = collectionWindowKind(captured.command);
				if (kind === undefined) return;
				if (asJsonRecord(captured.value)['serverOnly'] === true) {
					if (captured.flight !== undefined)
						accessState?.partitionSync?.cancelWindowFlight(captured.flight);
					return;
				}
				const input = asJsonRecord(captured.input);
				const collection = input['collection'];
				if (typeof collection !== 'string') return;
				if (maintenance?.affectedCollections.includes(collection) === true) return;
				const decoded =
					kind === 'findMany'
						? ({
								kind,
								response: yield* Schema.decodeUnknownEffect(CollectionQueryPage)(captured.value)
							} as const)
						: kind === 'count'
							? ({
									kind,
									response: yield* Schema.decodeUnknownEffect(CollectionCountWindow)(captured.value)
								} as const)
							: ({
									kind,
									response: yield* Schema.decodeUnknownEffect(CollectionGroupedWindow)(captured.value)
								} as const);
				const proof = decoded.response;
				if (
					accessState?.serverPartitionKey !== undefined &&
					accessState.serverPartitionKey !== proof.partitionKey
				) {
					if (captured.flight !== undefined)
						accessState.partitionSync?.cancelWindowFlight(captured.flight);
					yield* Effect.tryPromise(() =>
						accessState.rebootstrapPartition?.() ?? Promise.resolve()
					);
					return;
				}
				const description = yield* describeClientQueryWindow(
					decoded.kind,
					input,
					accessState?.catalog ?? {},
					{
						protocolVersion: PROTOCOL_VERSION,
						schemaFingerprint: local.fingerprint,
						partitionKey: proof.partitionKey
					},
					{
						pinnedCollation: true,
						localRelationships: true,
						localSearch: (() => {
							const shape = local.shape.collections.find(({ name }) => name === collection);
							if (shape?.readableFields === undefined) return false;
							const searchable = Object.entries(shape.fields)
								.filter(([, field]) => field.search === true)
								.map(([field]) => field);
							return shape.readableFields === null ||
								searchable.every((field) => shape.readableFields?.includes(field));
						})()
					}
				);
				if (description === undefined)
					return yield* Effect.fail(new Error('Authoritative collection query could not be canonicalized'));
				const payload = yield* Effect.gen(function* () {
					if (decoded.kind === 'findMany') {
						const confirmation = confirmCollectionQueryPage(description, decoded.response);
						if (Result.isFailure(confirmation)) return yield* Effect.fail(confirmation.failure);
						const baseRows = authoritativeBaseRowsFromPage(collection, decoded.response);
						if (Result.isFailure(baseRows)) return yield* Effect.fail(baseRows.failure);
						return {
							confirmation: confirmation.success,
							baseRows: baseRows.success,
							orderedRowIds: decoded.response.rows.map((row) => String(row['id'])),
							relationshipRefs: decoded.response.relationshipRefs,
							nextCursor: decoded.response.nextCursor,
							continuation: typeof input['after'] === 'string' ? input['after'] : null,
							lookaheadCount: decoded.response.lookahead,
							serverResult: undefined
						} as const;
					}
					if (decoded.kind === 'count') {
						const confirmation = confirmCollectionCountWindow(description, decoded.response);
						if (Result.isFailure(confirmation)) return yield* Effect.fail(confirmation.failure);
						return {
							confirmation: confirmation.success,
							baseRows: [],
							orderedRowIds: [],
							relationshipRefs: [],
							nextCursor: null,
							continuation: null,
							lookaheadCount: 0,
							serverResult: { kind: 'count', value: decoded.response.count } as const
						} as const;
					}
					const confirmation = confirmCollectionGroupedWindow(description, decoded.response);
					if (Result.isFailure(confirmation)) return yield* Effect.fail(confirmation.failure);
					const baseRows = authoritativeBaseRowsFromGroupedWindow(collection, decoded.response);
					if (Result.isFailure(baseRows)) return yield* Effect.fail(baseRows.failure);
					const groups = groupedRowIdsFromWindow(decoded.response);
					if (Result.isFailure(groups)) return yield* Effect.fail(groups.failure);
					return {
						confirmation: confirmation.success,
						baseRows: baseRows.success,
						orderedRowIds: Object.values(groups.success).flat(),
						relationshipRefs: decoded.response.relationshipRefs,
						nextCursor: null,
						continuation: null,
						lookaheadCount: 0,
						serverResult: { kind: 'findGrouped', groups: groups.success } as const
					} as const;
				});
				const confirmedDescription = {
					...description,
					dependencies: payload.confirmation.dependencies,
					reproducibility: payload.confirmation.reproducibility
				};
			const window = windowDescriptorOf(confirmedDescription);
			let installedFresh = false;
			const install = (context: WindowInstallContext) => {
				return coverage.installWindow({
						window,
						dependencies: payload.confirmation.dependencies,
						baseRows: payload.baseRows,
						orderedRowIds: payload.orderedRowIds,
						relationshipRefs: payload.relationshipRefs,
						...(payload.serverResult === undefined
							? {}
							: { serverResult: payload.serverResult }),
						nextCursor: payload.nextCursor,
						readCursor: proof.readCursor,
						dependencyGenerations: payload.confirmation.dependencyGenerations,
						continuation: payload.continuation,
						lookaheadCount: payload.lookaheadCount,
						valid: context.proofMayBeValid,
						...(context.bufferedDeltas === undefined || context.bufferedDeltas.length === 0
							? {}
							: {
									bufferedDeltas: {
										deltas: context.bufferedDeltas,
										headCursor: context.position.cursor,
										generations: context.position.generations,
										affectedCollections: [
											...new Set(context.bufferedDeltas.map(({ collection }) => collection))
										],
										refillCollections: []
							}
						})
				}).pipe(
						Effect.tap((proof) => Effect.sync(() => {
							installedFresh = proof.valid && !proof.dirty;
						})),
						Effect.map(({ valid, dirty }) => ({ valid, dirty }))
					);
				};
				const currentPosition = yield* coverage.position();
				if (captured.flight !== undefined && accessState?.partitionSync !== undefined) {
					yield* Effect.tryPromise(() =>
						accessState.partitionSync?.installWindowFlight(
							captured.flight as WindowFlight,
							proof.readCursor,
							payload.confirmation.dependencyGenerations,
							install
						) ?? Promise.resolve()
					);
				} else {
					const installed = yield* install({
						position: currentPosition,
						proofMayBeValid: true,
						bufferedDeltas: []
					});
					if (installed.dirty) yield* recomputer.recomputeMany([window.queryKey]).pipe(Effect.asVoid);
				}
				if (accessState !== undefined) {
					accessState.serverPartitionKey = proof.partitionKey;
					if (installedFresh) accessState.staleWindowKeys.delete(window.queryKey);
					else if (window.proofOwner === 'server')
						accessState.staleWindowKeys.add(window.queryKey);
					accessState.syncStatus.patch({
						staleServerProofWindows: accessState.staleWindowKeys.size
					});
					for (const tracked of accessState.visibleQueries.values()) {
						if (cacheKeyFor(tracked.command, tracked.input) !== captured.key) continue;
						if (tracked.queryKey !== undefined && tracked.queryKey !== window.queryKey) {
							tracked.releaseWindow?.();
							const priorLease = [...visibleLeases.entries()].find(
								([token]) => accessState.visibleQueries.get(token) === tracked
							);
							if (priorLease !== undefined) {
								yield* coverage.releaseWindowLease(
									tracked.queryKey,
									visibleLeaseId(priorLease[0])
								).pipe(Effect.asVoid);
								visibleLeases.delete(priorLease[0]);
								yield* Effect.tryPromise(() => priorLease[1].release());
							}
						}
						tracked.queryKey = window.queryKey;
						tracked.lastAccessAt = Date.now();
						tracked.releaseWindow?.();
						const releaseWindow = accessState.partitionSync?.mountWindow(
							window.queryKey,
							payload.confirmation.dependencies,
							tracked.visibility,
							{
								relationDependency: hasCanonicalRelationshipSelection(
									description.query.relationships
								)
							}
						);
						if (releaseWindow === undefined) delete tracked.releaseWindow;
						else tracked.releaseWindow = releaseWindow;
						if (tracked.visibility === 'visible') {
							accessState.requestAdjacentHydration?.(window.queryKey);
						}
					}
					localReader = createReader(proof.partitionKey);
					if (!m3Hydrating && runtime.local !== undefined)
						runtime.local.current = localReader;
				}
				yield* enforceBudget();
			});

		let queryMaterializationTail = Promise.resolve();
		const queueMaterializeQuery = (query: AuthoritativeQueryCapture): void => {
			queryMaterializationTail = queryMaterializationTail
				.then(() => Effect.runPromise(materializeQuery(query)))
				.catch((cause) => options.onError?.(cause));
		};
		if (accessState !== undefined) {
			accessState.materializeQuery = queueMaterializeQuery;
		}

		const invalidateNamed = (collections: ReadonlyArray<string>): void => {
			if (cache === undefined || registry === undefined) return;
			cache.invalidate(collections);
			// Catch-up can invalidate queries mounted before the replica was ready. Keep their last remote
			// value on screen until the ordered catch-up has drained; the one wildcard refresh below then
			// runs with the reader installed instead of issuing a remote request for every streamed batch.
			if (runtime.local?.current === localReader) registry.reexecuteAffected(collections);
		};

		/** Tells sibling runtime documents what this leader just finished applying. */
		const announceToTabs = (collections: ReadonlyArray<string>): Effect.Effect<void> =>
			Effect.sync(() => runtimeStates.access(runtime)?.invalidation?.announce(collections));

		/** Clears the reconstructible cache without advancing past a batch it could not apply. */
		const rebuildReplica = (): Effect.Effect<void, unknown> =>
			Effect.tryPromise(async () => {
				closeSubscription();
				const readerWasInstalled = runtime.local?.current === localReader;
				if (readerWasInstalled && runtime.local !== undefined) delete runtime.local.current;
				const position = await Effect.runPromise(coverage.position());
				coordinator.rebuild('headRollback', position);
				await coordinator.idle();
				await refreshOverlaySnapshot();
				const overlayCollections = await activeOverlayCollections();
				if (overlayCollections.length > 0)
					await accessState?.reflectLocalMutation?.(overlayCollections);
				if (
					readerWasInstalled &&
					runtime.local !== undefined &&
					accessScopeFor(runtime) === options.accessScope
				) {
					runtime.local.current = localReader;
				}
				cache?.clear();
				if (runtime.local?.current === localReader) registry?.reexecuteAffected([ANY_COLLECTION]);
				await Effect.runPromise(announceToTabs([ANY_COLLECTION]));
				await Effect.runPromise(enforceBudget());
				streamIfLeading();
			});

		// Custom/in-process engines keep their injected leadership seam for tests and non-browser hosts.
		const leads = (): boolean => options.leadership?.leader() ?? local.engine.isLeader !== false;
		let recomputer = createLocalWindowRecomputer(
			local.store,
			local.shape,
			coverage,
			serverPartition.key,
			{ overlay, localActorBinding: options.partition.key }
		);
		let subscription: PartitionSubscription | undefined;
		let observedStreamHead: SyncCursor | undefined;
		const closeSubscription = (): void => {
			subscription?.stop();
			subscription = undefined;
			accessState?.syncStatus.markDisconnected();
		};
		let pendingMutationIds: ReadonlyArray<string> = [];
		let mutationPushRetry: ReturnType<typeof setTimeout> | undefined;
		let mutationPushRetryAt: number | undefined;
		let paused = false;
		let schemaBarrierPauses = 0;
		let schemaBarrierTail = Promise.resolve();
		let maintenanceTail = Promise.resolve();
		let catchUpSettled = false;
		let resolveCatchUp: () => void = () => undefined;
		const initialCatchUp = new Promise<void>((resolve) => {
			resolveCatchUp = resolve;
		});
		/**
		 * The replica is level with the authority: replay is complete and nothing local is queued.
		 *
		 * This is the only transition into `connected`, because it is the only moment the client can
		 * say its rows are the authority's rows.
		 */
		const settleCatchUp = (): void => {
			if (catchUpSettled) return;
			catchUpSettled = true;
			resolveCatchUp();
		};
		const pauseIntake = (): void => {
			closeSubscription();
			if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
			mutationPushRetry = undefined;
			mutationPushRetryAt = undefined;
			paused = true;
		};
		const resumeIntake = (): void => {
			if (!paused || schemaBarrierPauses > 0) return;
			paused = false;
			accessState?.scheduleMutationPush?.();
			streamIfLeading();
		};

		const captureFromCanonicalWindow = (
			canonical: Readonly<Record<string, Schema.Json>>
		): AuthoritativeQueryCapture | undefined => {
			const kind = canonical['kind'];
			const collection = canonical['collection'];
			if (
				(kind !== 'findMany' && kind !== 'count' && kind !== 'findGrouped') ||
				typeof collection !== 'string'
			) return undefined;
			const input: Record<string, Schema.Json> = { collection };
			const authoredWhere = canonical['authoredWhere'];
			const userFilter = canonical['userFilter'];
			const search = canonical['search'];
			const relationships = canonical['relationships'];
			if (authoredWhere !== null && authoredWhere !== undefined) input['where'] = authoredWhere;
			if (userFilter !== null && userFilter !== undefined) input['userFilter'] = userFilter;
			if (search !== null && search !== undefined) input['search'] = search;
			if (relationships !== null && relationships !== undefined) input['with'] = relationships;
			const order = canonical['orderBy'];
			if (Array.isArray(order)) {
				const terms = order.flatMap((term) => {
					const record = asJsonRecord(term);
					const field = record['field'];
					const direction = record['direction'];
					return typeof field === 'string' && (direction === 'asc' || direction === 'desc')
						? [[field, direction] as const]
						: [];
				});
				if (terms.length > 0) input['orderBy'] = Object.fromEntries(terms);
			}
			const group = canonical['group'];
			if (group !== null && group !== undefined) input['group'] = group;
			const command = `collections.${kind}`;
			return {
				key: cacheKeyFor(command, input),
				command,
				input,
				value: null
			};
		};
		const queryCaptureForWindow = async (
			queryKey: string
		): Promise<AuthoritativeQueryCapture | undefined> => {
			if (accessState !== undefined) {
				for (const tracked of accessState.visibleQueries.values()) {
					if (tracked.queryKey !== queryKey || tracked.owner.deref() === undefined) continue;
					const firstPageInput = { ...asJsonRecord(tracked.input) };
					delete firstPageInput['after'];
					return {
						key: cacheKeyFor(tracked.command, firstPageInput),
						command: tracked.command,
						input: firstPageInput,
						value: null
					};
				}
			}
			return Effect.runPromise(
				coverage.readWindow(queryKey, (proof) =>
					Effect.succeed(captureFromCanonicalWindow(proof.canonical))
				)
			);
		};
		const fetchAndMaterialize = async (
			capture: AuthoritativeQueryCapture,
			flight?: WindowFlight
		): Promise<void> => {
			const value = await Effect.runPromise(transport.command(capture.command, capture.input));
			await Effect.runPromise(materializeQuery({
				...capture,
				value,
				...(flight === undefined ? {} : { flight })
			}));
		};
		const fetchConvergedFindManyCapture = async (
			capture: AuthoritativeQueryCapture,
			targetRowCount: number
		): Promise<AuthoritativeQueryCapture> => {
			const rootInput = { ...asJsonRecord(capture.input) };
			delete rootInput['after'];
			const requestedLimit =
				typeof rootInput['limit'] === 'number' &&
				Number.isSafeInteger(rootInput['limit']) && rootInput['limit'] >= 1
					? Math.min(500, rootInput['limit'])
					: 100;
			const refillLimit = Math.min(
				500,
				Math.max(requestedLimit, Math.ceil(Math.max(1, targetRowCount) / 2))
			);
			rootInput['limit'] = refillLimit;
			const maxPages = Math.ceil(
				Math.max(1, targetRowCount) / (refillLimit * 2)
			) + 1;
			const pages: Array<CollectionQueryPage> = [];
			const seenCursors = new Set<string>();
			let totalRows = 0;
			let expectedProof: string | undefined;
			let pageInput = rootInput;
			for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
				const value = await Effect.runPromise(
					transport.command(capture.command, pageInput).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(CollectionQueryPage))
					)
				);
				const proofSignature = JSON.stringify({
					partitionKey: value.partitionKey,
					confirmedDependencies: [...value.confirmedDependencies].toSorted(),
					dependencyGenerations: Object.fromEntries(
						Object.entries(value.dependencyGenerations).toSorted(([left], [right]) =>
							left.localeCompare(right)
						)
					),
					reproducibility: value.reproducibility
				});
				if (expectedProof !== undefined && proofSignature !== expectedProof) {
					throw new Error('Query-window refill dependencies moved between bounded pages');
				}
				expectedProof = proofSignature;
				pages.push(value);
				totalRows += value.rows.length;
				if (totalRows > MAX_REPLICA_WINDOW_ROWS) {
					throw new Error('Query-window refill exceeds the durable membership cap');
				}
				if (value.nextCursor === null || totalRows >= targetRowCount) break;
				if (value.rows.length === 0 || seenCursors.has(value.nextCursor)) {
					throw new Error('Query-window refill returned a non-advancing continuation');
				}
				seenCursors.add(value.nextCursor);
				pageInput = { ...rootInput, after: value.nextCursor };
			}
			const first = pages[0];
			const last = pages.at(-1);
			if (first === undefined || last === undefined) {
				throw new Error('Query-window refill returned no authoritative page');
			}
			if (last.nextCursor !== null && totalRows < targetRowCount) {
				throw new Error('Query-window refill did not cover its retained boundary');
			}
			const baseRows = new Map<string, CollectionQueryPage['baseRows'][number]>();
			const relationships = new Map<
				string,
				CollectionQueryPage['relationshipRefs'][number]
			>();
			for (const page of pages) {
				for (const row of page.baseRows) {
					const key = `${row.collection}\u0000${row.recordId}`;
					const prior = baseRows.get(key);
					if (prior !== undefined && prior.rowVersion !== row.rowVersion) {
						throw new Error('Query-window refill observed two versions of one base row');
					}
					baseRows.set(key, row);
				}
				for (const relationship of page.relationshipRefs) {
					const key = [
						relationship.sourceCollection, relationship.sourceRecordId,
						relationship.relation, relationship.targetCollection,
						relationship.targetRecordId
					].join('\u0000');
					relationships.set(key, relationship);
				}
			}
			const value = {
				...last,
				rows: pages.flatMap((page) => page.rows),
				baseRows: [...baseRows.values()],
				relationshipRefs: [...relationships.values()]
			};
			return {
				...capture,
				key: cacheKeyFor(capture.command, rootInput),
				input: rootInput,
				value
			};
		};
		const adjacentHydration = new Map<
			string,
			Readonly<{ readonly cursor: string; readonly release: () => void }>
		>();
		const refillWindow = async (
			queryKey: string,
			priority: 0 | 1 | 2
		): Promise<void> => {
			const capture = await queryCaptureForWindow(queryKey);
			if (capture === undefined) return;
			const proof = await Effect.runPromise(coverage.readWindow(
				queryKey,
				(window) => Effect.succeed({
					dependencies: window.dependencies,
					nextCursor: window.nextCursor,
					rowCount: window.orderedRowIds.length
				})
			));
			if (proof === undefined) return;
			const adjacent = adjacentHydration.get(queryKey);
			const hydrationCapture =
				priority === 1 && adjacent !== undefined && adjacent.cursor === proof.nextCursor
					? (() => {
							const input = { ...asJsonRecord(capture.input), after: adjacent.cursor };
							return { ...capture, key: cacheKeyFor(capture.command, input), input };
						})()
					: capture;
			const dependencies = proof.dependencies;
			const flight = coordinator.beginWindowFlight(queryKey, dependencies);
			try {
				if (hydrationCapture === capture && capture.command === 'collections.findMany') {
					const converged = await fetchConvergedFindManyCapture(capture, proof.rowCount);
					await Effect.runPromise(materializeQuery({ ...converged, flight }));
				} else {
					await fetchAndMaterialize(hydrationCapture, flight);
				}
			} finally {
				coordinator.cancelWindowFlight(flight);
				if (adjacentHydration.get(queryKey) === adjacent && adjacent !== undefined) {
					adjacent.release();
					adjacentHydration.delete(queryKey);
				}
			}
			const installed = await Effect.runPromise(coverage.readWindow(
				queryKey,
				(proof) => Effect.succeed({ valid: proof.valid, dirty: proof.dirty })
			));
			if (installed?.valid !== true || installed.dirty) {
				coordinator.requestRefill(queryKey);
				return;
			}
			invalidateNamed(dependencies);
		};
		const rehydrateActive = async (queryKeys: ReadonlyArray<string>): Promise<void> => {
			const captures = (await Promise.all(queryKeys.map(queryCaptureForWindow))).flatMap((capture) => {
				return capture === undefined ? [] : [capture];
			});
			m3Hydrating = true;
			try {
				accessState?.staleWindowKeys.clear();
				accessState?.syncStatus.patch({ staleServerProofWindows: 0 });
				for (let index = 0; index < captures.length; index += 2) {
					await Promise.all(
						captures.slice(index, index + 2).map((capture) => fetchAndMaterialize(capture))
					);
				}
			} finally {
				m3Hydrating = false;
			}
		};

		const confirmMutationDeltas = async (
			batch: Pick<
				Parameters<PartitionSyncCoordinator['acceptDeltas']>[0],
				'deltas' | 'mutationConfirmations' | 'mutationRejections'
			>
		): Promise<void> => {
			const journals = await knownMutationJournals(runtime);
			const retirements = (
				await Promise.all(journals.map((journal) => journal.observeAuthoritativeBatch({
					deltas: batch.deltas.map((delta) => ({
						mutationId: delta.mutationId,
						row: { collection: delta.collection, recordId: delta.recordId },
						kind: delta.op,
						rowVersion: delta.rowVersion
					})),
					confirmations: batch.mutationConfirmations,
					mutationRejections: batch.mutationRejections
				})))
			).flatMap(({ retirements }) => retirements);
			if (retirements.length === 0) return;
			await refreshOverlaySnapshot();
			for (const retirement of retirements)
				await releaseReplicaPendingMutationLease(runtime, retirement.idempotencyKey);
			await accessState?.reflectLocalMutation?.([
				...new Set(retirements.flatMap(({ affectedCollections }) => affectedCollections))
			]);
		};
		let requestStream: (
			collections?: ReadonlyArray<string>,
			position?: { readonly cursor: SyncCursor; readonly generations: Readonly<Record<string, number>> }
		) => void = () => undefined;
		let publishedDependencySignature: string | undefined;
		/**
		 * Every collection this workspace has — never the ones a page happens to have mounted.
		 *
		 * The partition stream is opened once per client and stays open, so its subscription cannot
		 * depend on what is on screen. Deriving it from mounted windows meant navigating between
		 * surfaces tore the stream down and built a new one, and a surface holding no live query tore
		 * it down and left nothing to reopen it — which is how a workspace ended up permanently
		 * reporting a dead stream while every command it sent answered normally.
		 *
		 * A workspace's collection set is fixed for the session, so the subscription is too. The
		 * server accepts 64 (`MAX_SYNC_PARTITION_COLLECTIONS`); the largest template declares 23, so
		 * the cap is headroom rather than a limit anyone reaches, and truncating is still better than
		 * a refused stream.
		 */
		const SUBSCRIPTION_LIMIT = 64;
		const subscribedCollections = (): ReadonlyArray<string> =>
			readableSubscriptionCollections(
				// `approval_request` is the sole runtime-owned replicated collection. Keeping it as
				// the internal anchor lets an otherwise empty authored workspace hold the one live
				// stream needed for private names-only invalidations. It is already the one explicit
				// generic system exception, so this does not broaden the authored/public collection set.
				[...Object.keys(runtimeStates.access(runtime)?.catalog ?? {}), 'approval_request'],
				local.readable,
				SUBSCRIPTION_LIMIT
			);
		const subscribedInvalidations = (): ReadonlyArray<string> => [
			'agent_mailbox',
			'agent_run',
			'automation_run',
			'chat_message',
			'chat_session'
		];
		const rehydrationFacts = async () => {
			const active = (await Effect.runPromise(coverage.listWindows()))
				.filter(({ leaseCount }) => leaseCount > 0)
				.slice(0, 256);
			const rowCounts = await Promise.all(
				active.map(({ id }) =>
					Effect.runPromise(
						coverage.readWindow(id, (proof) => Effect.succeed(proof.orderedRowIds.length))
					).then((count) => count ?? 0)
				)
			);
			const rows = rowCounts.reduce((total, count) => total + count, 0);
			const bytes = active.reduce((total, window) => total + window.bytes, 0);
			return {
				activeWindows: active.length,
				rowsPerWindow: Math.max(1, Math.min(500, Math.ceil(rows / Math.max(active.length, 1)))),
				estimatedBytesPerRow: Math.max(
					1,
					Math.min(1_048_576, Math.ceil(bytes / Math.max(rows, 1)))
				)
			};
		};

		const initialPosition = yield* coverage.position();
		const coordinator = createPartitionSyncCoordinator({
			initialPosition,
			store: {
				position: () => coverage.position(),
				applyDeltas: (batch) => coverage.applyDeltaBatch({
					deltas: batch.deltas,
					headCursor: batch.cursor,
					generations: batch.generations,
					affectedCollections: batch.affectedCollections,
					refillCollections: batch.refillCollections
				}).pipe(Effect.map((outcome) => ({
					applied: outcome.applied,
					affectedCollections: outcome.collections,
					affectedWindowIds: outcome.affectedWindowIds,
					proofWithdrawals: outcome.proofWithdrawals
				}))),
				invalidateDependencies: (collections, generations) =>
					coverage.invalidateDependencies(collections, generations).pipe(Effect.asVoid),
				rebuildNamespace: () => coverage.rebuildNamespace(),
				recordPosition: (position) => coverage.recordPosition(position)
			},
			rerunAffected: (collections) => {
				invalidateNamed(collections);
				Effect.runFork(announceToTabs(collections));
			},
			recomputeWindows: (queryKeys) =>
				Effect.runPromise(recomputer.recomputeMany(queryKeys)).then((restored) => {
					for (const queryKey of restored) accessState?.staleWindowKeys.delete(queryKey);
					return restored;
				}),
			onApplied: async (batch, outcome) => {
				if (outcome.applied > 0) options.onChange?.(outcome.applied);
				await confirmMutationDeltas(batch);
				await Effect.runPromise(enforceBudget());
			},
			onProofWithdrawals: (queryKeys) => {
				if (accessState === undefined) return;
				void Promise.all(
					queryKeys.map((queryKey) =>
						Effect.runPromise(
							coverage.readWindow(queryKey, (proof) =>
								Effect.succeed(proof.proofOwner === 'server' && (!proof.valid || proof.dirty))
							)
						).then((stale) => ({ queryKey, stale: stale === true }))
					)
				).then((windows) => {
					for (const { queryKey, stale } of windows) {
						if (stale) accessState.staleWindowKeys.add(queryKey);
						else accessState.staleWindowKeys.delete(queryKey);
					}
					accessState.syncStatus.patch({
						staleServerProofWindows: accessState.staleWindowKeys.size
					});
				}).catch((cause) => options.onError?.(cause));
			},
			refillWindow,
			rehydrateActive: (queryKeys) => rehydrateActive(queryKeys),
			onDependenciesChanged: (_collections, position) => {
				if (!leads() || paused) return;
				// The subscription is the workspace, so a dependency change never re-targets the stream.
				// What still matters is the cursor and cost facts it carries.
				const subscribed = subscribedCollections();
				const dependencySignature = JSON.stringify(subscribed);
				if (dependencySignature === publishedDependencySignature) return;
				publishedDependencySignature = dependencySignature;
				if (subscribed.length === 0) {
					closeSubscription();
					settleCatchUp();
					return;
				}
				if (subscription === undefined) requestStream(subscribed, position);
				else void rehydrationFacts()
					.then((rehydration) =>
						subscription?.update(
							subscribed,
							subscribedInvalidations(),
							position,
							pendingMutationIds,
							rehydration
						)
					)
					.catch((cause) => options.onError?.(cause));
			},
				...(options.onError === undefined ? {} : { onError: options.onError })
			});
		const requestAdjacentHydration = (queryKey: string): void => {
			void Effect.runPromise(
				coverage.readWindow(queryKey, (proof) => Effect.succeed(proof.nextCursor))
			).then((nextCursor) => {
				const existing = adjacentHydration.get(queryKey);
				if (nextCursor === null || nextCursor === undefined) {
					existing?.release();
					adjacentHydration.delete(queryKey);
					return;
				}
				if (existing?.cursor === nextCursor) return;
				existing?.release();
				const demand = coordinator.retainHydration({
					ownerId: `adjacent:${queryKey}`,
					queryKey,
					reason: 'adjacent',
					queryKeyEvidence: 'concrete'
				});
				adjacentHydration.set(queryKey, {
					cursor: nextCursor,
					release: demand.release
				});
				// The continuation is explicitly P1 even when the visible root window is P0.
				coordinator.requestRefill(queryKey, 1);
			}).catch((cause) => options.onError?.(cause));
		};
		if (accessState !== undefined) {
			accessState.partitionSync = coordinator;
			accessState.windowLedger = coverage;
			accessState.requestAdjacentHydration = requestAdjacentHydration;
			accessState.reflectLocalMutation = async (collections) => {
				const dirtied = await Effect.runPromise(coverage.dirtyDependencies(collections));
				await Effect.runPromise(recomputer.recomputeMany(dirtied.affectedWindowIds));
				for (const queryKey of dirtied.proofWithdrawals) {
					coordinator.requestRefill(queryKey);
					const serverProof = await Effect.runPromise(
						coverage.readWindow(queryKey, (proof) =>
							Effect.succeed(proof.proofOwner === 'server' && (!proof.valid || proof.dirty))
						)
					);
					if (serverProof === true) accessState.staleWindowKeys.add(queryKey);
					else accessState.staleWindowKeys.delete(queryKey);
				}
				accessState.syncStatus.patch({
					staleServerProofWindows: accessState.staleWindowKeys.size
				});
				invalidateNamed(collections);
				await Effect.runPromise(announceToTabs(collections));
			};
			yield* Effect.tryPromise(async () => {
				await refreshOverlaySnapshot();
				const collections = await activeOverlayCollections();
				if (collections.length > 0) await accessState.reflectLocalMutation?.(collections);
			});
			yield* Effect.forEach(
				[...accessState.visibleQueries.values()],
				(tracked) => tracked.queryKey === undefined
					? Effect.void
					: coverage.readWindow(tracked.queryKey, (proof) => Effect.sync(() => {
						tracked.releaseWindow?.();
						tracked.releaseWindow = coordinator.mountWindow(
							proof.queryKey,
							proof.dependencies,
							tracked.visibility,
							{
								relationDependency: hasCanonicalRelationshipSelection(
									proof.canonical['relationships']
								)
							}
						);
					})).pipe(Effect.asVoid),
				{ discard: true }
			);
		}
		const retainedWindows = yield* coverage.listWindows();
		for (const window of retainedWindows) {
			coordinator.noteRecentHydration({
				queryKey: window.id,
				lastAccess: window.lastAccess
			});
		}
		if (profileIndex !== undefined && profilePartitionId !== undefined) {
			const profile = yield* Effect.tryPromise(() => profileIndex.snapshot());
			for (const window of profile.windows) {
				if (window.partitionId !== profilePartitionId) continue;
				coordinator.noteRecentHydration({
					queryKey: window.id,
					lastAccess: window.lastAccess
				});
			}
		}
		coordinator.requestPlannedHydration();

		const refreshMutationStreamFacts = async (): Promise<void> => {
			const journals = await knownMutationJournals(runtime);
			const ids = [...new Set((await Promise.all(
				journals.map((journal) => journal.pendingAuthoritativeMutationIds())
			)).flat())].toSorted().slice(0, 256);
			pendingMutationIds = ids;
			if (!leads() || paused) return;
			const collections = subscribedCollections();
			if (collections.length === 0) {
				closeSubscription();
				return;
			}
			const [position, rehydration] = await Promise.all([
				Effect.runPromise(coverage.position()),
				rehydrationFacts()
			]);
					if (subscription === undefined) requestStream(collections, position);
					else
						subscription.update(
							collections,
							subscribedInvalidations(),
							position,
							pendingMutationIds,
							rehydration
						);
			// Pending identities ride the one long-held stream and are retained for reconnect. A lost
			// mutation response is recovered by replaying that idempotent mutation once its owner lease
			// expires; it never creates a separate status-polling channel.
		};
		const installMutationRuntime = async (): Promise<void> => {
			if (accessState === undefined || accessState.serverPartitionKey === undefined) return;
			let mutationPushRunning = false;
			let mutationPushStopped = false;
			await mutationJournalFor(runtime);
			const journals = await knownMutationJournals(runtime);
			const publishMutationSnapshot = (
				snapshot: Awaited<ReturnType<CollectionMutationJournal['snapshot']>>
			): void => {
				const active = snapshot.mutations.filter(({ pushState }) => pushState !== 'quarantined');
				accessState.syncStatus.patch({
					pendingMutations: active.length,
					issues: snapshot.issues.map((issue) =>
						issue.kind === 'rejected'
							? {
									mutationId: issue.idempotencyKey,
									kind: 'rejected' as const,
									message: issue.message,
									atEpochMs: issue.settledAtEpochMs
								}
							: {
									mutationId: issue.idempotencyKey,
									kind: 'quarantined' as const,
									message: issue.quarantine.message,
									atEpochMs: issue.settledAtEpochMs
								}
					)
				});
			};
			accessState.mutationJournalUnsubscribe?.();
			const unsubscribers = journals.map((journal) => journal.subscribe(() => {
				void accessState.refreshMutationStatus?.().catch((cause) => options.onError?.(cause));
			}));
			accessState.mutationJournalUnsubscribe = () => {
				for (const unsubscribe of unsubscribers) unsubscribe();
			};
			accessState.refreshMutationStatus = async () => {
				await refreshOverlaySnapshot();
				const snapshots = await Promise.all(journals.map((journal) => journal.snapshot()));
				publishMutationSnapshot({
					mutations: snapshots.flatMap(({ mutations }) => mutations),
					issues: snapshots.flatMap(({ issues }) => issues)
				});
				await refreshMutationStreamFacts();
			};
			await accessState.refreshMutationStatus();
			let schedule = (): void => undefined;
			const scheduleMutationPushAt = (atEpochMs: number): void => {
				if (mutationPushStopped || !leads() || paused) return;
				if (mutationPushRetryAt !== undefined && mutationPushRetryAt <= atEpochMs) return;
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetryAt = atEpochMs;
				mutationPushRetry = setTimeout(() => {
					mutationPushRetry = undefined;
					mutationPushRetryAt = undefined;
					schedule();
				}, Math.max(0, atEpochMs - Date.now()));
				const portableTimer = mutationPushRetry as unknown as { unref?: () => void };
				portableTimer.unref?.();
			};
			const scheduleInterruptedMutationReplay = async (): Promise<void> => {
				const entries = (await Promise.all(journals.map((journal) => journal.entries()))).flat();
				const replayAt = entries
					.filter(({ pushState }) => pushState === 'pushing')
					.map(({ lastAttemptAtEpochMs }) =>
						(lastAttemptAtEpochMs ?? Date.now()) + MUTATION_PUSH_STALE_AFTER_MS + 1
					)
					.toSorted((left, right) => left - right)[0];
				if (replayAt !== undefined) scheduleMutationPushAt(replayAt);
			};
			schedule = (): void => {
				if (mutationPushStopped || mutationPushRunning || !leads()) return;
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetry = undefined;
				mutationPushRetryAt = undefined;
				mutationPushRunning = true;
				void (async () => {
					try {
						for (;;) {
							const pushable = (await Promise.all(journals.map(async (journal) => ({
								journal,
								mutation: await journal.nextPushable()
							})))).find(({ mutation }) => mutation !== undefined);
							if (pushable?.mutation === undefined || mutationPushStopped || !leads()) {
								await scheduleInterruptedMutationReplay();
								return;
							}
							const journal = pushable.journal;
							const pushing = await journal.markPushing(pushable.mutation.idempotencyKey);
							let settlement: Schema.Schema.Type<typeof CollectionMutationSettlementSchema>;
							try {
								settlement = await Effect.runPromise(
									decodedCommandEffect(
										runtime,
										'collections.mutate',
										mutationWireRequest(pushing),
										CollectionMutationSettlementSchema
									).pipe(Effect.timeout(MUTATION_PUSH_STALE_AFTER_MS))
								);
							} catch (cause) {
								if (terminalMutationFailure(cause)) {
									await journal.reconcile(pushing.idempotencyKey, {
										kind: 'rejected',
										code: 'forbidden',
										message: cause instanceof Error ? cause.message : String(cause)
									});
									await refreshOverlaySnapshot();
									await releaseReplicaPendingMutationLease(runtime, pushing.idempotencyKey);
									await accessState.reflectLocalMutation?.([
										...new Set(pushing.overlay.map(({ row }) => row.collection))
									]);
									continue;
								} else {
									await journal.retry(pushing.idempotencyKey, cause);
									// The only retry timer is derived from this failed submission. It replays the
									// same idempotency key once; it never issues a status/read poll.
									scheduleMutationPushAt(Date.now() + 2_000);
									return;
								}
							}
							if (settlement.resolution === 'accepted') {
								const reconciled = await journal.reconcile(
									pushing.idempotencyKey,
									{ kind: 'accepted' }
								);
								accessState.syncStatus.patch({
									settledMutations: accessState.syncStatus.current().settledMutations + 1
								});
								if (reconciled.retirement !== undefined) {
									await refreshOverlaySnapshot();
									await releaseReplicaPendingMutationLease(
										runtime,
										reconciled.retirement.idempotencyKey
									);
									await accessState.reflectLocalMutation?.(
										reconciled.retirement.affectedCollections
									);
								}
							} else if (settlement.resolution === 'rebased') {
								const reconciled = await journal.reconcile(pushing.idempotencyKey, {
									kind: 'rebased',
									fromSchemaFingerprint: settlement.fromSchemaFingerprint,
									toSchemaFingerprint: settlement.toSchemaFingerprint
								});
								accessState.syncStatus.patch({
									settledMutations: accessState.syncStatus.current().settledMutations + 1
								});
								if (reconciled.retirement !== undefined) {
									await refreshOverlaySnapshot();
									await releaseReplicaPendingMutationLease(
										runtime,
										reconciled.retirement.idempotencyKey
									);
									await accessState.reflectLocalMutation?.(
										reconciled.retirement.affectedCollections
									);
								}
							} else if (settlement.resolution === 'rejected') {
								await journal.reconcile(pushing.idempotencyKey, {
									kind: 'rejected',
									code: settlement.code,
									message: settlement.message
								});
								await refreshOverlaySnapshot();
								await releaseReplicaPendingMutationLease(runtime, pushing.idempotencyKey);
								await accessState.reflectLocalMutation?.([
									...new Set(pushing.overlay.map(({ row }) => row.collection))
								]);
							} else {
								await journal.reconcile(pushing.idempotencyKey, {
									kind: 'quarantined',
									code: 'schema-incompatible',
									message: settlement.reason
								});
								await refreshOverlaySnapshot();
								await releaseReplicaPendingMutationLease(runtime, pushing.idempotencyKey);
								await accessState.reflectLocalMutation?.([
									...new Set(pushing.overlay.map(({ row }) => row.collection))
								]);
							}
						}
					} catch (cause) {
						options.onError?.(cause);
					} finally {
						mutationPushRunning = false;
					}
				})();
			};
			accessState.scheduleMutationPush = schedule;
			accessState.stopMutationPush = () => {
				mutationPushStopped = true;
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetry = undefined;
				mutationPushRetryAt = undefined;
			};
			schedule();
		};
		yield* Effect.tryPromise(installMutationRuntime);
		let physicalNamespaceShutdown: Promise<void> | undefined;
		const stopPhysicalNamespace = (): Promise<void> => {
			if (physicalNamespaceShutdown !== undefined) return physicalNamespaceShutdown;
			physicalNamespaceShutdown = (async () => {
				closeSubscription();
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetry = undefined;
				mutationPushRetryAt = undefined;
				if (runtime.local !== undefined) delete runtime.local.current;
				accessState?.stopMutationPush?.();
				accessState?.mutationJournalUnsubscribe?.();
				for (const demand of adjacentHydration.values()) demand.release();
				adjacentHydration.clear();
				await coordinator.stop();
				await queryMaterializationTail;
				clearInterval(visibleLeaseSweep);
				clearInterval(visiblePrioritySweep);
				if (typeof document !== 'undefined') {
					document.removeEventListener('visibilitychange', onDocumentVisibility);
				}
				await leaseOwner?.stop();
				await Effect.runPromise(local.close().pipe(Effect.catch(() => Effect.void)));
				await options.physicalLease?.stop();
				profileIndex?.close();
			})();
			return physicalNamespaceShutdown;
		};
		const switchPhysicalNamespace = async (): Promise<void> => {
			await stopPhysicalNamespace();
			if (typeof location === 'undefined' || typeof location.reload !== 'function')
				throw new Error('A changed sync partition requires a workspace shell reload.');
			location.reload();
			// Navigation owns reopening the server-selected physical namespace. Never resume the old one.
			return await new Promise<void>(() => undefined);
		};
		let partitionRebootstrap: Promise<void> | undefined;
		const rebootstrapPartition = (
			announced?: Schema.Schema.Type<typeof SyncPartitionIdentity>,
			position: { readonly cursor: SyncCursor; readonly generations: Readonly<Record<string, number>> } = {
				cursor: { xid: 0, sequence: 0 },
				generations: {}
			}
		): Promise<void> => {
			if (partitionRebootstrap !== undefined) return partitionRebootstrap;
			partitionRebootstrap = (async () => {
				closeSubscription();
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetry = undefined;
				mutationPushRetryAt = undefined;
				if (runtime.local !== undefined) delete runtime.local.current;
				if (accessState === undefined) return;
				accessState.stopMutationPush?.();
				accessState.mutationJournalUnsubscribe?.();
				delete accessState.mutationJournal;
				delete accessState.mutationJournalUnsubscribe;
				delete accessState.refreshMutationStatus;
				delete accessState.refreshOverlaySnapshot;
				const next = announced ?? (await Effect.runPromise(
					transport.command('sync.partition', {}).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(SyncPartitionStatusResponse))
					)
				)).partition;
				if (next.key !== serverPartition.key) {
					return switchPhysicalNamespace();
				}
				if (next.schemaFingerprint !== local.fingerprint)
					throw new Error('The replacement sync partition requires a different replica schema.');
				accessState.serverPartitionKey = next.key;
				accessState.schemaFingerprint = next.schemaFingerprint;
				localReader = createReader(next.key);
				recomputer = createLocalWindowRecomputer(
					local.store,
					local.shape,
					coverage,
					next.key,
					{ overlay, localActorBinding: options.partition.key }
				);
				await installMutationRuntime();
				coordinator.rebuild('authority', position);
				await coordinator.idle();
				await refreshOverlaySnapshot();
				const overlayCollections = await activeOverlayCollections();
				if (overlayCollections.length > 0)
					await accessState.reflectLocalMutation?.(overlayCollections);
				if (runtime.local !== undefined && accessScopeFor(runtime) === options.accessScope)
					runtime.local.current = localReader;
				streamIfLeading();
			})().finally(() => {
				partitionRebootstrap = undefined;
			});
			return partitionRebootstrap;
		};
		if (accessState !== undefined) accessState.rebootstrapPartition = rebootstrapPartition;

			/**
		 * Exactly one tab streams.
		 *
		 * The database is shared, so a per-tab sync loop would have every open tab fetching the same
		 * diffs and applying them to the same rows — N times the requests and N times the writes to reach
		 * one outcome, with the cursor being advanced by whichever tab got there first. Leadership is
		 * decided by Bolt's explicit Web Lock. PGlite has a separate worker-owner election, but that
		 * decides which worker executes SQL, not which document is allowed to perform network replication.
		 *
		 * A tab that is not the leader opens no stream at all, which is the point — one SSE connection
		 * per browser instead of one per tab. Browsers cap concurrent connections per host, so tabs used
		 * to compete for that budget with the very requests the pages were waiting on.
		 */
		const defaultBarrierHooks: Omit<SchemaBarrierHooks, 'leader'> = {
			readDurable: async () => {
				const durable = await Effect.runPromise(readDurableReplicaSchema(local.engine));
					return (
						durable === undefined ? {
							generation: 0,
							fingerprint: local.fingerprint,
							protocolVersion: PROTOCOL_VERSION
						} : {
							generation: durable.authorityGeneration,
							fingerprint: durable.fingerprint,
							protocolVersion: durable.protocolVersion
						}
					);
			},
			adoptGeneration: async (barrier) => {
				const adopted = {
					authorityGeneration: barrier.generation,
					fingerprint: barrier.fingerprint,
					protocolVersion: PROTOCOL_VERSION
				};
				await Effect.runPromise(
					coverage.transaction(writeDurableReplicaSchema(local.engine, adopted))
				);
				return {
					generation: adopted.authorityGeneration,
					fingerprint: adopted.fingerprint,
					protocolVersion: adopted.protocolVersion
				};
			},
			withdrawReaders: () => {
				if (runtime.local?.current === localReader && runtime.local !== undefined)
					delete runtime.local.current;
			},
			switchNamespace: () => switchPhysicalNamespace()
		};
		const selectedBarrierHooks = options.schemaBarrier ?? defaultBarrierHooks;
		const barrierController: SchemaBarrierController = createSchemaBarrierController({
			...selectedBarrierHooks,
			leader: leads,
			// This hook runs only after durable facts prove that the physical namespace must change.
			// Pausing before `accept` made every repeated, adopted barrier close its own SSE stream.
			withdrawReaders: (collections) => {
				pauseIntake();
				if (accessState !== undefined) {
					accessState.stopMutationPush?.();
					accessState.mutationJournalUnsubscribe?.();
					delete accessState.mutationJournal;
					delete accessState.mutationJournalUnsubscribe;
					delete accessState.refreshMutationStatus;
					delete accessState.refreshOverlaySnapshot;
					delete accessState.serverPartitionKey;
				}
				selectedBarrierHooks.withdrawReaders(collections);
			}
		});
		const acceptSchemaMaintenance = (
			notice: ReplicaSchemaMaintenance,
			broadcast = false
		): Promise<void> => {
			const current = maintenance;
			if (current !== undefined && notice.generation < current.generation) return maintenanceTail;
			maintenance =
				current?.generation === notice.generation
					? {
							generation: notice.generation,
							affectedCollections: [
								...new Set([...current.affectedCollections, ...notice.affectedCollections])
							]
						}
					: notice;
			// Keep the control stream alive so it can deliver the committed barrier or durable abort clear,
			// but stop this document from opening or reopening data intake until completion is proven.
			paused = true;
			// Withdrawing the reader is intentionally broader than the affected set during a namespace switch.
			if (runtime.local?.current === localReader && runtime.local !== undefined) {
				delete runtime.local.current;
			}
			if (broadcast) accessState?.invalidation?.announceMaintenance(notice);
			const affected = [...maintenance.affectedCollections];
			maintenanceTail = maintenanceTail.then(async () => {
				// The notice itself is not schema authority. It only gates promotion/delivery, waits
				// accepted work out, and withdraws proof so affected commands use the online path.
				await coordinator.idle();
				await queryMaterializationTail;
				await Effect.runPromise(coverage.invalidateDependencies(affected));
				invalidateNamed(affected);
				await Effect.runPromise(announceToTabs(affected));
			});
			return maintenanceTail;
		};
		const acceptSchemaMaintenanceClear = (
			clear: ReplicaSchemaMaintenanceClear,
			broadcast = false
		): Promise<void> => {
			if (broadcast) accessState?.invalidation?.announceMaintenanceClear(clear);
			maintenanceTail = maintenanceTail.then(async () => {
				const current = maintenance;
				// The host persists and monotonically replays its latest cleared transition. A later clear
				// is stronger proof for a tab that missed an earlier frame; an older one proves nothing.
				if (current === undefined || current.generation > clear.generation) return;
				// A clear is useful only after the host has re-read its authoritative transition state.
				// Refreshing durable metadata proves no local generation was invented during maintenance.
				const durable = await barrierController.refreshFromDurable();
				maintenance = undefined;
				if (durable.fingerprint !== local.fingerprint)
					return switchPhysicalNamespace();
				if (
					runtime.local !== undefined &&
					accessScopeFor(runtime) === options.accessScope
				) {
					runtime.local.current = localReader;
				}
				resumeIntake();
				invalidateNamed(current.affectedCollections);
			});
			return maintenanceTail;
		};
		const schemaControl = (control: ReplicaSchemaControl): void => {
			const handled =
				control._tag === 'maintenance'
					? acceptSchemaMaintenance(control.value)
					: schemaBarrierTail.then(() => acceptSchemaMaintenanceClear(control.value));
			void handled.catch((cause) => options.onError?.(cause));
		};
		if (accessState !== undefined) accessState.schemaControl = schemaControl;
		const acceptSchemaBarrier = (barrier: ReplicaSchemaBarrier): Promise<void> => {
			schemaBarrierPauses += 1;
			const accepted = schemaBarrierTail.then(async () => {
				await maintenanceTail;
				await coordinator.idle();
				await queryMaterializationTail;
				await barrierController.accept(barrier);
			});
			schemaBarrierTail = accepted.catch(() => undefined);
			return accepted.finally(() => {
				schemaBarrierPauses -= 1;
				// A failed/reload-required barrier keeps intake paused; only the final queued barrier
				// reaching a durably verified idle state may resume it.
				if (schemaBarrierPauses === 0 && barrierController.state().phase === 'idle') {
					resumeIntake();
				}
			});
		};

		let openingStream = false;
		const streamIfLeading = (
			knownCollections?: ReadonlyArray<string>,
			knownPosition?: { readonly cursor: SyncCursor; readonly generations: Readonly<Record<string, number>> }
		): void => {
			if (!leads() || subscription !== undefined || paused || openingStream) return;
			openingStream = true;
			void (async () => {
				try {
					const collections = subscribedCollections();
					const [position, rehydration] = await Promise.all([
						knownPosition === undefined
							? Effect.runPromise(coverage.position())
							: Promise.resolve(knownPosition),
						rehydrationFacts()
					]);
					if (!leads() || paused || collections.length === 0) {
						if (collections.length === 0) {
							accessState?.syncStatus.markDisconnected();
							settleCatchUp();
						}
						return;
					}
					subscription = subscribeToPartition({
						collections,
						invalidations: subscribedInvalidations(),
						position,
						pendingMutationIds,
						rehydration,
						onConnecting: () => accessState?.syncStatus.markSyncing(),
						onInvalidation: (collections) => {
							// These names were guest-authenticated when the stream was admitted. They have no
							// replica windows: drop old response metadata and re-run only Bolt's registered
							// internal `collections.findMany` reads against the tenant authority.
							invalidateRuntime(runtime, collections);
							Effect.runFork(announceToTabs(collections));
						},
				onDeltas: (batch) => {
					if (schemaBarrierPauses > 0 || maintenance !== undefined) return;
					if (accessState?.serverPartitionKey !== batch.partition.key) {
						void rebootstrapPartition(batch.partition).catch((cause) => options.onError?.(cause));
						return;
					}
					const headRollback =
						observedStreamHead !== undefined &&
						compareSyncCursors(batch.headCursor, observedStreamHead) < 0;
					observedStreamHead = batch.headCursor;
					if (headRollback) closeSubscription();
					if (accessState !== undefined) publishReplicaProgress(accessState, { phase: 'applying' });
					coordinator.acceptDeltas(batch);
					void coordinator.idle()
						.then(async () => {
							// Status-only confirmations have no readable row. Retire them only after the
							// authoritative batch has committed to the replica.
							await confirmMutationDeltas(batch);
							// A confirmation received on the one workspace stream is enough. If a command
							// response was lost, its bounded owner lease replays the same idempotency key;
							// there is no separate mutation-status polling channel.
							accessState?.scheduleMutationPush?.();
							if (batch.complete) {
								settleCatchUp();
								accessState?.syncStatus.markConnected();
							}
							if (accessState !== undefined)
								publishReplicaProgress(accessState, { phase: 'applying', completed: 1, total: 1 });
							if (headRollback) {
								await refreshOverlaySnapshot();
								const collections = await activeOverlayCollections();
								if (collections.length > 0)
									await accessState?.reflectLocalMutation?.(collections);
								streamIfLeading();
								return;
							}
							if (subscription !== undefined) {
								const rehydration = await rehydrationFacts();
								subscription.update(
									subscribedCollections(),
									subscribedInvalidations(),
									{ cursor: batch.cursor, generations: batch.generations },
									pendingMutationIds,
									rehydration
								);
							}
						})
						.catch((cause) => options.onError?.(cause));
				},
				onRecovery: (advice) => {
					closeSubscription();
					coordinator.recover(advice);
					void coordinator.idle()
						.then(() => confirmMutationDeltas({
							deltas: [],
							mutationConfirmations: advice.mutationConfirmations,
							mutationRejections: advice.mutationRejections
						}))
						.then(async () => {
							await refreshOverlaySnapshot();
							const overlayCollections = await activeOverlayCollections();
							if (overlayCollections.length > 0)
								await accessState?.reflectLocalMutation?.(overlayCollections);
							settleCatchUp();
							streamIfLeading();
						})
						.catch((cause) => options.onError?.(cause));
				},
				onReady: (ready) => {
					void (async () => {
						if (accessState?.serverPartitionKey !== ready.partition.key) {
							await rebootstrapPartition(ready.partition, {
								cursor: ready.cursor,
								generations: ready.generations
							});
							return;
						}
						const durable = await Effect.runPromise(coverage.position());
						observedStreamHead = ready.cursor;
						const rollback = compareSyncCursors(ready.cursor, durable.cursor) < 0;
						if (rollback && runtime.local !== undefined) delete runtime.local.current;
						coordinator.observeReady(ready);
						if (rollback) {
							closeSubscription();
							await coordinator.idle();
							if (runtime.local !== undefined && accessScopeFor(runtime) === options.accessScope)
								runtime.local.current = localReader;
							streamIfLeading();
							return;
						}
						/**
						 * A `ready` frame proves the stream, not that this replica is level with it.
						 *
						 * What follows a fresh connection is catch-up — replaying the deltas missed while it
						 * was down and pushing whatever was queued locally — and that is what `syncing`
						 * names. Receiving deltas on a replica that is already level is simply `connected`;
						 * calling that "syncing" would leave a healthy workspace permanently mid-sync.
						 */
						accessState?.syncStatus.markSyncing();
					})().catch((cause) => options.onError?.(cause));
				},
				onPartitionChanged: (partition) => {
					void rebootstrapPartition(partition).catch((cause) => options.onError?.(cause));
				},
				onMaintenance: (notice) => {
					void acceptSchemaMaintenance(notice, true).catch((cause) => options.onError?.(cause));
				},
				onMaintenanceClear: (clear) => {
					void schemaBarrierTail
						.then(() => acceptSchemaMaintenanceClear(clear, true))
						.catch((cause) => options.onError?.(cause));
				},
				onBarrier: (barrier) => {
					void acceptSchemaBarrier(barrier).catch((cause) => options.onError?.(cause));
				},
				onError: (cause) => {
					accessState?.syncStatus.markDisconnected();
					options.onError?.(cause);
				}
					});
				} catch (cause) {
					accessState?.syncStatus.markDisconnected();
					options.onError?.(cause);
				} finally {
					openingStream = false;
				}
			})();
		};
		requestStream = streamIfLeading;
		const leadingAtStartup = leads();
		if (!leadingAtStartup) {
			// A follower reads the same shared database its elected leader has already brought up. It opens no
			// duplicate stream of its own, so there is no local `ready` event to await in this document.
			settleCatchUp();
		}
		streamIfLeading();
		if (accessScopeFor(runtime) !== options.accessScope) {
			closeSubscription();
			yield* Effect.tryPromise(() => coordinator.stop());
			yield* local.close();
			return yield* Effect.fail(new Error('Local replica access scope changed during startup'));
		}

		/**
		 * Leadership moves when the leading tab closes, and the sync loop has to move with it.
		 *
		 * Without this, closing the one tab that happened to be elected would leave every remaining tab
		 * holding a live database that nothing was feeding: no stream, no drain, and no error — the
		 * workspace would simply stop updating until someone reloaded. The inherited stream catches up on
		 * open, so the gap between the old leader dying and the new one connecting is closed by the
		 * cursor rather than lost.
		 */
		/** From here on, only reads backed by a complete coverage proof are answered locally. */
		if (runtime.local !== undefined) runtime.local.current = localReader;
		// Install the proof-aware reader first, then reexecute mounted queries. Proven pages stay local;
		// everything else uses the authoritative command path and is captured after it returns.
		cache?.clear();
		registry?.reexecuteAffected([ANY_COLLECTION]);

		const stopWatchingLeader =
			options.leadership?.onChange(() => {
				if (leads()) {
					Effect.runFork(
						reconcileAutomationLeases().pipe(
							Effect.catch((cause) => Effect.sync(() => options.onError?.(cause)))
						)
					);
					accessState?.scheduleMutationPush?.();
					void accessState?.refreshMutationStatus?.().catch((cause) => options.onError?.(cause));
					streamIfLeading();
					return;
				}
				closeSubscription();
			}) ??
			local.engine.onLeaderChange(() => {
				if (leads()) {
					accessState?.scheduleMutationPush?.();
					void accessState?.refreshMutationStatus?.().catch((cause) => options.onError?.(cause));
					streamIfLeading();
					return;
				}
				// Demotion is possible in principle; drop the stream rather than stream in duplicate.
				closeSubscription();
			});
		// A compatible database is not a completed bootstrap. Persist the receipt only after the
		// initial authoritative drain has completed, so a failed first catch-up remains retryable.
		void initialCatchUp.then(
			() =>
				markReplicaCompatible(serverPartition.tenantId, serverPartition.key, local.fingerprint),
			// Readiness failure leaves no receipt and is owned by the bootstrap controller. Consuming it
			// here prevents this side-effect branch from creating an unhandled rejected Promise.
			() => undefined
		);

		const replicaTier: LocalReplica['tier'] =
			options.storage === undefined || options.storage.tier === 'server-only'
				? 'custom'
				: options.storage.tier;
		return {
			fingerprint: local.fingerprint,
			rows: local.rows,
			resumed: local.resumed,
			tier: replicaTier,
			partitionKey: serverPartition.key,
			principalSource: options.partition.principalSource,
			...(options.storage === undefined || options.storage.tier === 'server-only'
				? {}
				: { storageBudget: options.storage.budget }),
			leader: leads,
			clearAndRebuild: () => {
				clearReplicaCompatibility(
					serverPartition.tenantId,
					serverPartition.key,
					local.fingerprint
				);
				return Effect.runPromise(rebuildReplica());
			},
			initialCatchUpReady: initialCatchUp,
			barrier: acceptSchemaBarrier,
			refreshDurableSchema: () =>
				barrierController.refreshFromDurable().then(() => {
					if (barrierController.state().phase === 'idle') {
						resumeIntake();
					}
				}),
			stop: () => {
				// Withdrawn first: a closed database that is still being asked would fail every read that
				// had been succeeding, rather than quietly going back to the wire.
				if (runtime.local !== undefined) delete runtime.local.current;
				stopWatchingLeader?.();
				options.leadership?.stop();
				clearInterval(visibleLeaseSweep);
				clearInterval(visiblePrioritySweep);
				if (typeof document !== 'undefined') {
					document.removeEventListener('visibilitychange', onDocumentVisibility);
				}
				if (mutationPushRetry !== undefined) clearTimeout(mutationPushRetry);
				mutationPushRetry = undefined;
				mutationPushRetryAt = undefined;
				closeSubscription();
				for (const demand of adjacentHydration.values()) demand.release();
				adjacentHydration.clear();
				const syncStopped = coordinator.stop();
				const state = runtimeStates.access(runtime);
				state?.stopMutationPush?.();
				state?.mutationJournalUnsubscribe?.();
				if (state?.materializeQuery !== undefined) delete state.materializeQuery;
				if (state?.invalidateCoverage === invalidateCoverage) delete state.invalidateCoverage;
				if (state?.schemaControl === schemaControl) delete state.schemaControl;
				if (state?.trackVisibleQuery !== undefined) delete state.trackVisibleQuery;
				if (state?.releaseVisibleQuery !== undefined) delete state.releaseVisibleQuery;
				if (state?.requestAdjacentHydration !== undefined)
					delete state.requestAdjacentHydration;
				if (state?.acquirePendingMutationLease !== undefined)
					delete state.acquirePendingMutationLease;
				if (state?.releasePendingMutationLease !== undefined)
					delete state.releasePendingMutationLease;
				if (state?.automationStarted !== undefined) delete state.automationStarted;
				if (state?.automationObserved !== undefined) delete state.automationObserved;
				if (state?.automationSettled !== undefined) delete state.automationSettled;
				if (state?.partitionSync === coordinator) delete state.partitionSync;
				if (state?.windowLedger === coverage) delete state.windowLedger;
				if (state !== undefined) {
					delete state.scheduleMutationPush;
					delete state.stopMutationPush;
					delete state.rebootstrapPartition;
					delete state.reflectLocalMutation;
					delete state.mutationJournalUnsubscribe;
					delete state.mutationJournal;
					delete state.refreshMutationStatus;
					delete state.refreshOverlaySnapshot;
					delete state.readRowVersions;
					delete state.reportError;
				}
				state?.invalidation?.close();
				if (state !== undefined) delete state.invalidation;
				const closeReplica = async (): Promise<void> => {
					try {
						await syncStopped;
						await Effect.runPromise(local.close().pipe(Effect.catch(() => Effect.void)));
						await leaseOwner?.stop();
					} catch (cause) {
						options.onError?.(cause);
					} finally {
						await options.physicalLease?.stop();
						profileIndex?.close();
					}
				};
				void closeReplica();
			}
		};
		});
		return yield* initialize.pipe(
			Effect.tapError(() => local.close().pipe(Effect.catch(() => Effect.void)))
		);
	});

export type LocalReplica = Readonly<{
	readonly fingerprint: string;
	/** Query-window bootstrap copies no tenant rows; retained for the host progress contract. */
	readonly rows: number;
	/** Whether this partition already held a compatible durable database before this start. */
	readonly resumed: boolean;
	readonly tier: ReplicaStorageTier | 'custom';
	/** Full tenant/environment/principal/authority/format identity; contains no bearer credential. */
	readonly partitionKey: string;
	readonly principalSource: 'principal';
	/** Physical origin budget for a persistent tier; coverage eviction consumes this policy. */
	readonly storageBudget?: ReplicaStorageBudget | undefined;
	/** Whether this tab holds the shared database and therefore runs the sync loop. */
	readonly leader: () => boolean;
	/** Verified runtime-owned recovery: clears only the reconstructible local copy. */
	readonly clearAndRebuild: () => Promise<void>;
	/** Resolves after the physical partition's initial catch-up reaches the live edge. */
	readonly initialCatchUpReady: Promise<void>;
	/** Switches to the server-selected physical namespace after a committed schema barrier. */
	readonly barrier?: ((barrier: ReplicaSchemaBarrier) => Promise<void>) | undefined;
	/** Broadcast handlers call this wake-up hook; it trusts only the state re-read from PGlite. */
	readonly refreshDurableSchema?: (() => Promise<void>) | undefined;
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
	// A full persisted namespace needs an async SHA-256 principal fingerprint. Until replica startup
	// resolves it, use a document-private namespace that cannot paint another principal's cached rows.
		const accessState: RuntimeAccessState = {
			current: normalizedAccessScope(session.accessScope),
			catalog: {},
			syncStatus: createWorkspaceSyncStatus(),
			staleWindowKeys: new Set(),
		cache: createQueryCache(ephemeralCacheNamespace()),
		visibleQueries: new Map(),
		progressListeners: new Set(),
		progress: { phase: 'preparing' }
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
			syncStatus: MutableWorkspaceSyncStatusSignal;
	} = {
		bolt,
		db: {},
		local: {},
			cache,
			queries: createLiveQueryRegistry(),
			syncStatus: accessState.syncStatus
	};
	runtimeStates.rememberAccess(runtime, accessState);
	runtime.db = ClientDatabase.database(runtime, {});
	return runtime;
};
