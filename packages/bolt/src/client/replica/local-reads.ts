// repository-health:allow SEM_PARALLEL -- local-reads consumes the replica store over the #lib
// alias, so the pair is linked, not parallel.
import { Effect, Number as ENumber, Result, Schema } from 'effect';
import {
	compileOrderTerms,
	compileSearch,
	compileWhere,
	type WhereContext
} from '#lib/runtime/collections/where.js';
import type {
	LocalReplicaStore,
	ReplicaOverlayView
} from '#lib/client/replica/pglite-sql.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';
import { encodeCollectionCursor } from '#lib/runtime/collections/cursor.js';
import { searchableColumns } from '#lib/authoring/model-introspection.js';
import {
	describeClientQueryWindow,
	type QueryWindowCatalog
} from '#lib/client/replica/query-window.js';
import {
	hasCanonicalRelationshipSelection,
	projectCollectionQueryRows,
	type CollectionQueryIdentity
} from '#lib/runtime/collections/canonical-query.js';
import {
	MAX_REPLICA_WINDOW_ROWS,
	type QueryWindowProof,
	type WindowLedger
} from '#lib/client/replica/coverage.js';
import {
	deriveBaseThroughOverlay,
	overlayReferences,
	type OverlayMutation
} from '#lib/client/replica/overlay.js';

const ReferenceTarget = Schema.Struct({
	tag: Schema.String,
	collection: Schema.String,
	storageColumn: Schema.String
});
const ReferenceDefinition = Schema.Struct({
	targets: Schema.Array(ReferenceTarget),
	onDelete: Schema.Literals(['restrict', 'cascade', 'set null'])
});
const ReplicaField = Schema.Struct({
	type: Schema.Literals(['string', 'uuid', 'number', 'boolean', 'instant', 'json', 'reference']),
	required: Schema.Boolean,
	indexed: Schema.Boolean,
	primaryKey: Schema.optionalKey(Schema.Boolean),
	unique: Schema.optionalKey(Schema.Boolean),
	generated: Schema.optionalKey(Schema.String),
	sqlType: Schema.optionalKey(Schema.String),
	sqlDefault: Schema.optionalKey(Schema.String),
	values: Schema.optionalKey(Schema.Array(Schema.String)),
	customType: Schema.optionalKey(Schema.String),
	precision: Schema.optionalKey(Schema.Literals(['day', 'minute'])),
	search: Schema.optionalKey(Schema.Boolean),
	mimeTypes: Schema.optionalKey(Schema.Array(Schema.String)),
	file: Schema.optionalKey(Schema.Boolean),
	fileMultiple: Schema.optionalKey(Schema.Boolean),
	reference: Schema.optionalKey(ReferenceDefinition)
});
const ReadableFields = Schema.NullOr(Schema.Array(Schema.String));
const RelationEndpoint = Schema.Struct({ collection: Schema.String, column: Schema.String });
const ReplicaRelation = Schema.Struct({
	name: Schema.String,
	source: Schema.String,
	target: Schema.String,
	cardinality: Schema.Literals(['one', 'many']),
	from: Schema.optionalKey(RelationEndpoint),
	to: Schema.optionalKey(RelationEndpoint),
	cascade: Schema.optionalKey(Schema.Boolean)
});

export const ReplicaShape = Schema.Struct({
	collections: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			fields: Schema.Record(Schema.String, ReplicaField),
			/** Null means unrestricted; absence means local rows cannot be disclosed safely. */
			readableFields: Schema.optionalKey(ReadableFields)
		})
	),
	relations: Schema.Array(ReplicaRelation)
});
export interface ReplicaShape extends Schema.Schema.Type<typeof ReplicaShape> {}

export type LocalWindowRead = Readonly<{
	readonly value: Schema.Json;
	readonly status: 'fresh' | 'stale';
	readonly queryKey: string;
	readonly proofOwner: 'local' | 'server';
	readonly dependencies: ReadonlyArray<string>;
	/** The exact canonical window contains a relationship expansion, not merely a collection dependency. */
	readonly relationDependency: boolean;
}>;

export type LocalReader = Readonly<{
	/** Undefined means the query has no safely renderable retained window. */
	readonly answer: (
		command: string,
		input: Schema.Json
	) => Effect.Effect<LocalWindowRead | undefined, unknown>;
}>;

export type LocalWindowRecomputer = Readonly<{
	/** Recomputes one dirty LocalExact membership at the latest stable O6 position. */
	readonly recompute: (queryKey: string) => Effect.Effect<boolean, unknown>;
	/** Deduplicates a batch so every affected canonical query reruns at most once. */
	readonly recomputeMany: (
		queryKeys: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<string>, unknown>;
}>;

/** Runtime-maintained snapshot; reads never reopen and reparse each durable journal. */
export type LocalOverlayProvider = Readonly<{
	readonly snapshot: () => Promise<ReadonlyArray<OverlayMutation>>;
}>;

export type LocalReplicaReadOptions = Readonly<{
	readonly pinnedCollation?: boolean;
	/** Durable journal projection; omission means this runtime has no active O4 source. */
	readonly overlay?: LocalOverlayProvider;
	/** Credential-free actor/authority owner; never inferred from the physical read partition. */
	readonly localActorBinding?: string;
}>;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = Schema.decodeUnknownResult(JsonObject);
const LocalReadInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	where: Schema.optionalKey(Schema.Json),
	userFilter: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number),
	after: Schema.optionalKey(Schema.String),
	columns: Schema.optionalKey(Schema.Json),
	with: Schema.optionalKey(Schema.Json),
	search: Schema.optionalKey(Schema.String)
});
const decodeLocalReadInput = Schema.decodeUnknownResult(LocalReadInput);
const LocalGroupedReadInput = Schema.Struct({
	...LocalReadInput.fields,
	group: Schema.Struct({
		by: Schema.NonEmptyString,
		lanes: Schema.optionalKey(Schema.Array(Schema.Json))
	})
});
const decodeLocalGroupedReadInput = Schema.decodeUnknownResult(LocalGroupedReadInput);

const queryCatalog = (shape: ReplicaShape): QueryWindowCatalog =>
	Object.fromEntries(
		shape.collections.map((collection) => [
			collection.name,
			{
				fields: Object.entries(collection.fields).map(([name, field]) => ({
					name,
					kind: field.type,
					...(field.reference === undefined
						? {}
						: {
								relation: {
									targets: field.reference.targets.map(({ collection }) => collection)
								}
							})
				})),
				relationships: shape.relations
					.filter(({ source }) => source === collection.name)
					.map(({ name, target }) => ({ name, target }))
			}
		])
	);

const shapeContext = (shape: ReplicaShape, collection: string): WhereContext | undefined => {
	const fieldsByCollection = Object.fromEntries(
		shape.collections.map((entry) => [entry.name, entry.fields])
	);
	const fields = fieldsByCollection[collection];
	return fields === undefined
		? undefined
		: {
				collection,
				fields,
				relations: shape.relations,
				collections: shape.collections.map(({ name }) => name),
				fieldsByCollection
			};
};

const canonicalPredicate = (
	canonical: Readonly<Record<string, Schema.Json>>
): Schema.Json | undefined => {
	const predicates = [canonical['authoredWhere'], canonical['userFilter']].filter(
		(value): value is Schema.Json => value !== undefined && value !== null
	);
	return predicates.length === 0
		? undefined
		: predicates.length === 1
			? predicates[0]
			: { AND: predicates };
};

const canonicalOrderBy = (
	canonical: Readonly<Record<string, Schema.Json>>
): Readonly<Record<string, 'asc' | 'desc'>> | undefined => {
	const order = canonical['orderBy'];
	if (!Array.isArray(order)) return undefined;
	const entries = order.flatMap((value) => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
		const record = value as Readonly<Record<string, unknown>>;
		const field = record['field'];
		const direction = record['direction'];
		return typeof field === 'string' && (direction === 'asc' || direction === 'desc')
			? [[field, direction] as const]
			: [];
	});
	return entries.length === order.length ? Object.fromEntries(entries) : undefined;
};

const overlayView = (
	store: LocalReplicaStore,
	collection: string,
	partitionKey: string,
	localActorBinding: string | undefined,
	provider: LocalOverlayProvider | undefined,
	snapshot?: ReadonlyArray<OverlayMutation>
): Effect.Effect<ReplicaOverlayView | undefined, unknown> => {
	if (provider === undefined || localActorBinding === undefined) return Effect.succeed(undefined);
	return Effect.gen(function* () {
		const mutations = snapshot ?? (yield* Effect.tryPromise({
			try: provider.snapshot,
			catch: (cause) => cause
		}));
		const scoped = mutations.filter(
			(mutation) =>
				mutation.active &&
				mutation.localActorBinding === localActorBinding &&
				mutation.operations.some((operation) => operation.row.collection === collection)
		);
		const affectedRecordIds = [
			...new Set(
				scoped.flatMap(({ operations }) =>
					operations.flatMap(({ row }) => row.collection === collection ? [row.recordId] : [])
				)
			)
		];
		// The overwhelmingly common empty-overlay read remains the ordinary indexed O3 query.
		if (affectedRecordIds.length === 0) return undefined;
		const baseRows = yield* store.baseRows(collection, affectedRecordIds);
		const projected = deriveBaseThroughOverlay(
			{
				serverPartitionKey: partitionKey,
				localActorBinding,
				collection
			},
			baseRows.map((base) => ({ ...base, partitionKey, collection })),
			scoped
		);
		return { affectedRecordIds, rows: [...projected.rows.values()] };
	});
};

/**
 * The one M1 evaluator for dirty LocalExact windows.
 *
 * It reuses the shared where/order compilers (including pinned C collation), bounds the query to the
 * retained window size, and commits membership only if O6 stayed unchanged during evaluation.
 * ServerProof windows never enter this path.
 */
export const createLocalWindowRecomputer = (
	store: LocalReplicaStore,
	shape: ReplicaShape,
	windows: WindowLedger,
	partitionKey: string,
	options: Readonly<{
		readonly overlay?: LocalOverlayProvider;
		readonly localActorBinding?: string;
	}> = {}
): LocalWindowRecomputer => {
	const relationshipOverlayStable = (
		proof: QueryWindowProof,
		mutations: ReadonlyArray<OverlayMutation> | undefined
	): boolean => {
		const relationships = proof.canonical['relationships'];
		if (relationships === null) return true;
		if (typeof relationships !== 'object' || Array.isArray(relationships)) {
			return false;
		}
		const localActorBinding = options.localActorBinding;
		if (mutations === undefined || localActorBinding === undefined) {
			// A confirmed LocalExact page carries complete normalized edges. Ordinary M1 root-row
			// activity can therefore recompute membership without rebuilding those expansions.
			return true;
		}
		const requestedRelationships = new Set(Object.keys(relationships));
		const dependencies = new Set(proof.dependencies);
		return mutations
			.filter(
				(mutation) =>
					mutation.active &&
					mutation.localActorBinding === localActorBinding
			)
			.every((mutation) => {
				const relevant = mutation.operations.filter(({ row }) =>
					dependencies.has(row.collection)
				);
				if (relevant.length === 0) return true;
				// Target-row activity, or a multi-row self-relation graph, can change which normalized
				// edges exist. Keep the proof stale until the server supplies a replacement sidecar.
				if (
					relevant.some(({ row }) => row.collection !== proof.collection) ||
					relevant.length > 1
				) return false;
				const operation = relevant[0];
				if (operation === undefined || operation.kind === 'remove') return true;
				// A root reference change also changes its edge even though it is one row operation.
				return [...requestedRelationships].every(
					(name) => !Object.hasOwn(operation.values, name)
				);
			});
	};
	const evaluate = (queryKey: string): Effect.Effect<boolean, unknown> =>
		Effect.gen(function* () {
			const proof = yield* windows.readWindow(queryKey, (value) => Effect.succeed(value));
			if (
				proof === undefined ||
				proof.proofOwner !== 'local' ||
				!proof.locallyReproducible ||
				!proof.dirty ||
				proof.canonical['kind'] !== 'findMany'
			) return false;
			const overlayProvider = options.overlay;
			const localActorBinding = options.localActorBinding;
			const overlaySnapshot =
				overlayProvider === undefined || localActorBinding === undefined
					? undefined
					: yield* Effect.tryPromise({
							try: overlayProvider.snapshot,
							catch: (cause) => cause
						});
			if (!relationshipOverlayStable(proof, overlaySnapshot)) return false;
			const context = shapeContext(shape, proof.collection);
			const orderBy = canonicalOrderBy(proof.canonical);
			if (context === undefined || orderBy === undefined) return false;
			const canonicalSearch = proof.canonical['search'];
			if (canonicalSearch !== null && typeof canonicalSearch !== 'string') return false;
			const searchableFields = searchableColumns(context.fields);
			const readable = shape.collections.find(({ name }) => name === proof.collection)?.readableFields;
			if (
				canonicalSearch !== null &&
				searchableFields.length > 0 &&
				(readable === undefined ||
					(readable !== null && searchableFields.some((field) => !readable.includes(field))))
			) return false;
			const compiled = compileWhere(canonicalPredicate(proof.canonical), context);
			if (Result.isFailure(compiled)) return false;
			const searched = compileSearch(context.fields, canonicalSearch, proof.collection);
			const terms = compileOrderTerms(orderBy, context);
			const priorVisibleCapacity = Math.max(
				0,
				proof.orderedRowIds.length - proof.lookaheadCount
			);
			const visibleCapacity =
				proof.nextCursor === null
					? Math.min(MAX_REPLICA_WINDOW_ROWS - 1, Math.max(100, priorVisibleCapacity))
					: priorVisibleCapacity;
			const evaluationLimit =
				proof.nextCursor === null
					? Math.min(MAX_REPLICA_WINDOW_ROWS, visibleCapacity + 1)
					: proof.orderedRowIds.length;
			const evaluated = yield* windows.transaction(Effect.gen(function* () {
				const position = yield* windows.position();
				const overlay = yield* overlayView(
					store,
					proof.collection,
					partitionKey,
					localActorBinding,
					overlayProvider,
					overlaySnapshot
				);
				const rows = yield* store.findMany({
					collection: proof.collection,
					filter: compiled.success,
					search: searched,
					orderBy: terms,
					limit: evaluationLimit,
					...(overlay === undefined ? {} : { overlay })
				});
				return {
					position,
					rows,
					optimisticRowIds: overlay?.rows.flatMap((row) =>
						typeof row['id'] === 'string' ? [row['id']] : []
					) ?? []
				};
			}));
			const { position, rows, optimisticRowIds } = evaluated;
			const logicalRows: Array<Readonly<Record<string, Schema.Json>>> = [];
			for (const value of rows) {
				const stored = decodeJsonObject(value);
				if (Result.isFailure(stored)) return false;
				logicalRows.push(decodeReferenceRow(stored.success, context.fields));
			}
			const ids = logicalRows.flatMap((row) => typeof row['id'] === 'string' ? [row['id']] : []);
			if (ids.length !== logicalRows.length || new Set(ids).size !== ids.length) return false;
			const lookaheadCount = Math.max(0, logicalRows.length - visibleCapacity);
			const boundaryCovered = proof.nextCursor === null ? true : lookaheadCount > 0;
			const last = logicalRows[logicalRows.length - 1];
			const nextCursor = proof.nextCursor === null
				? lookaheadCount === 0 || last === undefined
					? null
					: encodeCollectionCursor(terms, last)
				: last === undefined
					? null
					: encodeCollectionCursor(terms, last);
			const dependencyGenerations = Object.fromEntries(
				proof.dependencies.map((dependency) => [
					dependency,
					position.generations[dependency] ?? 0
				])
			);
			return yield* windows.recomputeWindow({
				queryKey,
				orderedRowIds: ids,
				optimisticRowIds,
				readCursor: position.cursor,
				dependencyGenerations,
				lookaheadCount,
				nextCursor,
				boundaryCovered
			});
		});
	const protectedOverlayRows = (): Effect.Effect<
		ReadonlyArray<Readonly<{ collection: string; recordId: string }>>,
		unknown
	> => options.overlay === undefined || options.localActorBinding === undefined
		? Effect.succeed([])
		: Effect.tryPromise({ try: options.overlay.snapshot, catch: (cause) => cause }).pipe(
			Effect.map((mutations) => overlayReferences(
				mutations
					.filter(({ localActorBinding }) => localActorBinding === options.localActorBinding)
					.flatMap(({ operations }) => operations)
			))
		);
	const pruneAfter = (complete: boolean): Effect.Effect<void, unknown> =>
		complete
			? protectedOverlayRows().pipe(
				Effect.flatMap((protectedRows) => windows.pruneBaseRows(protectedRows)),
				Effect.asVoid
			)
			: Effect.void;
	return {
		recompute: (queryKey) => Effect.gen(function* () {
			const recomputed = yield* evaluate(queryKey);
			yield* pruneAfter(recomputed);
			return recomputed;
		}),
		recomputeMany: (queryKeys) => Effect.gen(function* () {
			const recomputed: Array<string> = [];
			let complete = true;
			for (const queryKey of new Set(queryKeys)) {
				if (yield* evaluate(queryKey)) recomputed.push(queryKey);
				else complete = false;
			}
			yield* pruneAfter(complete);
			return recomputed;
		})
	};
};

const projectRow = (
	row: Readonly<Record<string, Schema.Json>>,
	readable: ReadonlySet<string> | null
): Readonly<Record<string, Schema.Json>> =>
	Object.fromEntries(
		Object.entries(row).filter(([field]) => readable === null || readable.has(field))
	);

const objectValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

const nestedWithSpec = (value: unknown): Schema.Json | undefined => {
	const nested = objectValue(value)?.['with'];
	return Schema.is(Schema.Json)(nested) ? nested : undefined;
};

const projectReadableRow = (
	row: Readonly<Record<string, Schema.Json>>,
	readable: ReadonlySet<string> | null,
	relationships: unknown
): Readonly<Record<string, Schema.Json>> => {
	const projected: Record<string, Schema.Json> = { ...projectRow(row, readable) };
	const requested = objectValue(relationships);
	if (requested === undefined) return projected;
	for (const [relation, spec] of Object.entries(requested)) {
		if (spec === false || spec === undefined || !Object.hasOwn(row, relation)) continue;
		projected[relation] = row[relation]!;
	}
	return projected;
};

/**
 * Reads only through a window's ordered membership. It never queries every retained base row and
 * guesses that the bounded working set is complete. Projection is the final read-time operation.
 */
export const createLocalReader = (
	store: LocalReplicaStore,
	shape: ReplicaShape,
	readableCollections: ReadonlySet<string>,
	windows: WindowLedger,
	identity: CollectionQueryIdentity,
	options: LocalReplicaReadOptions = {}
): LocalReader => {
	const fieldsByCollection = Object.fromEntries(
		shape.collections.map((entry) => [entry.name, entry.fields])
	);
	const collections = shape.collections.map(({ name }) => name);
	const catalog = queryCatalog(shape);
	const readableFieldsByCollection = new Map(
		shape.collections.map((collection) => [
			collection.name,
			collection.readableFields === null
				? null
				: collection.readableFields === undefined
					? undefined
					: new Set(collection.readableFields)
		])
	);
	const contextFor = (collection: string): WhereContext | undefined => {
		const fields = fieldsByCollection[collection];
		return fields === undefined
			? undefined
			: {
					collection,
					fields,
					relations: shape.relations,
					collections,
					fieldsByCollection
				};
	};
	const retainedRows = (
		collection: string,
		recordIds: ReadonlyArray<string>,
		applyOverlay: boolean
	): Effect.Effect<ReadonlyArray<Readonly<Record<string, Schema.Json>>> | undefined, unknown> =>
		Effect.gen(function* () {
			if (!readableCollections.has(collection)) return undefined;
			const context = contextFor(collection);
			const readable = readableFieldsByCollection.get(collection);
			if (context === undefined || readable === undefined) return undefined;
			if (recordIds.length === 0) return [];
			const overlay = applyOverlay
				? yield* overlayView(
						store,
						collection,
						identity.partitionKey,
						options.localActorBinding,
						options.overlay
					)
				: undefined;
			const stored = yield* store.findMany({
				collection,
				filter: { sql: 'true', parameters: [] },
				orderBy: [],
				recordIds,
				limit: recordIds.length,
				...(overlay === undefined ? {} : { overlay })
			});
			const byId = new Map<string, Readonly<Record<string, Schema.Json>>>();
			for (const candidate of stored) {
				const decoded = decodeJsonObject(candidate);
				if (Result.isFailure(decoded)) return undefined;
				const row = decodeReferenceRow(decoded.success, context.fields);
				const id = row['id'];
				if (typeof id === 'string') byId.set(id, row);
			}
			const ordered = recordIds.flatMap((id) => {
				const row = byId.get(id);
				return row === undefined ? [] : [row];
			});
			return ordered.length === recordIds.length ? ordered : undefined;
		});
	const attachRetainedRelationships = (
		collection: string,
		rows: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
		spec: Schema.Json | undefined,
		proof: QueryWindowProof,
		applyOverlay: boolean
	): Effect.Effect<ReadonlyArray<Readonly<Record<string, Schema.Json>>> | undefined, unknown> =>
		Effect.gen(function* () {
			const requested = objectValue(spec);
			if (requested === undefined || rows.length === 0) return rows;
			const attached = rows.map((row) => ({ ...row }));
			for (const [relationName, relationSpec] of Object.entries(requested)) {
				if (relationSpec === false || relationSpec === undefined) continue;
				const sourceIds = new Set(
					attached.flatMap((row) => typeof row['id'] === 'string' ? [row['id']] : [])
				);
				const edges = proof.relationshipRefs.filter(
					(edge) =>
						edge.sourceCollection === collection &&
						edge.relation === relationName &&
						sourceIds.has(edge.sourceRecordId)
				);
				const reference = fieldsByCollection[collection]?.[relationName]?.reference;
				const relation = shape.relations.find(
					(candidate) => candidate.source === collection && candidate.name === relationName
				);
				if (reference === undefined && relation === undefined) return undefined;
				const resolved = new Map<string, Readonly<Record<string, Schema.Json>>>();
				for (const targetCollection of new Set(edges.map(({ targetCollection }) => targetCollection))) {
					const targetIds = [
						...new Set(
							edges
								.filter((edge) => edge.targetCollection === targetCollection)
								.map(({ targetRecordId }) => targetRecordId)
						)
					];
					const targetRows = yield* retainedRows(targetCollection, targetIds, applyOverlay);
					if (targetRows === undefined) return undefined;
					const target = reference?.targets.find(
						(candidate) => candidate.collection === targetCollection
					);
					const targetSpec =
						reference === undefined
							? relationSpec
							: target === undefined
								? undefined
								: (objectValue(relationSpec)?.[target.tag] ?? relationSpec);
					const targetRelationships = nestedWithSpec(targetSpec);
					const nested = yield* attachRetainedRelationships(
						targetCollection,
						targetRows,
						targetRelationships,
						proof,
						applyOverlay
					);
					if (nested === undefined) return undefined;
					const readable = readableFieldsByCollection.get(targetCollection);
					if (readable === undefined) return undefined;
					for (const row of nested) {
						const id = row['id'];
						if (typeof id === 'string') {
							resolved.set(
								`${targetCollection}\u0000${id}`,
								projectReadableRow(row, readable, targetRelationships)
							);
						}
					}
				}
				for (const row of attached) {
					const sourceId = row['id'];
					if (typeof sourceId !== 'string') return undefined;
					const memberships = edges.filter(({ sourceRecordId }) => sourceRecordId === sourceId);
					if (reference !== undefined) {
						const handle = objectValue(row[relationName]);
						const kind = handle?.['kind'];
						const id = handle?.['id'];
						if (typeof kind !== 'string' || typeof id !== 'string') continue;
						const target = reference.targets.find((candidate) => candidate.tag === kind);
						const membership = memberships.find(
							(edge) => edge.targetCollection === target?.collection && edge.targetRecordId === id
						);
						row[relationName] = {
							kind,
							id,
							record:
								membership === undefined
									? null
									: (resolved.get(`${membership.targetCollection}\u0000${id}`) ?? null)
						};
						continue;
					}
					const related = memberships.flatMap((membership) => {
						const target = resolved.get(
							`${membership.targetCollection}\u0000${membership.targetRecordId}`
						);
						return target === undefined ? [] : [target];
					});
					if (related.length !== memberships.length) return undefined;
					row[relationName] = relation?.cardinality === 'many' ? related : (related[0] ?? null);
				}
			}
			return attached;
		});

	return {
		answer: (command, input) => Effect.gen(function* () {
			const kind =
				command === 'collections.findMany'
					? 'findMany'
					: command === 'collections.count'
						? 'count'
						: command === 'collections.findGrouped'
							? 'findGrouped'
							: undefined;
			if (kind === undefined) return undefined;
			const record = decodeJsonObject(input);
			if (Result.isFailure(record)) return undefined;
			const decoded =
				kind === 'findGrouped'
					? decodeLocalGroupedReadInput(record.success)
					: decodeLocalReadInput(record.success);
			if (Result.isFailure(decoded)) return undefined;
			const {
				after,
				collection,
				columns,
				limit,
				orderBy,
				with: relationshipSelection
			} = decoded.success;
			if (!readableCollections.has(collection)) return undefined;
			const readableFields = readableFieldsByCollection.get(collection);
			if (readableFields === undefined) return undefined;
			if (kind !== 'count' && readableFields !== null && !readableFields.has('id')) return undefined;
			const context = contextFor(collection);
			if (context === undefined) return undefined;
			const terms = compileOrderTerms(orderBy, context);
			if (
				kind === 'findMany' &&
				readableFields !== null &&
				terms.some(({ column }) => !readableFields.has(column))
			) return undefined;
			const description = yield* describeClientQueryWindow(
				kind, record.success, catalog, identity, {
					localRelationships: true,
					localSearch:
						readableFields === null ||
						searchableColumns(context.fields).every((field) => readableFields.has(field)),
					...(options.pinnedCollation === undefined
						? {}
						: { pinnedCollation: options.pinnedCollation })
				}
			).pipe(Effect.catch(() => Effect.succeed(undefined)));
			if (description === undefined) return undefined;
			const pageLimit = ENumber.clamp({ minimum: 1, maximum: 500 })(limit ?? 100);
			return yield* windows.readWindow(description.queryKey, (proof) => Effect.gen(function* () {
				if (proof.collection !== collection) return undefined;
				if (kind === 'count') {
					if (proof.serverResult?.kind !== 'count' || proof.proofOwner !== 'server') return undefined;
					return {
						value: {
							count: proof.serverResult.value,
							readCursor: proof.readCursor,
							partitionKey: identity.partitionKey,
							confirmedDependencies: proof.dependencies,
							dependencyGenerations: proof.dependencyGenerations,
							reproducibility: description.reproducibility
						},
						status: proof.valid && !proof.dirty ? 'fresh' as const : 'stale' as const,
						queryKey: proof.queryKey,
						proofOwner: proof.proofOwner,
						dependencies: proof.dependencies,
						relationDependency: hasCanonicalRelationshipSelection(
							description.query.relationships
						)
					};
				}
				// ServerProof membership and rows are an authoritative cached result. Overlaying a pending
				// delete would make that retained result look incomplete, while overlaying a create could not
				// prove where it belongs. Only LocalExact windows evaluate O3 through O4.
				const applyOverlay = proof.proofOwner === 'local' && proof.locallyReproducible;
				const ordered = yield* retainedRows(collection, proof.orderedRowIds, applyOverlay);
				if (ordered === undefined) return undefined;
				const hydrated = yield* attachRetainedRelationships(
					collection,
					ordered,
					relationshipSelection,
					proof,
					applyOverlay
				);
				if (hydrated === undefined) return undefined;
				if (kind === 'findGrouped') {
					if (proof.serverResult?.kind !== 'findGrouped' || proof.proofOwner !== 'server') {
						return undefined;
					}
					const byId = new Map(
						hydrated.flatMap((row) => typeof row['id'] === 'string' ? [[row['id'], row] as const] : [])
					);
					const groups: Record<string, ReadonlyArray<Readonly<Record<string, Schema.Json>>>> = {};
					for (const [lane, ids] of Object.entries(proof.serverResult.groups)) {
						const rows = ids.flatMap((id) => {
							const row = byId.get(id);
							return row === undefined ? [] : [row];
						});
						if (rows.length !== ids.length) return undefined;
						groups[lane] = projectCollectionQueryRows(
							rows.map((row) =>
								projectReadableRow(row, readableFields, relationshipSelection)
							),
							columns,
							relationshipSelection
						);
					}
					return {
						value: { groups },
						status: proof.valid && !proof.dirty ? 'fresh' as const : 'stale' as const,
						queryKey: proof.queryKey,
						proofOwner: proof.proofOwner,
						dependencies: proof.dependencies,
						relationDependency: hasCanonicalRelationshipSelection(
							description.query.relationships
						)
					};
				}
				let start = 0;
				if (after !== undefined) {
					const anchor = hydrated.findIndex((row) => encodeCollectionCursor(terms, row) === after);
					if (anchor < 0) return undefined;
					start = anchor + 1;
				}
				const visible = hydrated.slice(start, start + pageLimit);
				const last = visible[visible.length - 1];
				const retainedAfterVisible = hydrated.length - (start + visible.length);
				const hasMore = retainedAfterVisible > 0 || proof.nextCursor !== null;
				// A non-terminal proof needs a full requested page plus one retained boundary row. Once
				// that lookahead is consumed, an anchor alone cannot prove a short continuation.
				const requestedBoundaryCovered =
					proof.nextCursor === null ||
					(visible.length === pageLimit && retainedAfterVisible > 0);
				const nextCursor = hasMore && last !== undefined
					? encodeCollectionCursor(terms, last)
					: null;
				return {
					value: {
						rows: projectCollectionQueryRows(
							visible.map((row) =>
								projectReadableRow(row, readableFields, relationshipSelection)
							),
							columns,
							relationshipSelection
						),
						nextCursor
					},
					status: proof.valid && !proof.dirty && requestedBoundaryCovered
						? 'fresh' as const
						: 'stale' as const,
					queryKey: proof.queryKey,
					proofOwner: proof.proofOwner,
					dependencies: proof.dependencies,
					relationDependency: hasCanonicalRelationshipSelection(
						description.query.relationships
					)
				};
			}));
		})
	};
};
