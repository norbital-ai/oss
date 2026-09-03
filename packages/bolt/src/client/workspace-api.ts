import { Effect, Result, Schema } from 'effect';
import {
	ApprovalState,
	CollectionGroupedQueryRequest,
	CollectionMutationIdempotencyKey,
	CollectionMutateRequest,
	CollectionQueryRequest,
	mutationGraphDeleteIds,
	FixedCommandCatalogue,
	SyncQueryInput,
	WorkspaceInvokeContract,
	type CommandContract,
	type FixedCommandContract,
	type FixedCommandName,
	type CollectionMutationBaseVersion,
	type CollectionMutationGraph,
	type StoredRecord,
	type SyncQueryInput as SyncQueryInputType
} from '@norbital-ai/bolt-protocol';
import type { CollectionFilter, CollectionFilterOptions } from '@norbital-ai/std/collection';
import { toError } from '@norbital-ai/std/error';
import { decodeNumber } from '@norbital-ai/std/json';
import type {
	MemoryMutationResult,
	RemoteQuery,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';
import { decodeUnknownSchema } from '#lib/schema-decode.js';
import type { ClientState, QueryState } from './sync/index.js';
import { project } from './live-query/index.js';
import { createMachineQuery, createRemoteQuery } from './remote-query.svelte.js';
import { CollectionMutationState } from './collection-mutation.svelte.js';
import { AutomationExecutionState, AutomationTaskSnapshot } from './automation-client.svelte.js';

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
	/** Grows a live contiguous prefix at its current version; anchored pages do not extend. */
	readonly extend: (requestedPrefix: number) => void;
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

/** Nests a CollectionTable filter path into the declarative predicate grammar. */
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

const CollectionCount = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const CollectionGroupedRows = Schema.Record(
	Schema.String,
	Schema.Array(Schema.Record(Schema.String, Schema.Json))
);
const JsonRows = Schema.Array(Schema.Json);
const JsonGroupedRows = Schema.Record(Schema.String, Schema.Array(Schema.Json));

/** Validates the wire-shaped query input the browser just built; a malformed input fails loudly. */
const syncInputOf = (input: Record<string, Schema.Json>): SyncQueryInputType =>
	Schema.decodeUnknownSync(SyncQueryInput)(input);

/** Authored remotes are a prefix, not a fixed catalogue entry. Everything else is. */
type ClientCommandName = FixedCommandName | `invoke.${string}`;

/** Live contiguous prefix, or one answered-only keyset page. RFC/sync-engine.md §paging. */
type CollectionReadMode = { readonly kind: 'live' } | { readonly kind: 'anchored' };

const collectionReadMode = (after: Schema.Json | undefined): CollectionReadMode =>
	after === undefined ? { kind: 'live' } : { kind: 'anchored' };

const decodedCommandEffect = <Name extends FixedCommandName, Output extends Schema.Top>(
	runtime: WorkspaceClientRuntime,
	command: Name,
	input: Schema.Json,
	output: Output
): Effect.Effect<Schema.Schema.Type<Output>, Error> =>
	Effect.tryPromise({
		try: () => runtime.bolt.command(command, input, output),
		catch: toError
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
	const parsed = decodeNumber(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const prefixRows = (query: QueryState): ReadonlyArray<StoredRecord> => query.prefix?.rows ?? [];

/**
 * The newest whole-row version currently rendered by this browser for each mutation target.
 * Multiple live views may render the same row; choosing the greatest observed version avoids
 * manufacturing a conflict from a retained older page while the server still remains final.
 */
const authoritativeVersions = (state: ClientState): ReadonlyMap<string, number> => {
	const versions = new Map<string, number>();
	for (const query of state.queries.values()) {
		for (const row of prefixRows(query)) {
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
const collectionMutationBaseVersions = (
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

	if (graph.action === 'delete') {
		for (const recordId of mutationGraphDeleteIds(graph)) addKnown(graph.collection, recordId);
	}
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
	read: (state: ClientState, key: string) => Value | undefined
): RemoteQuery<Value> => {
	const mounted = runtime.sync.mount(input);
	return createMachineQuery(runtime.sync, mounted, (state) => read(state, mounted.key));
};

const pageQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {},
	options?: CollectionFilterOptions
): CollectionPageQuery<ReadonlyArray<Schema.Json>> => {
	const requestFields: Readonly<Record<string, Schema.Json>> = {
		collection,
		...mergeWhere(asJsonRecord(input), options)
	};
	const mode = collectionReadMode(requestFields['after']);
	switch (mode.kind) {
		case 'anchored': {
			const request = Schema.decodeUnknownSync(CollectionQueryRequest)(requestFields);
			let nextCursor: string | null | undefined;
			const query = createRemoteQuery(
				() =>
					commandEffectOf(runtime, 'collections.findMany', request).pipe(
						Effect.map((page) => {
							nextCursor = page.nextCursor;
							return project(page.rows, pendingGraphs(runtime.sync.current()), collection);
						})
					),
				JsonRows
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
					void query.current;
					return nextCursor;
				},
				extend: () => {
					throw new Error('Anchored collection pages are one-shot and cannot extend a live prefix');
				}
			};
		}
		case 'live': {
			const request = syncInputOf({
				kind: 'findMany',
				...requestFields
			});
			const mounted = runtime.sync.mount(request);
			const query = createMachineQuery(runtime.sync, mounted, (state) => {
				const rows = queryAt(state, mounted.key)?.prefix?.rows;
				return rows === undefined ? undefined : project(rows, pendingGraphs(state), collection);
			});
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
				nextCursor: null,
				extend: mounted.extend
			};
		}
		default: {
			const _exhaustive: never = mode;
			return _exhaustive;
		}
	}
};

const firstQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {}
): RemoteQuery<Schema.Json | undefined> => {
	const requestFields: Readonly<Record<string, Schema.Json>> = {
		collection,
		...asJsonRecord(input)
	};
	const mode = collectionReadMode(requestFields['after']);
	switch (mode.kind) {
		case 'anchored': {
			const query = commandQueryFromContract(
				runtime,
				'collections.findFirst',
				Schema.decodeUnknownSync(CollectionQueryRequest)(requestFields)
			);
			return {
				get current() {
					return query.current ?? undefined;
				},
				get error() {
					return query.error;
				},
				get loading() {
					return query.loading;
				},
				then: (onfulfilled, onrejected) =>
					Promise.resolve(query)
						.then((row) => row ?? undefined)
						.then(onfulfilled, onrejected)
			};
		}
		case 'live':
			return liveQueryOf(
				runtime,
				syncInputOf({ kind: 'findFirst', ...requestFields }),
				(state, key) => {
					const rows = queryAt(state, key)?.prefix?.rows;
					if (rows === undefined) return undefined;
					return project(rows, pendingGraphs(state), collection)[0];
				}
			);
		default: {
			const _exhaustive: never = mode;
			return _exhaustive;
		}
	}
};

const countQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json = {},
	options?: CollectionFilterOptions
): RemoteQuery<number> =>
	commandQueryOf(
		runtime,
		'collections.count',
		Schema.decodeUnknownSync(CollectionQueryRequest)({
			collection,
			...mergeWhere(asJsonRecord(input), options)
		}),
		CollectionQueryRequest,
		CollectionCount
	);

const groupedQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	input: Schema.Json,
	options?: CollectionFilterOptions
): RemoteQuery<Readonly<Record<string, ReadonlyArray<Schema.Json>>>> =>
	createRemoteQuery(() => {
		const request = Schema.decodeUnknownSync(CollectionGroupedQueryRequest)({
			collection,
			...mergeWhere(asJsonRecord(input), options)
		});
		return decodedCommandEffect(
			runtime,
			'collections.findGrouped',
			request,
			CollectionGroupedRows
		).pipe(
			Effect.map((answer) => {
				const groups: Record<string, ReadonlyArray<Schema.Json>> = {};
				for (const [name, rows] of Object.entries(answer)) {
					groups[name] = project(rows, pendingGraphs(runtime.sync.current()), collection);
				}
				return groups;
			})
		);
	}, JsonGroupedRows);

/** --- one-shot command reads: answered once over the transport, never registered live --- */

const commandQueryOf = <Input extends Schema.Top, Output extends Schema.Top>(
	runtime: WorkspaceClientRuntime,
	command: ClientCommandName,
	input: unknown,
	inputSchema: Input,
	outputSchema: Output,
	signal?: AbortSignal
): RemoteQuery<Schema.Schema.Type<Output>> =>
	createRemoteQuery(
		() =>
			Effect.gen(function* () {
				const checked = yield* decodeUnknownSchema(inputSchema, input) as Effect.Effect<
					Schema.Schema.Type<Input>,
					Schema.SchemaError
				>;
				const payload = Schema.decodeUnknownSync(Schema.Json)(checked);
				return yield* Effect.tryPromise({
					try: () => runtime.bolt.command(command, payload, outputSchema, signal),
					catch: toError
				});
			}),
		outputSchema
	);

type InputOf<Contract extends CommandContract> = Schema.Schema.Type<Contract['input']>;
type OkValue<Contract extends CommandContract> = Extract<
	Contract['responses'][number],
	{ readonly status: 200 }
>['value'];
type OutputOf<Contract extends CommandContract> = Schema.Schema.Type<OkValue<Contract>>;
type ContractFor<Name extends FixedCommandName> = Extract<
	FixedCommandContract,
	Readonly<{ name: Name }>
>;
type ClientContract = Extract<FixedCommandContract, { readonly clientPath: ReadonlyArray<string> }>;
type ClientLeaf<Contract extends ClientContract> = Contract['clientMode'] extends 'query'
	? (input: InputOf<Contract>, signal?: AbortSignal) => RemoteQuery<OutputOf<Contract>>
	: (input: InputOf<Contract>, signal?: AbortSignal) => Effect.Effect<OutputOf<Contract>, Error>;
type Nest<Path extends ReadonlyArray<string>, Value> = Path extends readonly [
	infer Head extends string,
	...infer Tail extends ReadonlyArray<string>
]
	? Readonly<Record<Head, Nest<Tail, Value>>>
	: Value;
type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
	value: infer Intersection
) => void
	? Intersection
	: never;
type ProjectContract<Contract extends ClientContract> = Contract extends unknown
	? Nest<Contract['clientPath'], ClientLeaf<Contract>>
	: never;
export type SystemClientApi = UnionToIntersection<ProjectContract<ClientContract>>;

const clientResponse = <Contract extends CommandContract>(contract: Contract): OkValue<Contract> => {
	const declared = contract.responses.find(({ status }) => status === 200);
	if (declared === undefined)
		throw new Error(`Client-visible command ${contract.name} declares no 200 response`);
	return declared.value as OkValue<Contract>;
};

const fixedContract = <Name extends FixedCommandName>(name: Name): ContractFor<Name> => {
	const contract = FixedCommandCatalogue.find((candidate) => candidate.name === name);
	if (contract === undefined) throw new Error(`Missing fixed command contract: ${name}`);
	return contract as ContractFor<Name>;
};

const commandPayload = <S extends Schema.Top>(schema: S, input: unknown): Schema.Json =>
	Schema.decodeUnknownSync(Schema.Json)(
		Effect.runSync(
			decodeUnknownSchema(schema, input) as Effect.Effect<
				Schema.Schema.Type<S>,
				Schema.SchemaError
			>
		)
	);

const commandEffectOf = <Name extends FixedCommandName>(
	runtime: WorkspaceClientRuntime,
	name: Name,
	input: InputOf<ContractFor<Name>>,
	signal?: AbortSignal
): Effect.Effect<OutputOf<ContractFor<Name>>, Error> => {
	const contract = fixedContract(name);
	const output = clientResponse(contract);
	return Effect.tryPromise({
		try: () => runtime.bolt.command(name, commandPayload(contract.input, input), output, signal),
		catch: toError
	});
};

const commandQueryFromContract = <Name extends FixedCommandName>(
	runtime: WorkspaceClientRuntime,
	name: Name,
	input: InputOf<ContractFor<Name>>,
	signal?: AbortSignal
): RemoteQuery<OutputOf<ContractFor<Name>>> => {
	const contract = fixedContract(name);
	return commandQueryOf(runtime, name, input, contract.input, clientResponse(contract), signal);
};

/** Builds browser commands directly from the protocol catalogue; no client-local schema map exists. */
const createSystemClient = (runtime: WorkspaceClientRuntime): SystemClientApi => {
	const root: Record<string, unknown> = {};
	for (const contract of FixedCommandCatalogue) {
		if (!('clientPath' in contract) || contract.clientPath === undefined) continue;
		let parent = root;
		for (const segment of contract.clientPath.slice(0, -1)) {
			const current = parent[segment];
			if (current !== undefined && (typeof current !== 'object' || current === null))
				throw new Error(`Client command path collides at ${segment}`);
			if (current === undefined) parent[segment] = {};
			parent = parent[segment] as Record<string, unknown>;
		}
		const leaf = contract.clientPath.at(-1);
		if (leaf === undefined || leaf.length === 0 || parent[leaf] !== undefined)
			throw new Error(`Invalid or duplicate client command path for ${contract.name}`);
		const output = clientResponse(contract);
		parent[leaf] =
			contract.clientMode === 'query'
				? (input: Schema.Json, signal?: AbortSignal) =>
						commandQueryOf(runtime, contract.name, input, contract.input, output, signal)
				: (input: Schema.Json, signal?: AbortSignal) =>
						Effect.tryPromise({
							try: () =>
								runtime.bolt.command(
									contract.name,
									commandPayload(contract.input, input),
									output,
									signal
								),
							catch: toError
						});
	}
	return root as SystemClientApi;
};

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
			delete: (ids: readonly string[]) =>
				mutation.run(Effect.sync(() => enqueueDeletion(runtime, catalog, collection, ids))),
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
	ids: readonly string[]
): MemoryMutationResult => {
	if (ids.length === 0)
		throw new TypeError(`Mutation ${collection} delete requires at least one id`);
	for (const recordId of ids) {
		if (recordId.trim() === '')
			throw new TypeError(`Mutation ${collection} id must be a non-empty string`);
	}
	if (new Set(ids).size !== ids.length)
		throw new TypeError(`Mutation ${collection} delete ids must be unique`);
	return submitGraph(
		runtime,
		catalog,
		{ action: 'delete', collection, ids: ids as [string, ...string[]] },
		null
	);
};

/** --- automations --- */

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
		const rows = queryAt(state, mounted.key)?.prefix?.rows;
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
					(input) => commandEffectOf(runtime, 'automations.start', { name: property, input }),
					(taskId) => automationRunQuery(runtime, taskId),
					(taskId) =>
						commandEffectOf(runtime, 'automations.stop', { name: property, taskId }).pipe(
							Effect.asVoid
						)
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
									commandQueryOf(
										runtime,
										`invoke.${property}`,
										{ input },
										WorkspaceInvokeContract.input,
										WorkspaceInvokeContract.responses[0].value
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
					return pageQueryOf(runtime, collection, asJsonRecord(input));
				}
			},
			history: {
				findMany: (collection: string, recordId: string) => {
					assertCollectionAllowed(collection);
					return commandQueryFromContract(runtime, 'collections.history', {
						collection,
						id: recordId
					});
				}
			},
			approvals: {
				findMany: (approvalId: string) =>
					commandQueryFromContract(runtime, 'approvals.capabilities', {
						requestId: approvalId
					}),
				process: (input: {
					readonly approvalRequestId: string;
					readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED';
					readonly comments?: string;
				}) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const state = yield* commandEffectOf(runtime, 'approvals.status', {
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
							yield* commandEffectOf(runtime, 'approvals.decide', {
								state: decodedState.success,
								decision,
								...(input.comments === undefined ? {} : { reason: input.comments })
							});
						})
					),
				withdraw: (approvalRequestId: string) =>
					Effect.runPromise(
						Effect.gen(function* () {
							const state = yield* commandEffectOf(runtime, 'approvals.status', {
								requestId: approvalRequestId
							});
							const decodedState = Schema.decodeUnknownResult(ApprovalState)(state);
							if (Result.isFailure(decodedState)) return;
							yield* commandEffectOf(runtime, 'approvals.withdraw', {
								state: decodedState.success
							});
						})
					)
			}
		};
		if (visibility.system === false) return publicApi;
		return {
			...publicApi,
			system: createSystemClient(runtime)
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
