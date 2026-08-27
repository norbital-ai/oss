import { Effect, Result, Schema } from 'effect';
import type {
	CollectionHydrationRow,
	CollectionQueryReproducibility,
	CollectionRelationshipMembership,
	StoredRecord
} from '@norbital-ai/bolt-protocol';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';

/** One protocol-independent query kind. Grouped reads use findMany on the wire but keep this kind. */
export type CollectionQueryKind = 'findMany' | 'count' | 'findGrouped';

export type CanonicalOrderTerm = Readonly<{
	readonly field: string;
	readonly direction: 'asc' | 'desc';
}>;

export type CanonicalCollectionGroup = Readonly<{
	readonly by: string;
	readonly lanes: ReadonlyArray<Schema.Json>;
}>;

/**
 * The identity-bearing portion of one collection query.
 *
 * Page size, continuation and projection are absent by construction. A continuation therefore
 * extends the same ordered window, and two callers asking for different visible columns reuse the
 * same full-row materialization.
 */
export type CanonicalCollectionQuery = Readonly<{
	readonly version: 1;
	readonly kind: CollectionQueryKind;
	readonly collection: string;
	readonly authoredWhere: Schema.Json | null;
	readonly userFilter: Schema.Json | null;
	readonly search: string | null;
	readonly relationships: Schema.Json | null;
	readonly orderBy: ReadonlyArray<CanonicalOrderTerm>;
	readonly group: CanonicalCollectionGroup | null;
}>;

export type CollectionQueryMetadata = Readonly<{
	readonly hasField: (collection: string, field: string) => boolean;
	readonly fieldKind: (collection: string, field: string) => string | undefined;
	/** A logical reference may have several target collections, hence the array. */
	readonly relationTargets: (collection: string, relation: string) => ReadonlyArray<string>;
	/** Server metadata can resolve a polymorphic authored tag to its exact target collection. */
	readonly relationVariantTarget?: (
		collection: string,
		relation: string,
		variant: string
	) => string | undefined;
}>;

export type CanonicalCollectionQueryResult = Readonly<{
	readonly query: CanonicalCollectionQuery;
	/** Client-derived dependencies; the server must confirm (and may conservatively add to) these. */
	readonly dependencies: ReadonlyArray<string>;
	readonly reproducibility: CollectionQueryReproducibility;
}>;

/** True only for a canonical query which actually selects at least one relationship expansion. */
export const hasCanonicalRelationshipSelection = (value: unknown): boolean =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Object.keys(value).length > 0;

export type CollectionQueryIdentity = Readonly<{
	readonly protocolVersion: number;
	readonly schemaFingerprint: string;
	readonly partitionKey: string;
}>;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

/** Canonical JSON without locale-sensitive comparison or object insertion-order dependence. */
export const canonicalQueryJson = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalQueryJson).join(',')}]`;
	return `{${Object.entries(value)
		.filter(([, entry]) => entry !== undefined)
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalQueryJson(entry)}`)
		.join(',')}}`;
};

const jsonValue = (value: unknown): Schema.Json | null =>
	value === undefined || !Schema.is(Schema.Json)(value) ? null : value;

/**
 * Removes projection recursively before an authoritative hydration read.
 *
 * The base store accepts full permitted rows only. A root or relationship projection is applied by
 * the reader after the shared rows are installed, so it cannot create a partial-row merge problem.
 */
export const withoutCollectionQueryProjection = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(withoutCollectionQueryProjection);
	const record = asRecord(value);
	if (record === undefined) return value;
	return Object.fromEntries(
		Object.entries(record).flatMap(([key, entry]) =>
			key === 'columns' ? [] : [[key, withoutCollectionQueryProjection(entry)]]
		)
	);
};

type ColumnProjection = Readonly<Record<string, boolean>>;
const isProjectedStoredRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const columnProjection = (value: unknown): ColumnProjection | undefined => {
	const record = asRecord(value);
	if (record === undefined) return undefined;
	const entries = Object.entries(record).filter(
		(entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
	);
	return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

const projectColumns = (
	row: StoredRecord,
	columns: ColumnProjection | undefined
): StoredRecord => {
	if (columns === undefined) return row;
	const entries = Object.entries(columns);
	const inclusive = entries.some(([, included]) => included);
	return Object.fromEntries(
		Object.entries(row).filter(([field]) =>
			inclusive ? columns[field] === true : columns[field] !== false
		)
	);
};

const projectRelationshipRecord = (row: StoredRecord, spec: unknown): StoredRecord => {
	const record = asRecord(spec);
	return projectCollectionQueryRecord(row, record?.['columns'], record?.['with']);
};

const projectRelationshipValue = (value: Schema.Json, spec: unknown): Schema.Json => {
	if (Array.isArray(value)) {
		return value.map((entry) => {
			const row = asRecord(entry);
			return row === undefined || !isProjectedStoredRecord(row)
				? entry
				: projectRelationshipRecord(row, spec);
		});
	}
	const row = asRecord(value);
	if (row === undefined || !isProjectedStoredRecord(row)) return value;
	const kind = row['kind'];
	const related = asRecord(row['record']);
	if (typeof kind === 'string' && typeof row['id'] === 'string') {
		if (related !== undefined && isProjectedStoredRecord(related)) {
			const variant = asRecord(spec)?.[kind] ?? spec;
			return { ...row, record: projectRelationshipRecord(related, variant) };
		}
		return row;
	}
	return projectRelationshipRecord(row, spec);
};

/**
 * Applies authored projection only after an authoritative full-row page has been normalized.
 *
 * Requested relationship fields survive an inclusive root projection, matching the collection API:
 * `columns` selects base columns while `with` independently selects expanded relationships. Logical
 * references keep their `{ kind, id }` handle and project only the expanded `record` member.
 */
export const projectCollectionQueryRecord = (
	row: StoredRecord,
	columns: unknown,
	relationships: unknown
): StoredRecord => {
	const projected: Record<string, Schema.Json> = {
		...projectColumns(row, columnProjection(columns))
	};
	const requested = asRecord(relationships);
	if (requested === undefined) return projected;
	for (const [relation, spec] of Object.entries(requested)) {
		if (spec === false || spec === undefined || !Object.hasOwn(row, relation)) continue;
		projected[relation] = projectRelationshipValue(row[relation]!, spec);
	}
	return projected;
};

/** Projects a page/group at read time while leaving its authoritative hydration rows untouched. */
export const projectCollectionQueryRows = (
	rows: ReadonlyArray<StoredRecord>,
	columns: unknown,
	relationships: unknown
): ReadonlyArray<StoredRecord> =>
	rows.map((row) => projectCollectionQueryRecord(row, columns, relationships));

/** Projection and paging are read concerns even when nested under a relationship. */
const canonicalRelationships = (value: unknown): Schema.Json | null => {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object') return Schema.is(Schema.Json)(value) ? value : null;
	if (Array.isArray(value)) return value.map((entry) => canonicalRelationships(entry));
	const normalized: Record<string, Schema.Json> = {};
	for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0
	)) {
		if (
			entry === undefined ||
			entry === false ||
			key === 'columns' ||
			key === 'after' ||
			key === 'limit'
		)
			continue;
		if (key === 'orderBy') {
			const order = asRecord(entry);
			normalized[key] =
				order === undefined
					? (jsonValue(entry) ?? null)
					: Object.entries(order).flatMap(([field, direction]) =>
							direction === 'asc' || direction === 'desc' ? [[field, direction]] : []
						) as Schema.Json;
			continue;
		}
		const child = canonicalRelationships(entry);
		if (child !== null || entry === null) normalized[key] = child;
		else if (asRecord(entry) !== undefined) normalized[key] = {};
	}
	return Object.keys(normalized).length === 0 ? null : normalized;
};

const canonicalOrder = (
	value: unknown,
	collection: string,
	metadata: CollectionQueryMetadata,
	markUnknown: () => void
): ReadonlyArray<CanonicalOrderTerm> => {
	const order = value === undefined || value === null ? {} : asRecord(value);
	if (order === undefined) markUnknown();
	const terms: Array<CanonicalOrderTerm> = [];
	for (const [field, direction] of Object.entries(order ?? {})) {
		if (direction !== 'asc' && direction !== 'desc') {
			markUnknown();
			continue;
		}
		if (!metadata.hasField(collection, field)) {
			markUnknown();
			continue;
		}
		terms.push({ field, direction });
	}
	return terms.some(({ field }) => field === 'id')
		? terms
		: [...terms, { field: 'id', direction: 'asc' }];
};

const canonicalGroup = (
	kind: CollectionQueryKind,
	value: unknown,
	collection: string,
	metadata: CollectionQueryMetadata,
	markUnknown: () => void
): CanonicalCollectionGroup | null => {
	if (kind !== 'findGrouped') return null;
	const group = asRecord(value);
	const by = group?.['by'];
	const lanes = group?.['lanes'];
	if (
		typeof by !== 'string' ||
		by.length === 0 ||
		!metadata.hasField(collection, by) ||
		metadata.fieldKind(collection, by) === 'reference' ||
		metadata.fieldKind(collection, by) === 'json' ||
		(lanes !== undefined && !Array.isArray(lanes))
	) {
		markUnknown();
		return null;
	}
	const canonicalLanes = (lanes ?? []).flatMap((lane) =>
		Schema.is(Schema.Json)(lane) ? [lane] : []
	);
	if (canonicalLanes.length !== (lanes ?? []).length) markUnknown();
	return { by, lanes: canonicalLanes };
};

/**
 * Exact evaluator vocabulary shared by authoritative PostgreSQL and the PGlite replica.
 *
 * A local reader may advertise `pinnedCollation: true` only when it emits `COLLATE "C"` for every
 * operator in `textOperators`, every searchable text expression and every text order/cursor term.
 */
export const COLLECTION_QUERY_LOCAL_EVALUATOR_CONTRACT = {
	version: 1,
	collation: 'postgres-c-v1',
	sqlCollation: 'C',
	operators: [
		'eq',
		'ne',
		'gt',
		'gte',
		'lt',
		'lte',
		'like',
		'ilike',
		'notLike',
		'notIlike',
		'arrayContains',
		'arrayContained',
		'arrayOverlaps',
		'in',
		'notIn',
		'isNull',
		'isNotNull',
		'contains_date',
		'overlaps',
		'kind'
	],
	textOperators: [
		'eq',
		'ne',
		'gt',
		'gte',
		'lt',
		'lte',
		'like',
		'ilike',
		'notLike',
		'notIlike',
		'in',
		'notIn'
	]
} as const;

const LOCAL_OPERATORS = new Set<string>(COLLECTION_QUERY_LOCAL_EVALUATOR_CONTRACT.operators);

const TEXT_OPERATORS = new Set<string>(
	COLLECTION_QUERY_LOCAL_EVALUATOR_CONTRACT.textOperators
);

type QueryInspection = {
	readonly dependencies: Set<string>;
	readonly operators: Set<string>;
	usesTextSemantics: boolean;
	usesRelationships: boolean;
	usesRelationshipPredicates: boolean;
	unknown: boolean;
};

const inspectWhere = (
	value: unknown,
	collection: string,
	metadata: CollectionQueryMetadata,
	inspection: QueryInspection
): void => {
	if (value === undefined || value === null) return;
	const where = asRecord(value);
	if (where === undefined) {
		inspection.unknown = true;
		return;
	}
	for (const [field, condition] of Object.entries(where)) {
		if (field === 'AND' || field === 'OR') {
			if (!Array.isArray(condition)) inspection.unknown = true;
			else for (const branch of condition) inspectWhere(branch, collection, metadata, inspection);
			continue;
		}
		if (field === 'NOT') {
			inspectWhere(condition, collection, metadata, inspection);
			continue;
		}
		if (metadata.hasField(collection, field)) {
			const operators = asRecord(condition);
			if (operators === undefined) {
				inspection.unknown = true;
				continue;
			}
			for (const operator of Object.keys(operators)) {
				inspection.operators.add(operator);
				if (!LOCAL_OPERATORS.has(operator)) inspection.unknown = true;
				if (metadata.fieldKind(collection, field) === 'string' && TEXT_OPERATORS.has(operator)) {
					inspection.usesTextSemantics = true;
				}
			}
			continue;
		}
		const targets = metadata.relationTargets(collection, field);
		if (targets.length === 0) {
			inspection.unknown = true;
			continue;
		}
		inspection.usesRelationships = true;
		inspection.usesRelationshipPredicates = true;
		for (const target of targets) {
			inspection.dependencies.add(target);
			inspectWhere(condition, target, metadata, inspection);
		}
	}
};

const inspectRelationships = (
	value: unknown,
	collection: string,
	metadata: CollectionQueryMetadata,
	inspection: QueryInspection
): void => {
	if (value === undefined || value === null) return;
	const relationships = asRecord(value);
	if (relationships === undefined) {
		inspection.unknown = true;
		return;
	}
	for (const [name, spec] of Object.entries(relationships)) {
		if (spec === false || spec === undefined) continue;
		const targets = metadata.relationTargets(collection, name);
		if (targets.length === 0) {
			inspection.unknown = true;
			continue;
		}
		inspection.usesRelationships = true;
		for (const target of targets) inspection.dependencies.add(target);
		const relationshipSpec = asRecord(spec);
		if (relationshipSpec === undefined) continue;
		const inspectTargetSpec = (target: string, targetSpec: unknown): void => {
			const record = asRecord(targetSpec);
			if (record === undefined) return;
			inspectWhere(record['where'], target, metadata, inspection);
			inspectRelationships(record['with'], target, metadata, inspection);
			const targetSearch = record['search'];
			if (typeof targetSearch === 'string' && targetSearch.trim() !== '') {
				inspection.operators.add('ilike');
				inspection.usesTextSemantics = true;
			}
		};
		const variants = Object.entries(relationshipSpec).flatMap(([variant, targetSpec]) => {
			const target = metadata.relationVariantTarget?.(collection, name, variant);
			return target === undefined ? [] : [{ target, targetSpec }];
		});
		if (variants.length > 0) {
			for (const { target, targetSpec } of variants) inspectTargetSpec(target, targetSpec);
			continue;
		}
		for (const target of targets) inspectTargetSpec(target, relationshipSpec);
	}
};

const serverProof = (
	reasons: ReadonlyArray<
		| 'aggregate'
		| 'grouped'
		| 'local-relationships-unavailable'
		| 'local-search-unavailable'
		| 'unpinned-collation'
		| 'unsupported-operator'
		| 'unknown-query-shape'
	>
): CollectionQueryReproducibility => ({
	_tag: 'ServerProof',
	reasons: [...new Set(reasons)]
});

/**
 * Canonicalizes one query and derives the dependencies the server must confirm.
 *
 * `pinnedCollation` may be true only when both evaluators apply PostgreSQL `COLLATE "C"` to every
 * collation-sensitive predicate and order term. Until that is true, the query remains a perfectly
 * usable server-proof window rather than being mislabeled locally exact.
 */
export const canonicalizeCollectionQuery = (
	kind: CollectionQueryKind,
	input: Readonly<Record<string, unknown>>,
	metadata: CollectionQueryMetadata,
	options: Readonly<{
		readonly pinnedCollation?: boolean;
		/** Complete, normalized `with` payloads can be rendered from retained relationship edges. */
		readonly localRelationships?: boolean;
		readonly localSearch?: boolean;
	}> = {}
): CanonicalCollectionQueryResult | undefined => {
	const collection = input['collection'];
	if (typeof collection !== 'string' || collection.trim() === '') return undefined;
	let invalidOrder = false;
	const orderBy = canonicalOrder(input['orderBy'], collection, metadata, () => {
		invalidOrder = true;
	});
	const group = canonicalGroup(kind, input['group'], collection, metadata, () => {
		invalidOrder = true;
	});
	const query: CanonicalCollectionQuery = {
		version: 1,
		kind,
		collection,
		authoredWhere: jsonValue(input['where']),
		userFilter: jsonValue(input['userFilter']),
		search:
			typeof input['search'] === 'string' && input['search'].trim() !== ''
				? input['search'].trim()
				: null,
		relationships: canonicalRelationships(input['with']),
		orderBy,
		group
	};
	const inspection: QueryInspection = {
		dependencies: new Set([collection]),
		operators: new Set(),
		usesTextSemantics: false,
		usesRelationships: false,
		usesRelationshipPredicates: false,
		unknown: invalidOrder
	};
	inspectWhere(input['where'], collection, metadata, inspection);
	inspectWhere(input['userFilter'], collection, metadata, inspection);
	inspectRelationships(input['with'], collection, metadata, inspection);
	if (query.search !== null) {
		inspection.operators.add('ilike');
		inspection.usesTextSemantics = true;
	}
	for (const { field } of orderBy) {
		if (metadata.fieldKind(collection, field) === 'string') inspection.usesTextSemantics = true;
	}
	const reasons: Array<
		| 'aggregate'
		| 'grouped'
		| 'local-relationships-unavailable'
		| 'local-search-unavailable'
		| 'unpinned-collation'
		| 'unsupported-operator'
		| 'unknown-query-shape'
	> = [];
	if (kind === 'count') reasons.push('aggregate');
	if (kind === 'findGrouped') reasons.push('grouped');
	// Relationship predicates change root membership and remain server-owned. A plain `with` is a
	// read-time expansion: the normalized edge set and target rows reproduce the authoritative
	// answer locally until a dependency moves.
	if (
		inspection.usesRelationshipPredicates ||
		(inspection.usesRelationships && options.localRelationships !== true)
	) reasons.push('local-relationships-unavailable');
	if (query.search !== null && options.localSearch !== true) {
		reasons.push('local-search-unavailable');
	}
	if (inspection.unknown) reasons.push('unknown-query-shape');
	if ([...inspection.operators].some((operator) => !LOCAL_OPERATORS.has(operator))) {
		reasons.push('unsupported-operator');
	}
	if (inspection.usesTextSemantics && options.pinnedCollation !== true) {
		reasons.push('unpinned-collation');
	}
	return {
		query,
		dependencies: [...inspection.dependencies].toSorted(),
		reproducibility:
			reasons.length > 0
				? serverProof(reasons)
				: {
						_tag: 'LocalExact',
						semantics: {
							version: COLLECTION_QUERY_LOCAL_EVALUATOR_CONTRACT.version,
							collation: inspection.usesTextSemantics
								? COLLECTION_QUERY_LOCAL_EVALUATOR_CONTRACT.collation
								: 'none',
							operators: [...inspection.operators].toSorted()
						}
					}
	};
};

/** Exact bytes hashed for a query window key. */
export const canonicalQueryKeyEncoding = (
	identity: CollectionQueryIdentity,
	query: CanonicalCollectionQuery
): string =>
	`${canonicalQueryJson({
		protocolVersion: identity.protocolVersion,
		schemaFingerprint: identity.schemaFingerprint,
		partitionKey: identity.partitionKey,
		query
	})}\n`;

const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Opaque identity shared by every continuation and projection of one canonical query. */
export const collectionQueryKey = (
	identity: CollectionQueryIdentity,
	query: CanonicalCollectionQuery
): Effect.Effect<string, Error> =>
	Effect.tryPromise({
		try: async () => {
			if (globalThis.crypto?.subtle === undefined) {
				throw new Error('The sync engine cannot compute query identities without WebCrypto.');
			}
			const digest = await globalThis.crypto.subtle.digest(
				'SHA-256',
				new TextEncoder().encode(canonicalQueryKeyEncoding(identity, query))
			);
			return `query:sha256:${hex(digest)}`;
		},
		catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
	});

export type NormalizedCollectionHydration = Readonly<{
	readonly baseRows: ReadonlyArray<CollectionHydrationRow>;
	readonly relationshipRefs: ReadonlyArray<CollectionRelationshipMembership>;
}>;

const storedRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

/**
 * Normalizes the server's nested public relationship shape into O3 rows plus membership edges.
 *
 * The nested shape remains available to the immediate public response, but it is never persisted as
 * a second copy. Logical-reference `{ kind, id, record }` handles are restored to `{ kind, id }` in
 * the base row, and declared virtual relationship fields are removed from their source row.
 */
export const normalizeCollectionHydration = (
	definition: WorkspaceDefinition,
	rootCollection: string,
	rows: ReadonlyArray<Readonly<Record<string, Schema.Json>>>
): Result.Result<NormalizedCollectionHydration, Error> => {
	const collections = new Map(
		definition.collections.map((collection) => [collection.name, collection] as const)
	);
	const baseRows = new Map<string, CollectionHydrationRow>();
	const relationshipRefs = new Map<string, CollectionRelationshipMembership>();
	let failure: Error | undefined;

	const visit = (collection: string, candidate: unknown): string | undefined => {
		if (failure !== undefined) return undefined;
		if (!storedRecord(candidate)) {
			failure = new Error(`Hydrated ${collection} relationship row is not a JSON object.`);
			return undefined;
		}
		const recordId = candidate['id'];
		const rowVersion = candidate['row_version'];
		if (
			typeof recordId !== 'string' ||
			recordId.length === 0 ||
			typeof rowVersion !== 'number' ||
			!Number.isSafeInteger(rowVersion) ||
			rowVersion < 1
		) {
			failure = new Error(`Hydrated ${collection} row is missing id or row_version.`);
			return undefined;
		}
		const collectionDefinition = collections.get(collection);
		if (collectionDefinition === undefined) {
			failure = new Error(`Hydrated relationship names unknown collection ${collection}.`);
			return undefined;
		}
		const row: Record<string, Schema.Json> = { ...candidate };
		const children: Array<Readonly<{
			relation: string;
			targetCollection: string;
			record: Readonly<Record<string, Schema.Json>>;
		}>> = [];

		for (const [field, fieldDefinition] of Object.entries(collectionDefinition.fields)) {
			if (fieldDefinition.reference === undefined) continue;
			const handle = asRecord(row[field]);
			if (handle === undefined) continue;
			const kind = handle['kind'];
			const target = fieldDefinition.reference.targets.find(({ tag }) => tag === kind);
			const related = handle['record'];
			// The base store keeps the authored logical handle and never the expanded record payload.
			const compact = Object.fromEntries(
				Object.entries(handle).filter(([key]) => key !== 'record')
			);
			if (storedRecord(compact)) row[field] = compact;
			if (target !== undefined && storedRecord(related)) {
				children.push({ relation: field, targetCollection: target.collection, record: related });
			}
		}

		for (const relation of definition.relations) {
			if (relation.source !== collection || !Object.hasOwn(row, relation.name)) continue;
			const related = row[relation.name];
			// Declared relation payloads are always virtual. Persisting this member would put the same
			// target record back inside its source after normalizing it into the shared base row.
			delete row[relation.name];
			const candidates = Array.isArray(related) ? related : related == null ? [] : [related];
			for (const entry of candidates) {
				if (storedRecord(entry)) {
					children.push({
						relation: relation.name,
						targetCollection: relation.target,
						record: entry
					});
				}
			}
		}

		const key = `${collection}\u0000${recordId}`;
		const hydrated: CollectionHydrationRow = { collection, recordId, rowVersion, row };
		const existing = baseRows.get(key);
		if (existing === undefined || existing.rowVersion < rowVersion) baseRows.set(key, hydrated);
		else if (
			existing.rowVersion === rowVersion &&
			canonicalQueryJson(existing.row) !== canonicalQueryJson(row)
		) {
			failure = new Error(
				`Hydrated ${collection} ${recordId} has conflicting payloads at row version ${rowVersion}.`
			);
			return undefined;
		}

		for (const child of children) {
			const targetRecordId = visit(child.targetCollection, child.record);
			if (targetRecordId === undefined) continue;
			const membership: CollectionRelationshipMembership = {
				sourceCollection: collection,
				sourceRecordId: recordId,
				relation: child.relation,
				targetCollection: child.targetCollection,
				targetRecordId
			};
			relationshipRefs.set(
				`${collection}\u0000${recordId}\u0000${child.relation}\u0000${child.targetCollection}\u0000${targetRecordId}`,
				membership
			);
		}
		return recordId;
	};

	for (const row of rows) visit(rootCollection, row);
	return failure === undefined
		? Result.succeed({
				baseRows: [...baseRows.values()],
				relationshipRefs: [...relationshipRefs.values()]
			})
		: Result.fail(failure);
};

/** Adapts the authoritative workspace graph to the same canonicalizer used in the browser. */
export const workspaceCollectionQueryMetadata = (
	definition: WorkspaceDefinition
): CollectionQueryMetadata => {
	const collections = new Map(
		definition.collections.map((collection) => [collection.name, collection] as const)
	);
	const systemKinds: Readonly<Record<string, string>> = {
		id: 'uuid',
		created_at: 'instant',
		updated_at: 'instant',
		row_version: 'number',
		approval_id: 'uuid',
		sys_period: 'json'
	};
	return {
		hasField: (collection, field) =>
			SYSTEM_COLUMN_NAMES.includes(field) ||
			Object.hasOwn(collections.get(collection)?.fields ?? {}, field),
		fieldKind: (collection, field) =>
			collections.get(collection)?.fields[field]?.type ?? systemKinds[field],
		relationTargets: (collection, relation) => {
			const logical = collections.get(collection)?.fields[relation]?.reference;
			if (logical !== undefined) {
				return [...new Set(logical.targets.map(({ collection: target }) => target))].toSorted();
			}
			return [
				...new Set(
					definition.relations
						.filter((entry) => entry.source === collection && entry.name === relation)
						.map(({ target }) => target)
				)
			].toSorted();
		},
		relationVariantTarget: (collection, relation, variant) =>
			collections
				.get(collection)
				?.fields[relation]?.reference?.targets.find(({ tag }) => tag === variant)?.collection
	};
};
