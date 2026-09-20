import { deviceClient } from './device.js';
import { Array as Array_, Effect, Result, Schema } from 'effect';
import {
	CollectionGroupedQueryRequest,
	CollectionMutationIdempotencyKey,
	CollectionMutationPush,
	CollectionQueryRequest,
	FixedCommandCatalogue,
	SyncQueryInput,
	WorkspaceInvokeContract,
	type CommandContract,
	type FixedCommandContract,
	type FixedCommandName,
	type CollectionMutationBaseVersion,
	type CollectionWriteGraph,
	type StoredRecord,
	type SyncQueryInput as SyncQueryInputType
} from '@norbital-ai/bolt-protocol';
import {
	isSystemCollectionField,
	type CollectionFilter,
	type CollectionFilterOptions,
	type CollectionHistoryAnchor,
	type CollectionRecordHistoryEntry,
	type CollectionWriteContract
} from '@norbital-ai/std/collection';
import { toError } from '@norbital-ai/std/error';
import { decodeNumber } from '@norbital-ai/std/json';
import type {
	MemoryMutationResult,
	RemoteQuery,
	WorkspaceClientRuntime
} from '#lib/client/contracts.js';
import {
	decodeUnknownSchema,
	isNonEmptyString,
	isNumber,
	isRecord,
	isString
} from '#lib/schema-decode.js';
import type { ClientState, QueryState } from './sync/machine.js';
import { project, type PendingProjectionWrite } from './live-query/project.js';
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
	/** A column with a DEFAULT: a create may leave it unset. */
	readonly defaulted?: boolean;
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
	readonly setNull?: true;
	readonly deferrable?: true;
}>;

export type CollectionCatalogEntry = Readonly<{
	readonly name: string;
	readonly recordLabel?: string;
	readonly fields: ReadonlyArray<CollectionCatalogField>;
	readonly relationships?: ReadonlyArray<CollectionCatalogRelation>;
	/** The declared write contract; absent, the collection is read-only in the browser. */
	readonly write?: CollectionWriteContract;
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

/**
 * Nests a CollectionTable filter path into the declarative predicate grammar.
 *
 * Every segment before the leaf is a relationship, and a relationship condition is quantified:
 * `employment_employee.effective_range contains_date` is "people with *some* employment whose range
 * contains the day". Without the quantifier the protocol reads the relation's field as an operator
 * and refuses the whole query, which is how an initial filter through a relation left a table on
 * its skeleton.
 */
export const filterToWhere = (filter: CollectionFilter): Schema.Json => {
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
		node = { [key]: { some: node } };
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
	if (!isRecord(input)) return {};
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

/** Live contiguous prefix, or one answered-only keyset page. See docs/pillars/04-sync-engine/README.md. */
type CollectionReadMode = { readonly kind: 'live' } | { readonly kind: 'anchored' };

/**
 * A cursor page is one-shot, and so is a nearest search: it is planned against the server's index
 * and read once, the way the engine admits it (`vector-nearest ordering is one-shot`), rather than
 * mounted as a live prefix the sync lane would refuse. A semantic search stays live; the lane
 * carries that arm.
 */
const collectionReadMode = (
	after: Schema.Json | undefined,
	search: Schema.Json | undefined
): CollectionReadMode => {
	const mode = isRecord(search) ? search['mode'] : undefined;
	return after === undefined && mode !== 'nearest' ? { kind: 'live' } : { kind: 'anchored' };
};

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

type JsonRecord = Readonly<Record<string, Schema.Json>>;

const relationOf = (
	catalog: CollectionCatalog | undefined,
	collection: string,
	name: string
): CollectionCatalogRelation | undefined =>
	catalog?.[collection]?.relationships?.find((relation) => relation.name === name);

/** The input without its relation keys: what an update paints, what a row's own columns are. */
const scalarsOf = (
	catalog: CollectionCatalog | undefined,
	collection: string,
	input: JsonRecord
): JsonRecord =>
	Object.fromEntries(
		Object.entries(input).filter(([key]) => relationOf(catalog, collection, key) === undefined)
	);

/**
 * Whether the input already is the row: every column the catalog requires is present, so the
 * server has nothing left to derive. A required column with a default is absent from the input
 * and keeps the create invisible, which is the conservative side.
 */
const carriesRequiredColumns = (entry: CollectionCatalogEntry, input: JsonRecord): boolean =>
	entry.fields.every(
		(field) =>
			field.nullable ||
			field.readOnly === true ||
			isSystemCollectionField(field.name) ||
			input[field.name] !== undefined
	);

/**
 * The pending writes a live read paints over the server's answer.
 *
 * An update paints its scalar input over the row it names; relation actions are the server's to
 * resolve and are dropped. A delete removes the ids it names. A create is painted only when the
 * collection declares one and the input carries every required column, so the row the browser
 * sent is the row the server will write. The server allocates the id, so the painted row borrows
 * the write's idempotency key until the frame that settles the write delivers the real row. A
 * create that leaves a required column to the collection's transform stays invisible until then:
 * painting the input as a row put an empty payroll run on the list, "0/0 paid", twenty seconds
 * before its payslips existed.
 */
export const pendingGraphs = (
	state: ClientState,
	catalog?: CollectionCatalog
): ReadonlyArray<PendingProjectionWrite> =>
	[...state.writes.values()].flatMap((write) => {
		const graph = write.request.graph;
		const entry = catalog?.[graph.collection];
		switch (graph.action) {
			case 'delete':
				return [{ graph }];
			case 'update':
				return [
					{
						graph: {
							...graph,
							inputs: Array_.map(graph.inputs, (input) =>
								scalarsOf(catalog, graph.collection, input)
							)
						}
					}
				];
			case 'create': {
				if (
					entry?.write?.create === undefined ||
					!graph.inputs.every((input) => carriesRequiredColumns(entry, input))
				)
					return [];
				return [
					{
						graph: {
							...graph,
							inputs: Array_.map(graph.inputs, (input, index) => ({
								...scalarsOf(catalog, graph.collection, input),
								id: `${write.request.idempotencyKey}:${index}`
							}))
						}
					}
				];
			}
			default: {
				const _exhaustive: never = graph.action;
				return _exhaustive;
			}
		}
	});

const rowVersionOf = (row: StoredRecord): number | undefined => {
	const value = row['row_version'];
	if (isNumber(value)) return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
	if (!isString(value) || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = decodeNumber(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const prefixRows = (query: QueryState): ReadonlyArray<StoredRecord> => query.prefix?.rows ?? [];

/**
 * Every row this browser currently renders, root and nested alike, with the collection it belongs
 * to. Live prefixes carry relation rows inline, so a matrix's children are found on their parent.
 */
const visitLoadedRows = (
	state: ClientState,
	catalog: CollectionCatalog,
	visit: (collection: string, row: StoredRecord) => void
): void => {
	const walk = (collection: string, rows: ReadonlyArray<StoredRecord>): void => {
		for (const row of rows) {
			visit(collection, row);
			for (const relation of catalog[collection]?.relationships ?? []) {
				const related = row[relation.name];
				const children = Array.isArray(related) ? related : [related];
				walk(relation.target, children.filter(isRecord).map(asJsonRecord));
			}
		}
	};
	for (const query of state.queries.values()) walk(query.input.collection, prefixRows(query));
};

/**
 * The newest whole-row version currently rendered by this browser for each mutation target.
 * Multiple live views may render the same row; choosing the greatest observed version avoids
 * manufacturing a conflict from a retained older page while the server still remains final.
 */
const authoritativeVersions = (
	state: ClientState,
	catalog: CollectionCatalog
): ReadonlyMap<string, number> => {
	const versions = new Map<string, number>();
	visitLoadedRows(state, catalog, (collection, row) => {
		const id = row['id'];
		const version = rowVersionOf(row);
		if (!isNonEmptyString(id) || version === undefined) return;
		const key = `${collection}\u0000${id}`;
		versions.set(key, Math.max(versions.get(key) ?? 0, version));
	});
	return versions;
};

/**
 * The children this tab has loaded under one parent's relation, or `undefined` when no rendered
 * row carries that relation — in which case no delete may be inferred from their absence.
 */
const loadedChildren = (
	state: ClientState,
	catalog: CollectionCatalog,
	collection: string,
	parentId: string,
	relation: string
): ReadonlyArray<StoredRecord> | undefined => {
	let loaded: ReadonlyArray<StoredRecord> | undefined;
	visitLoadedRows(state, catalog, (candidate, row) => {
		if (candidate !== collection || row['id'] !== parentId) return;
		const children = row[relation];
		if (Array.isArray(children)) loaded = children.filter(isRecord).map(asJsonRecord);
	});
	return loaded;
};

/**
 * Set semantics for a form matrix (RFC §4.2): a relation given as a plain array of rows means
 * "these are the parent's children". The wire never carries an omission, so the array is diffed
 * here against the children this tab has loaded and sent as explicit actions — a row without an
 * id is a `create`, a row with one is an `update`, and a loaded child the array no longer names is
 * a `delete`. Children this tab never loaded cannot be deleted by their absence. A value that is
 * already an actions object passes through, and only declared relation keys are touched.
 */
const withRelationActions = (
	state: ClientState,
	catalog: CollectionCatalog,
	collection: string,
	input: JsonRecord
): JsonRecord => {
	const parentId = input['id'];
	const result: Record<string, Schema.Json> = { ...input };
	for (const [key, value] of Object.entries(input)) {
		const relation = relationOf(catalog, collection, key);
		if (relation === undefined || !Array.isArray(value)) continue;
		const rows = value.filter(isRecord).map(asJsonRecord);
		const loaded = isNonEmptyString(parentId)
			? loadedChildren(state, catalog, collection, parentId, key)
			: undefined;
		const named = new Set(rows.map((row) => row['id']).filter(isNonEmptyString));
		const create = rows
			.filter((row) => !isNonEmptyString(row['id']))
			.map((row) => withRelationActions(state, catalog, relation.target, row));
		// `set` is scalar only; a child's own relation actions sit beside it (RFC §4.3).
		const update = rows.flatMap((row) => {
			const { id, ...rest } = withRelationActions(state, catalog, relation.target, row);
			if (!isNonEmptyString(id)) return [];
			const set = scalarsOf(catalog, relation.target, rest);
			const actions = Object.fromEntries(Object.entries(rest).filter(([name]) => !(name in set)));
			return [{ id, set, ...actions }];
		});
		const remove = (loaded ?? []).flatMap((row) => {
			const id = row['id'];
			return isNonEmptyString(id) && !named.has(id) ? [{ id }] : [];
		});
		result[key] = {
			...(create.length === 0 ? {} : { create }),
			...(update.length === 0 ? {} : { update }),
			...(remove.length === 0 ? {} : { delete: remove })
		};
	}
	return result;
};

/**
 * The observed row versions a declared input names (RFC §4.2), walked the way the engine's lowering
 * walks it: every record an entry names gets its row version from what this browser renders, and
 * relation actions recurse. Rows the browser has never rendered carry no version and are left to
 * the server's own guard.
 */
const declaredBaseVersions = (
	state: ClientState,
	catalog: CollectionCatalog,
	collection: string,
	inputs: ReadonlyArray<JsonRecord>
): ReadonlyArray<CollectionMutationBaseVersion> => {
	const authoritative = authoritativeVersions(state, catalog);
	const versions = new Map<string, CollectionMutationBaseVersion>();
	const visitRecord = (target: string, record: unknown): void => {
		if (!isRecord(record)) return;
		const recordId = record['id'];
		if (isNonEmptyString(recordId)) {
			const key = `${target}\u0000${recordId}`;
			const rowVersion = authoritative.get(key);
			if (rowVersion !== undefined && !versions.has(key))
				versions.set(key, { row: { collection: target, recordId }, rowVersion });
		}
		for (const [name, nested] of Object.entries(record)) {
			const relation = relationOf(catalog, target, name);
			if (relation === undefined || !isRecord(nested)) continue;
			for (const actionValue of Object.values(nested))
				for (const entry of Array.isArray(actionValue) ? actionValue : [actionValue])
					visitRecord(relation.target, entry);
		}
	};
	for (const input of inputs) visitRecord(collection, input);
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

/** Identity and version are protocol metadata, including on projected relationship rows. */
const withMutationVersions = (
	input: Readonly<Record<string, Schema.Json>>
): Readonly<Record<string, Schema.Json>> => {
	const result = { ...input };
	if (isRecord(input['columns'])) {
		const columns = { ...asJsonRecord(input['columns']) };
		if (Object.values(columns).some((value) => value === true)) {
			columns['id'] = true;
			columns['row_version'] = true;
		} else {
			delete columns['id'];
			delete columns['row_version'];
		}
		result['columns'] = columns;
	}
	if (isRecord(input['with'])) {
		result['with'] = Object.fromEntries(
			Object.entries(asJsonRecord(input['with'])).map(([name, relation]) => [
				name,
				isRecord(relation) ? withMutationVersions(asJsonRecord(relation)) : relation
			])
		);
	}
	return result;
};

const pageQueryOf = (
	runtime: WorkspaceClientRuntime,
	collection: string,
	catalog: CollectionCatalog | undefined,
	input: Schema.Json = {},
	options?: CollectionFilterOptions
): CollectionPageQuery<ReadonlyArray<Schema.Json>> => {
	const requestFields: Readonly<Record<string, Schema.Json>> = {
		collection,
		...withMutationVersions(mergeWhere(asJsonRecord(input), options))
	};
	const mode = collectionReadMode(requestFields['after'], requestFields['search']);
	switch (mode.kind) {
		case 'anchored': {
			const request = Schema.decodeUnknownSync(CollectionQueryRequest)(requestFields);
			let nextCursor: string | null | undefined;
			const query = createRemoteQuery(
				() =>
					commandEffectOf(runtime, 'collections.findMany', request).pipe(
						Effect.map((page) => {
							nextCursor = page.nextCursor;
							return project(page.rows, pendingGraphs(runtime.sync.current(), catalog), collection);
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
				return rows === undefined
					? undefined
					: project(rows, pendingGraphs(state, catalog), collection);
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
	catalog: CollectionCatalog | undefined,
	input: Schema.Json = {}
): RemoteQuery<Schema.Json | undefined> => {
	const requestFields: Readonly<Record<string, Schema.Json>> = {
		collection,
		...withMutationVersions(asJsonRecord(input))
	};
	const mode = collectionReadMode(requestFields['after'], requestFields['search']);
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
					return project(rows, pendingGraphs(state, catalog), collection)[0];
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
	catalog: CollectionCatalog | undefined,
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
	catalog: CollectionCatalog | undefined,
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
					groups[name] = project(rows, pendingGraphs(runtime.sync.current(), catalog), collection);
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
				const payload = yield* decodeUnknownSchema(Schema.Json, checked);
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

const clientResponse = <Contract extends CommandContract>(
	contract: Contract
): OkValue<Contract> => {
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
			decodeUnknownSchema(schema, input) as Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError>
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
			if (current !== undefined && !isRecord(current))
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

const ClientDatabase = {
	collection: (
		runtime: WorkspaceClientRuntime,
		collection: string,
		catalog: CollectionCatalog
	) => ({
		findMany: (input: Schema.Json = {}, options?: CollectionFilterOptions) =>
			pageQueryOf(runtime, collection, catalog, input, options),
		findFirst: (input: Schema.Json = {}) => firstQueryOf(runtime, collection, catalog, input),
		findGrouped: (input: Schema.Json, options?: CollectionFilterOptions) =>
			groupedQueryOf(runtime, collection, catalog, input, options),
		count: (input: Schema.Json = {}, options?: CollectionFilterOptions) =>
			countQueryOf(runtime, collection, catalog, input, options)
	}),
	database: (
		runtime: WorkspaceClientRuntime,
		allowedCollections?: ReadonlySet<string>,
		catalog: CollectionCatalog = {}
	): Readonly<Record<string, unknown>> => {
		const collections = new Map<string, unknown>();
		return new Proxy<Record<string, unknown>>(
			{},
			{
				get: (_target, property) => {
					if (!isString(property)) return undefined;
					if (allowedCollections !== undefined && !allowedCollections.has(property))
						return undefined;
					const existing = collections.get(property);
					if (existing !== undefined) return existing;
					const created = ClientDatabase.collection(runtime, property, catalog);
					collections.set(property, created);
					return created;
				}
			}
		);
	}
};

const requireId = (collection: string, input: JsonRecord): string => {
	const id = input['id'];
	if (!isNonEmptyString(id)) throw new TypeError(`Write to ${collection} names no record id`);
	return id;
};

/**
 * One browser write: the declared inputs under the idempotent push envelope, queued on the Machine
 * and settled asynchronously through the returned handle. Nothing is claimed saved before that
 * outcome; durability is this tab's memory. The optimistic row is the first input as sent.
 */
const submitGraph = (
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	collection: string,
	action: CollectionWriteGraph['action'],
	inputs: ReadonlyArray<JsonRecord>
): MemoryMutationResult => {
	const state = runtime.sync.current();
	const declared = inputs.map((input) => withRelationActions(state, catalog, collection, input));
	if (!Array_.isReadonlyArrayNonEmpty(declared))
		throw new TypeError(`Write to ${collection} requires at least one input`);
	if (action !== 'create') {
		const ids = declared.map((input) => requireId(collection, input));
		if (new Set(ids).size !== ids.length)
			throw new TypeError(`Write to ${collection} names one record more than once`);
	}
	const idempotencyKey = CollectionMutationIdempotencyKey.make(crypto.randomUUID());
	const settlement = runtime.settlements.create(idempotencyKey);
	const request = Schema.decodeUnknownSync(CollectionMutationPush)({
		protocolVersion: 2,
		idempotencyKey,
		issuedAtEpochMs: Date.now(),
		partitionKey: runtime.mutation.partitionKey,
		schemaFingerprint: runtime.mutation.schemaFingerprint,
		graph: { collection, action, inputs: declared },
		baseVersions: declaredBaseVersions(state, catalog, collection, declared)
	});
	runtime.sync.enqueue(request);
	return {
		durability: 'memory',
		pending: true,
		row: action === 'delete' ? null : declared[0],
		idempotencyKey,
		settlement
	};
};

/**
 * `client.collection.<name>` (RFC §4.2): the collection's declared write surface. Every call is
 * one graph — `createMany`, `updateMany` and `deleteMany` are a batch of the single-record input
 * and run one transform in one transaction on the server.
 */
const collectionWrites = (
	runtime: WorkspaceClientRuntime,
	catalog: CollectionCatalog,
	collection: string
) => {
	const mutation = new CollectionMutationState();
	const write = (action: CollectionWriteGraph['action'], inputs: ReadonlyArray<JsonRecord>) =>
		mutation.run(Effect.sync(() => submitGraph(runtime, catalog, collection, action, inputs)));
	const records = (inputs: unknown): ReadonlyArray<JsonRecord> => {
		if (!Array.isArray(inputs)) throw new TypeError(`Write to ${collection} takes an array`);
		return inputs.map(asJsonRecord);
	};
	return {
		create: (input: Schema.Json) => write('create', [asJsonRecord(input)]),
		createMany: (inputs: Schema.Json) => write('create', records(inputs)),
		update: (id: string, input: Schema.Json) => write('update', [{ ...asJsonRecord(input), id }]),
		updateMany: (inputs: Schema.Json) => write('update', records(inputs)),
		delete: (id: string) => write('delete', [{ id }]),
		deleteMany: (ids: readonly string[]) =>
			write(
				'delete',
				ids.map((id) => ({ id }))
			),
		get pending() {
			return mutation.pending;
		}
	};
};

const HistoryEntries = Schema.Array(
	Schema.Struct({
		values: Schema.Record(Schema.String, Schema.Json),
		validFrom: Schema.String,
		validTo: Schema.NullOr(Schema.String),
		version: Schema.Number
	})
);

/**
 * `client.collection_history.<name>` (RFC §4.7): the record's revisions, or the row as it stood at
 * an anchor. One-shot over the transport, never live; the same masked rows the live read returns.
 */
const collectionHistory = (runtime: WorkspaceClientRuntime, collection: string) => {
	const contract = fixedContract('collections.history');
	const read = (
		id: string,
		at?: CollectionHistoryAnchor
	): RemoteQuery<ReadonlyArray<CollectionRecordHistoryEntry>> =>
		commandQueryOf(
			runtime,
			'collections.history',
			{ collection, id, ...(at === undefined ? {} : { at }) },
			contract.input,
			HistoryEntries
		);
	return {
		revisions: (id: string) => read(id),
		at: (
			id: string,
			anchor: CollectionHistoryAnchor
		): RemoteQuery<CollectionRecordHistoryEntry['values'] | undefined> => {
			const query = read(id, anchor);
			return {
				get current() {
					return query.current?.[0]?.values;
				},
				get error() {
					return query.error;
				},
				get loading() {
					return query.loading;
				},
				then: (onfulfilled, onrejected) =>
					Promise.resolve(query)
						.then((entries) => entries[0]?.values)
						.then(onfulfilled, onrejected)
			};
		}
	};
};

/** --- automations --- */

const AutomationRunRow = Schema.Struct({
	task_id: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'running', 'done', 'failed', 'stopped']),
	error: Schema.NullOr(Schema.String),
	result: Schema.NullOr(Schema.Json),
	progress: Schema.NullOr(
		Schema.Struct({ progress: Schema.Number, text: Schema.NullOr(Schema.String) })
	),
	progress_sequence: Schema.Number,
	progress_updated_at: Schema.NullOr(Schema.String)
});
type AutomationRunRow = Schema.Schema.Type<typeof AutomationRunRow>;
const projectAutomationRun = (row: AutomationRunRow | null): AutomationTaskSnapshot | null =>
	row === null
		? null
		: {
				status: row.status,
				error: row.error,
				result: row.result,
				progress: row.progress,
				progressSequence: row.progress_sequence,
				progressUpdatedAt: row.progress_updated_at
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
				if (!isString(property)) return undefined;
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
		const writable = (collection: string): boolean =>
			collectionAllowed(collection) &&
			!readOnlyCollections.has(collection) &&
			catalog[collection]?.write !== undefined;
		const surfaces = new Map<string, unknown>();
		const memoized = (prefix: string, collection: string, create: () => unknown): unknown => {
			const key = `${prefix}\u0000${collection}`;
			const existing = surfaces.get(key);
			if (existing !== undefined) return existing;
			const created = create();
			surfaces.set(key, created);
			return created;
		};
		const publicApi = {
			db: ClientDatabase.database(runtime, allowedCollections, catalog),
			automations: automationClient(runtime),
			device: deviceClient,
			invoke: new Proxy<Record<string, InvokeMethod>>(
				{},
				{
					get: (_target, property) =>
						isString(property)
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
						if (!isString(property)) return undefined;
						if (!collectionAllowed(property)) return undefined;
						return catalog[property] ?? { name: property, fields: [], relationships: [] };
					}
				}
			),
			/**
			 * The declared write surface (RFC §4.2). A collection the catalog declares no write for, or
			 * one the shell publishes read-only, has no entry here.
			 */
			collection: new Proxy<Record<string, unknown>>(
				{},
				{
					get: (_target, property) =>
						isString(property) && writable(property)
							? memoized('collection', property, () => collectionWrites(runtime, catalog, property))
							: undefined
				}
			),
			collection_history: new Proxy<Record<string, unknown>>(
				{},
				{
					get: (_target, property) =>
						isString(property) && collectionAllowed(property)
							? memoized('history', property, () => collectionHistory(runtime, property))
							: undefined
				}
			),
			records: {
				findMany: (collection: string, input: Schema.Json = {}) => {
					assertCollectionAllowed(collection);
					return pageQueryOf(runtime, collection, catalog, asJsonRecord(input));
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
				}) => {
					const decision =
						input.action === 'SUPERSEDED'
							? 'supersede'
							: input.action === 'APPROVED'
								? 'approve'
								: input.action === 'REQUEST_FOR_CHANGE'
									? 'request_changes'
									: 'reject';
					return Effect.runPromise(
						commandEffectOf(runtime, 'approvals.decide', {
							state: { requestId: input.approvalRequestId },
							decision,
							...(input.comments === undefined ? {} : { reason: input.comments })
						}).pipe(Effect.asVoid)
					);
				},
				withdraw: (approvalRequestId: string) =>
					Effect.runPromise(
						commandEffectOf(runtime, 'approvals.withdraw', {
							state: { requestId: approvalRequestId }
						}).pipe(Effect.asVoid)
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
