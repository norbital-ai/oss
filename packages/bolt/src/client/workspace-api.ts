import { Effect, Result, Schema } from 'effect';
import {
	ApprovalState,
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	SyncQueryInput,
	type CollectionMutationBaseVersion,
	type CollectionMutationGraph,
	type StoredRecord,
	type SyncQueryInput as SyncQueryInputType
} from '@norbital-ai/bolt-protocol';
import type { CollectionFilter, CollectionFilterOptions } from '@norbital-ai/std/collection';
import type {
	MemoryMutationResult,
	RemoteQuery,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';
import type { ClientState, QueryState } from './sync/index.js';
import { project } from './live-query/index.js';
import { createMachineQuery, createRemoteQuery } from './remote-query.svelte.js';
import { CollectionMutationState } from './collection-mutation.svelte.js';
import { AutomationExecutionState, AutomationTaskSnapshot } from './automation-client.svelte.js';
import { createSystemClient } from './system-client.js';

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
}

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

export type WorkspaceApiVisibility = Readonly<{
	/** Exact generic collection names published through this proxy. Omission means framework-internal. */
	readonly allowedCollections?: ReadonlyArray<string>;
	/** Published read surfaces whose framework-owned writes remain structurally absent. */
	readonly readOnlyCollections?: ReadonlyArray<string>;
	/** System commands are a Bolt shell capability, not part of an authored workspace client. */
	readonly system?: boolean;
}>;

/** Nests a CollectionTable filter path into the JSON where compileWhere already understands. */
const filterToWhere = (filter: CollectionFilter): Schema.Json => {
	const leaf = filter.path[filter.path.length - 1];
	if (leaf === undefined) return {};
	let node: Record<string, Schema.Json> = {
		[leaf]:
			filter.operand === undefined
				? { [filter.operator]: true }
				: { [filter.operator]: filter.operand as Schema.Json }
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
	options?: CollectionFilterOptions
): Readonly<Record<string, Schema.Json>> => {
	const filters = options?.filters ?? [];
	if (filters.length === 0) return query;
	const clauses = filters.map(filterToWhere);
	// Surface filters are independently canonicalized narrowing. They must not be folded into the
	// authored predicate: the server enforces both, while the query input preserves which
	// constraint came from the workspace and which came from the current user surface.
	const existing = query['userFilter'];
	const first = clauses[0];
	const combined =
		existing === undefined
			? clauses.length === 1 && first !== undefined
				? first
				: { AND: clauses }
			: { AND: [existing, ...clauses] };
	return { ...query, userFilter: combined };
};

/**
 * Optional query properties are routinely assembled as `key: undefined`. Undefined has no JSON
 * representation and means exactly the same thing as omission here, so remove it before the wire
 * sees the value.
 */
const asJsonRecord = (input: unknown): Readonly<Record<string, Schema.Json>> => {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
	const record: Record<string, Schema.Json> = {};
	for (const [key, value] of Object.entries(input)) {
		if (value !== undefined) record[key] = value as Schema.Json;
	}
	return record;
};

const rowListOf = (value: unknown): ReadonlyArray<StoredRecord> | undefined =>
	Array.isArray(value) && value.every((row) => typeof row === 'object' && row !== null)
		? (value as ReadonlyArray<StoredRecord>)
		: undefined;

/**
 * The row-shaped answers a collection read may hold: a plain list, or the cursored-page arm whose
 * `nextCursor` slot rides beside the rows (§1.7 keeps `after`/`nextCursor` answered). A findFirst
 * singleton is deliberately not unwrapped here — an authored row is free to carry fields of those
 * names, and only a cursored findMany answers the arm.
 */
const pageAnswerOf = (
	value: unknown
):
	| Readonly<{ readonly rows: ReadonlyArray<StoredRecord>; readonly nextCursor: string | null }>
	| undefined => {
	if (Array.isArray(value)) {
		const rows = rowListOf(value);
		return rows === undefined ? undefined : { rows, nextCursor: null };
	}
	if (value === null || typeof value !== 'object') return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	const rows = rowListOf(record['rows']);
	if (rows === undefined) return undefined;
	const nextCursor = record['nextCursor'];
	return typeof nextCursor === 'string' || nextCursor === null ? { rows, nextCursor } : undefined;
};

/** Validates the wire-shaped query input the browser just built; a malformed input fails loudly. */
const syncInputOf = (input: Record<string, Schema.Json>): SyncQueryInputType =>
	Schema.decodeUnknownSync(SyncQueryInput)(input);

const decodedCommandEffect = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Schema.Json,
	output: Output
): Effect.Effect<Output['Type'], unknown> =>
	Effect.tryPromise({
		try: () => runtime.bolt.command(command, input, output),
		catch: (cause) => cause
	});

const pendingGraphs = (
	state: ClientState
): ReadonlyArray<{ readonly graph: CollectionMutationGraph }> =>
	[...state.writes.values()].map((write) => ({ graph: write.request.graph }));

const rowVersionOf = (row: StoredRecord): number | undefined => {
	const value = row['row_version'];
	if (typeof value === 'number')
		return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const answerRows = (query: QueryState): ReadonlyArray<StoredRecord> => {
	const answer = query.answer;
	if (answer === undefined || answer === null || typeof answer === 'number') return [];
	switch (query.input.kind) {
		case 'count':
			return [];
		case 'findFirst':
			return Array.isArray(answer) ? answer : [answer as StoredRecord];
		case 'findMany':
			if (Array.isArray(answer)) return answer;
			return rowListOf(Reflect.get(answer, 'rows')) ?? [];
		case 'findGrouped':
			if (Array.isArray(answer)) return [];
			return Object.values(answer).flatMap((rows) => rowListOf(rows) ?? []);
	}
};

/**
 * The newest whole-row version already held by this browser for each authoritative coordinate.
 * Multiple live views may hold the same row; choosing the greatest observed version avoids
 * manufacturing a conflict from a retained older page while the server still remains final.
 */
const authoritativeVersions = (state: ClientState): ReadonlyMap<string, number> => {
	const versions = new Map<string, number>();
	for (const query of state.queries.values()) {
		for (const row of answerRows(query)) {
			const id = row['id'];
			const version = rowVersionOf(row);
			if (typeof id !== 'string' || id.length === 0 || version === undefined) continue;
			const key = `${query.input.collection}\u0000${id}`;
			versions.set(key, Math.max(versions.get(key) ?? 0, version));
		}
	}
	return versions;
};

/** Builds the exact existing-row vector the protocol requires for a browser mutation graph. */
export const collectionMutationBaseVersions = (
	state: ClientState,
	graph: CollectionMutationGraph,
	catalog: CollectionCatalog
): ReadonlyArray<CollectionMutationBaseVersion> => {
	const authoritative = authoritativeVersions(state);
	const versions = new Map<string, CollectionMutationBaseVersion>();
	const addKnown = (collection: string, recordId: string): void => {
		const key = `${collection}\u0000${recordId}`;
		const rowVersion = authoritative.get(key);
		if (rowVersion === undefined || versions.has(key)) return;
		versions.set(key, { row: { collection, recordId }, rowVersion });
	};
	const walkManyRelations = (
		collection: string,
		values: Readonly<Record<string, Schema.Json>>
	): void => {
		for (const relation of catalog[collection]?.relationships ?? []) {
			if (relation.cardinality !== 'many') continue;
			const children = values[relation.name];
			if (!Array.isArray(children)) continue;
			for (const child of children) {
				if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
				const childValues = child as Readonly<Record<string, Schema.Json>>;
				const childId = childValues['id'];
				if (typeof childId !== 'string' || childId.length === 0) continue;
				addKnown(relation.target, childId);
				walkManyRelations(relation.target, childValues);
			}
		}
	};

	if (graph.action === 'delete') addKnown(graph.collection, graph.id);
	else {
		const rootId = graph.values['id'];
		if (graph.action === 'update' && typeof rootId === 'string' && rootId.length > 0)
			addKnown(graph.collection, rootId);
		walkManyRelations(graph.collection, graph.values);
	}
	return [...versions.values()];
};

const queryAt = (state: ClientState, key: string): QueryState | undefined => state.queries.get(key);

/** --- live collection reads: the Machine holds the answer, `project()` paints pending writes --- */

const liveQueryOf = <Value>(
	runtime: WorkspaceClientRuntime,
	input: SyncQueryInputType,
	read: (state: ClientState, key: string) => Value | undefined,
	oneshot = false
): RemoteQuery<Value> => {
	const mounted = runtime.sync.mount(input);
	return createMachineQuery(runtime.sync, mounted, (state) => read(state, mounted.key), oneshot);
};

const pageQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {},
	options?: CollectionFilterOptions
): CollectionPageQuery<ReadonlyArray<Schema.Json>> => {
	const request = syncInputOf({
		kind: 'findMany',
		collection,
		...mergeWhere(asJsonRecord(input), options)
	});
	// A cursored read is one-shot, never live (RFC §2.3): it is mounted, answered once at the
	// handshake or as a one-entry connect, then released — the unmounted control message still
	// fires, so the host stops computing for the page after RETAIN_MS. The growing-window list
	// that needs more rows re-asks with a larger limit; it never tiles cursored pages.
	const cursored = request.kind === 'findMany' && request.after !== undefined;
	let nextCursor: string | null = null;
	const query = liveQueryOf(
		runtime,
		request,
		(state, key) => {
			const page = pageAnswerOf(queryAt(state, key)?.answer);
			if (page === undefined) return undefined;
			nextCursor = page.nextCursor;
			return project(page.rows, pendingGraphs(state), collection);
		},
		cursored
	);
	return {
		get current() {
			return query.current;
		},
		get error() {
			return query.error;
		},
		get loading() {
			return query.loading;
		},
		then: query.then,
		get nextCursor() {
			// `nextCursor` is filled by the same Machine projection as `current`, but this wrapper's
			// local variable is deliberately not a second Svelte state store. Reading `current` here
			// subscribes callers to that publication, so a pagination bar first painted while the
			// query was pending is invalidated when the answered page supplies its continuation.
			void query.current;
			return nextCursor;
		}
	};
};

const firstQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {}
): RemoteQuery<Schema.Json | undefined> =>
	liveQueryOf(
		runtime,
		syncInputOf({ kind: 'findFirst', collection, ...asJsonRecord(input) }),
		(state, key) => {
			const answer = queryAt(state, key)?.answer;
			if (answer === undefined || answer === null || typeof answer === 'number') return undefined;
			const rows = Array.isArray(answer) ? answer : [answer];
			return project(rows, pendingGraphs(state), collection)[0];
		}
	);

const countQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {},
	options?: CollectionFilterOptions
): RemoteQuery<number> =>
	liveQueryOf(
		runtime,
		syncInputOf({
			kind: 'count',
			collection,
			...mergeWhere(asJsonRecord(input), options)
		}),
		(state, key) => {
			const answer = queryAt(state, key)?.answer;
			return typeof answer === 'number' ? answer : undefined;
		}
	);

const groupedQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json,
	options?: CollectionFilterOptions
): RemoteQuery<Readonly<Record<string, ReadonlyArray<Schema.Json>>>> =>
	liveQueryOf(
		runtime,
		syncInputOf({
			kind: 'findGrouped',
			collection,
			...mergeWhere(asJsonRecord(input), options)
		}),
		(state, key) => {
			const answer = queryAt(state, key)?.answer;
			if (answer === undefined || answer === null || typeof answer === 'number') return undefined;
			if (Array.isArray(answer)) return undefined;
			const groups: Record<string, ReadonlyArray<Schema.Json>> = {};
			for (const [name, rows] of Object.entries(answer)) {
				const held = rowListOf(rows);
				if (held === undefined) return undefined;
				groups[name] = project(held, pendingGraphs(state), collection);
			}
			return groups;
		}
	);

/** --- one-shot command reads: answered once over the transport, never registered live --- */

const commandQueryOf = <
	Input extends Schema.ConstraintDecoder<Schema.Json>,
	Output extends Schema.ConstraintDecoder<Schema.Json>
>(
	runtime: WorkspaceClientRuntime,
	command: string,
	input: Input['Type'],
	inputSchema: Input,
	outputSchema: Output,
	signal?: AbortSignal
): RemoteQuery<Output['Type']> =>
	createRemoteQuery(
		() =>
			Effect.gen(function* () {
				const checked = yield* Schema.decodeUnknownEffect(inputSchema)(input);
				const payload = yield* Schema.decodeUnknownEffect(Schema.Json)(checked);
				return yield* Effect.tryPromise({
					try: () => runtime.bolt.command(command, payload, outputSchema, signal),
					catch: (cause) => cause
				});
			}),
		outputSchema
	);

/** --- collection surfaces --- */

const stripWrites = (member: PropertyKey): boolean =>
	member === 'mutate' || member === 'delete' || member === 'pending';

const ClientDatabase = {
	collection: (runtime: WorkspaceClientRuntime, collection: string, catalog: CollectionCatalog) => {
		const mutation = new CollectionMutationState();
		return {
			findMany: (input: Schema.Json = {}, options?: CollectionFilterOptions) =>
				pageQueryOf(runtime, collection, input, options),
			findFirst: (input: Schema.Json = {}) => firstQueryOf(runtime, collection, input),
			findGrouped: (input: Schema.Json, options?: CollectionFilterOptions) =>
				groupedQueryOf(runtime, collection, input, options),
			count: (input: Schema.Json = {}, options?: CollectionFilterOptions) =>
				countQueryOf(runtime, collection, input, options),
			/**
			 * Submits one declarative graph and resolves immediately with the optimistic row. The
			 * authority settles the write asynchronously through the returned handle; nothing is
			 * claimed saved before that outcome (durability is this tab's memory).
			 */
			mutate: (input: Schema.Json) =>
				mutation.run(
					Effect.sync(() => enqueueMutation(runtime, catalog, collection, asJsonRecord(input)))
				),
			delete: (id: string) =>
				mutation.run(Effect.sync(() => enqueueDeletion(runtime, catalog, collection, id))),
			get pending() {
				return mutation.pending;
			}
		};
	},
	database: (
		runtime: WorkspaceClientRuntime,
		allowedCollections?: ReadonlySet<string>,
		readOnlyCollections: ReadonlySet<string> = new Set(),
		catalog: CollectionCatalog = {}
	): Readonly<Record<string, unknown>> => {
		const collections = new Map<string, unknown>();
		return new Proxy<Record<string, unknown>>(
			{},
			{
				get: (_target, property) => {
					if (typeof property !== 'string') return undefined;
					if (allowedCollections !== undefined && !allowedCollections.has(property))
						return undefined;
					const existing = collections.get(property);
					if (existing !== undefined) return existing;
					const created = readOnlyCollections.has(property)
						? new Proxy(ClientDatabase.collection(runtime, property, catalog), {
								get: (target, member, receiver) =>
									stripWrites(member) ? undefined : Reflect.get(target, member, receiver),
								has: (target, member) => !stripWrites(member) && Reflect.has(target, member),
								ownKeys: (target) =>
									Reflect.ownKeys(target).filter((member) => !stripWrites(member)),
								getOwnPropertyDescriptor: (target, member) =>
									stripWrites(member) ? undefined : Reflect.getOwnPropertyDescriptor(target, member)
							})
						: ClientDatabase.collection(runtime, property, catalog);
					collections.set(property, created);
					return created;
				}
			}
		);
	}
};

const submitGraph = (
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	graph: CollectionMutationGraph,
	row: Readonly<Record<string, Schema.Json>> | null
): MemoryMutationResult => {
	const idempotencyKey = CollectionMutationIdempotencyKey.make(crypto.randomUUID());
	const settlement = runtime.settlements.create(idempotencyKey);
	const request = Schema.decodeUnknownSync(CollectionMutateRequest)({
		protocolVersion: 2,
		idempotencyKey,
		issuedAtEpochMs: Date.now(),
		partitionKey: runtime.mutation.partitionKey,
		schemaFingerprint: runtime.mutation.schemaFingerprint,
		graph,
		baseVersions: collectionMutationBaseVersions(runtime.sync.current(), graph, catalog)
	});
	runtime.sync.enqueue(request);
	return { durability: 'memory', pending: true, row, idempotencyKey, settlement };
};

const enqueueMutation = (
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	collection: string,
	values: Readonly<Record<string, Schema.Json>>
): MemoryMutationResult => {
	const submittedId = values['id'];
	if (submittedId !== undefined && (typeof submittedId !== 'string' || submittedId.trim() === ''))
		throw new TypeError(`Mutation ${collection} id must be a non-empty string`);
	if (typeof submittedId === 'string')
		return submitGraph(runtime, catalog, { action: 'update', collection, values }, values);
	const id = crypto.randomUUID();
	const created = { ...values, id };
	return submitGraph(runtime, catalog, { action: 'create', collection, values: created }, created);
};

const enqueueDeletion = (
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	collection: string,
	id: string
): MemoryMutationResult => {
	if (id.trim() === '') throw new TypeError(`Mutation ${collection} id must be a non-empty string`);
	return submitGraph(runtime, catalog, { action: 'delete', collection, id }, null);
};

/** --- automations --- */

const AutomationStartResponse = Schema.Struct({ taskId: Schema.NonEmptyString });
const AutomationStopResponse = Schema.Struct({ stopped: Schema.Literal(true) });
const AutomationRunRow = Schema.Struct({
	task_id: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'running', 'done', 'failed']),
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

/** One run's live snapshot, decoded from the same Machine-held answer as any collection read. */
const automationRunQuery = (
	runtime: WorkspaceClientRuntime,
	taskId: string
): RemoteQuery<AutomationTaskSnapshot | null> => {
	const mounted = runtime.sync.mount(
		syncInputOf({
			kind: 'findMany',
			collection: 'automation_run',
			where: { task_id: { eq: taskId } },
			limit: 1
		})
	);
	return createMachineQuery(runtime.sync, mounted, (state) => {
		const rows = rowListOf(queryAt(state, mounted.key)?.answer);
		if (rows === undefined) return undefined;
		const row = rows[0];
		if (row === undefined) return null;
		const decoded = Schema.decodeUnknownResult(AutomationRunRow)(row);
		return Result.isFailure(decoded) ? null : projectAutomationRun(decoded.success);
	});
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
					(taskId) => automationRunQuery(runtime, taskId),
					(taskId) =>
						decodedCommandEffect(
							runtime,
							'automations.stop',
							{ name: property, taskId },
							AutomationStopResponse
						).pipe(Effect.asVoid)
				);
				const created = {
					run: state.run,
					stop: state.stop,
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

/** --- the workspace API proxy --- */

type InvokeMethod = (input: Schema.Json) => RemoteQuery<Schema.Json>;

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

/** Groups workspace API construction with the query factories it exposes. */
const WorkspaceApis = {
	create: (
		runtime: WorkspaceClientRuntime,
		catalog: CollectionCatalog = {},
		visibility: WorkspaceApiVisibility = {}
	) => {
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
			db: ClientDatabase.database(runtime, allowedCollections, readOnlyCollections, catalog),
			automations: automationClient(runtime),
			invoke: new Proxy<Record<string, InvokeMethod>>(
				{},
				{
					get: (_target, property) =>
						typeof property === 'string'
							? (input: Schema.Json) =>
									commandQueryOf(runtime, `invoke.${property}`, { input }, Schema.Json, Schema.Json)
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
					return pageQueryOf(runtime, collection, asJsonRecord(input));
				}
			},
			history: {
				findMany: (collection: string, recordId: string) => {
					assertCollectionAllowed(collection);
					return commandQueryOf(
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
					commandQueryOf(
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
							const state = yield* decodedCommandEffect(
								runtime,
								'approvals.status',
								{ requestId: input.approvalRequestId },
								Schema.Json
							);
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
							yield* decodedCommandEffect(
								runtime,
								'approvals.decide',
								{
									state: decodedState.success,
									decision,
									...(input.comments === undefined ? {} : { reason: input.comments })
								},
								Schema.Json
							);
						})
					),
				withdraw: (approvalRequestId: string) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const state = yield* decodedCommandEffect(
								runtime,
								'approvals.status',
								{ requestId: approvalRequestId },
								Schema.Json
							);
							const decodedState = Schema.decodeUnknownResult(ApprovalState)(state);
							if (Result.isFailure(decodedState)) return;
							yield* decodedCommandEffect(
								runtime,
								'approvals.withdraw',
								{ state: decodedState.success },
								Schema.Json
							);
						})
					)
			}
		};
		if (visibility.system === false) return publicApi;
		return {
			...publicApi,
			system: createSystemClient(runtime, (command, input, inputSchema, outputSchema, signal) =>
				commandQueryOf(runtime, command, input, inputSchema, outputSchema, signal)
			)
		};
	}
};

export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	visibility: WorkspaceApiVisibility & { readonly system: false }
): Omit<ReturnType<typeof WorkspaceApis.create>, 'system'>;
export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog?: CollectionCatalog,
	visibility?: WorkspaceApiVisibility
): ReturnType<typeof WorkspaceApis.create>;
export function createWorkspaceApiProxy(
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog = {},
	visibility: WorkspaceApiVisibility = {}
): ReturnType<typeof WorkspaceApis.create> {
	return WorkspaceApis.create(runtime, catalog, visibility);
}

/** The database proxy a raw runtime exposes before any generated catalog narrows it. */
export const databaseOf = (runtime: WorkspaceClientRuntime): Readonly<Record<string, unknown>> =>
	ClientDatabase.database(runtime);
