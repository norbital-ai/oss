/**
 * The collection contract: what a collection field is, how a collection is queried, and which
 * fields are searchable.
 *
 * This lives in `std` because it is the one vocabulary every layer has to agree on and no layer
 * owns. The design system types its public props with it, the compiler decides which columns feed
 * the generated search document with it, and an application builds queries with it — so whichever
 * package hosts it becomes a dependency of all three. `std` is the only package that can be: it
 * depends on nothing in the workspace, and `bolt`, `ui` and `colony` already depend on it.
 *
 * The alternatives are a cycle and a lie about layering. `bolt` cannot host it because `bolt`
 * depends on `ui` (it ships the client Svelte surface under `src/client/ui/`), so `ui` importing
 * `bolt` back would close the loop. `ui` closes no loop but would make the design system a
 * dependency of everything that merely names a column — a template's `+model.ts`, the compiler's
 * index planning, a server-side query — none of which render anything.
 *
 * Deliberately schema-free. The wire schemas that validate these shapes stay with the transport
 * that speaks them; here the TypeScript type is the source of truth.
 */

export { labelTermText, resolveRecordLabel } from './record-label.js';
export {
	isSystemCollectionField,
	SYSTEM_COLLECTION_FIELD_NAMES,
	type SystemCollectionFieldName
} from './system-fields.js';

export interface CollectionRecord {
	readonly [field: string]: unknown;
}

export interface RemoteQuery<T> extends PromiseLike<T> {
	readonly current: T | undefined;
	readonly loading: boolean;
	readonly error: Error | undefined;
}

export interface CollectionPage<TRow extends object = CollectionRecord> {
	readonly rows: TRow[];
	readonly nextCursor: string | null;
}

/** A collection page keeps the familiar row result while exposing its opaque continuation. */
export interface CollectionPageQuery<TRow extends object> extends RemoteQuery<TRow[]> {
	readonly nextCursor: string | null | undefined;
}

export interface CollectionType<
	TRow extends object = CollectionRecord,
	TMutation extends object = CollectionRecord
> {
	readonly row: TRow;
	/** Exact recursively generated graph accepted by the declarative browser mutation. */
	readonly mutation: TMutation;
}

export type CollectionRegistry = Readonly<Record<string, CollectionType<CollectionRecord, object>>>;
export type ErasedCollectionRegistry = Readonly<Record<string, CollectionType>>;

export type CollectionRow<TCollection extends CollectionType<object, object>> = TCollection['row'];
export type CollectionFieldName<TCollection extends CollectionType<object, object>> = Extract<
	keyof CollectionRow<TCollection>,
	string
>;

export type NumericRendererVariant =
	| { readonly type: 'number' }
	| { readonly type: 'star-rating'; readonly max: number }
	| { readonly type: 'progress'; readonly denominator: number };

export interface CollectionField<TName extends string = string> {
	readonly name: TName;
	readonly kind: string;
	readonly nullable: boolean;
	readonly label?: string;
	readonly array?: boolean;
	readonly readOnly?: boolean;
	readonly values?: readonly string[] | undefined;
	/** How precisely an instant range is picked: calendar days, or date-times. */
	readonly precision?: 'day' | 'minute' | undefined;
	readonly options?: Readonly<Record<string, unknown>>;
	readonly currencies?: readonly string[];
	readonly mimeTypes?: readonly string[];
	readonly variant?: NumericRendererVariant;
	/**
	 * Explicit search opt-in, authored as `text({ search: true })`.
	 *
	 * Search is opt-in: only a non-array text/phone/enum field carrying `search: true` gets a
	 * generated lexical document and participates in any search path — the collection search box, the
	 * omni finder and @ mentions, relation pickers. Absent means the field is never searched and
	 * never indexed, however text-like its kind.
	 */
	readonly search?: boolean;
	/**
	 * Carries no label: how a related record reads is a view decision, declared where the relation
	 * is rendered (a table column's `relation.label`), not inherited from the target collection.
	 */
	readonly relation?: {
		readonly name: string;
		readonly target: string;
	};
}

export const COLLECTION_SEARCH_MAX_LENGTH = 200;

/**
 * One collection search command.
 *
 * Both branches are explicit so callers cannot accidentally route ordinary type-ahead through the
 * embedding path.
 */
export type CollectionSearch =
	| Readonly<{
			readonly mode: 'lexical';
			readonly term: string;
	  }>
	| Readonly<{
			readonly mode: 'semantic';
			readonly term: string;
	  }>;

/**
 * Whether a field is searchable — the predicate every search path and lexical document generation
 * agree on. Search runs over exactly the fields that feed the shared indexes, and both are explicit
 * opt-ins: a non-array text/phone/enum field is only searchable when the author wrote
 * `text({ search: true })` (or the equivalent on `phone()`/`enums()`).
 *
 * The trigram index itself is language-agnostic: `gin_trgm_ops` indexes character trigrams, not
 * words, so the same index serves substring search in any script — CJK, accented Latin, RTL —
 * without dictionaries or tokenizers. The index and the search must never assume a language.
 */
export function isSearchableCollectionField(field: CollectionField): boolean {
	return !field.array && ['text', 'phone', 'enum'].includes(field.kind) && field.search === true;
}

export interface CollectionRelationship {
	readonly name: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
}

export interface CollectionDefinition<
	TCollection extends CollectionType<object, object> = CollectionType
> {
	readonly name: string;
	readonly recordLabel?: string | null;
	readonly system?: boolean;
	readonly fields: readonly CollectionField<CollectionFieldName<TCollection>>[];
	readonly relationships?: readonly CollectionRelationship[];
}

export type CollectionWhere<_TRow extends object> = { readonly [field: string]: unknown };

export interface CollectionBaseQuery<TRow extends object> {
	readonly with?: Record<string, unknown>;
	readonly where?: CollectionWhere<TRow>;
	/** Explicit lexical or semantic collection search. */
	readonly search?: CollectionSearch;
	readonly columns?: Record<string, boolean>;
	readonly orderBy?: Partial<Record<Extract<keyof TRow, string>, 'asc' | 'desc'>>;
	readonly bypass_secret?: string;
}

export interface CollectionQuery<TRow extends object> extends CollectionBaseQuery<TRow> {
	readonly limit?: number;
	/** Opaque continuation returned by the previous page. */
	readonly after?: string;
}

export interface CollectionGroupedQuery<TRow extends object> extends CollectionBaseQuery<TRow> {
	readonly limit?: number;
	readonly group: {
		readonly by: Extract<keyof TRow, string>;
		readonly lanes?: unknown[];
	};
}

export type CollectionGroupedResult<TRow extends object> = Readonly<Record<string, TRow[]>>;

/**
 * How a relationship presents its option set, declared inline wherever the relationship is
 * rendered — a table column, a form field, a matrix cell.
 *
 * A relationship is a picker: the stored value is only the key that selects one option, so what a
 * surface needs is the option set, not a property of the target collection. The same target reads
 * differently in different places (an employment might be an employee number here and a name plus
 * department there), which is why this is declared per use and not inherited from the model.
 *
 * `TRow` is the *target* collection's row, so `label` and the field lists are checked against the
 * records actually being picked from.
 */
export interface CollectionRelationOptions<TRow extends object = CollectionRecord> {
	/** How one option reads. Required — nothing is inferred, and without it a value shows as its id. */
	readonly label: (record: TRow) => string;
	/** Narrows which records are offered. */
	readonly where?: CollectionBaseQuery<TRow>['where'];
	readonly orderBy?: CollectionBaseQuery<TRow>['orderBy'];
	readonly limit?: number;
	/** Fields the picker's search box matches. Defaults to the server's search behaviour. */
	readonly searchFields?: readonly Extract<keyof TRow, string>[];
	/** Fields the picker offers as filter controls, so a long option list stays navigable. */
	readonly filters?: readonly Extract<keyof TRow, string>[];
}

/**
 * One filter condition as the wire carries it.
 *
 * Stated structurally, because the schema needs a transport and the vocabulary does not — a table
 * rendering filter chips has no business importing a wire validator to learn what a filter is.
 *
 * `operator` stays an inline union rather than an exported alias: the filter builder already
 * extends it as `CollectionFilter['operator'] | 'contains'`, and a second exported name for the
 * same set is how the two drift.
 */
export interface CollectionFilter {
	/** Root field path or a path reached through at most two relationship edges. */
	readonly path: readonly string[];
	readonly operator:
		| 'eq'
		| 'ne'
		| 'gt'
		| 'gte'
		| 'lt'
		| 'lte'
		| 'ilike'
		| 'isNull'
		| 'isNotNull'
		| 'arrayContains'
		| 'arrayOverlaps'
		| 'contains_date'
		| 'overlaps';
	/** Omitted for the operators that take none (`isNull`, `isNotNull`). */
	readonly operand?: unknown;
}

export interface CollectionFilterOptions {
	readonly filters?: readonly CollectionFilter[];
}

export interface CollectionMutationQuarantine {
	readonly code: string;
	readonly message: string;
	readonly atEpochMs: number;
}

export interface CollectionMutationPendingApproval {
	readonly requestId: string;
	readonly collection: string;
	readonly id: string;
	readonly action: 'create' | 'update' | 'delete';
}

/** Server-authoritative M4 outcome, deliberately independent of Bolt's runtime implementation. */
export type CollectionMutationSettlement = Readonly<
	| {
			readonly kind: 'accepted';
			readonly idempotencyKey: string;
			readonly settledAtEpochMs: number;
			readonly pendingApproval?: CollectionMutationPendingApproval;
	  }
	| {
			readonly kind: 'rebased';
			readonly idempotencyKey: string;
			readonly fromSchemaFingerprint: string;
			readonly toSchemaFingerprint: string;
			readonly settledAtEpochMs: number;
	  }
	| {
			readonly kind: 'rejected';
			readonly idempotencyKey: string;
			readonly code: string;
			readonly message: string;
			readonly settledAtEpochMs: number;
	  }
	| {
			readonly kind: 'quarantined';
			readonly idempotencyKey: string;
			readonly quarantine: CollectionMutationQuarantine;
			readonly settledAtEpochMs: number;
	  }
>;

/** The authority for settlement status; Bolt's public union derives from this plus its queue phases. */
export type CollectionMutationSettlementStatus = CollectionMutationSettlement['kind'] | 'unknown';

export interface CollectionMutationSettlementHandle {
	readonly idempotencyKey: string;
	readonly settled: Promise<CollectionMutationSettlement>;
	readonly status: () => Promise<CollectionMutationSettlementStatus>;
	readonly wait: (signal?: AbortSignal) => Promise<CollectionMutationSettlement>;
}

/**
 * What browser `await mutate()` means: the graph is held in tab memory and overlaid for this tab,
 * while settlement remains explicitly asynchronous and may still be rejected or quarantined by the
 * authority. A write in a crashed or closed tab is lost before its outcome.
 */
export interface MemoryCollectionMutationResult<TRow extends object> {
	readonly durability: 'memory';
	readonly pending: true;
	readonly row: TRow | null;
	readonly idempotencyKey: string;
	readonly settlement: CollectionMutationSettlementHandle;
}

export type CollectionOperations<TCollection extends CollectionType<object, object>> = Readonly<{
	findMany(
		query?: CollectionQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	): CollectionPageQuery<CollectionRow<TCollection>>;
	findFirst(
		query?: CollectionBaseQuery<CollectionRow<TCollection>>
	): RemoteQuery<CollectionRow<TCollection> | undefined>;
	findGrouped(
		query: CollectionGroupedQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	): RemoteQuery<CollectionGroupedResult<CollectionRow<TCollection>>>;
	count(
		query?: CollectionBaseQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	): RemoteQuery<number>;
	// repository-health:allow EFF2 -- The public browser seam resolves at memory durability; authority settlement remains on the returned handle.
	mutate(
		values: ReadonlyArray<TCollection['mutation']>
	): Promise<MemoryCollectionMutationResult<CollectionRow<TCollection>>>;
	// repository-health:allow EFF2 -- The public browser seam resolves at memory durability; authority settlement remains on the returned handle.
	delete(
		ids: readonly string[]
	): Promise<MemoryCollectionMutationResult<CollectionRow<TCollection>>>;
	/** Number of in-flight writes for this collection. */
	readonly pending: number;
}>;

export interface CollectionApprovalRequest {
	readonly id: string;
	readonly status: string;
	/** Whether this principal may decide the request's current step. */
	readonly canDecide: boolean;
	/** Whether this principal may explicitly finish every remaining step. */
	readonly canSupersede: boolean;
	/** Whether this principal is the requestor and may withdraw the open request. */
	readonly canWithdraw: boolean;
}

export interface CollectionApprovalOperations {
	readonly findMany: (
		approvalRequestId: string
	) => RemoteQuery<readonly CollectionApprovalRequest[]>;
	readonly process: (input: {
		readonly approvalRequestId: string;
		readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED';
		readonly comments?: string;
		// repository-health:allow EFF2 -- Generated browser approval actions intentionally expose completion as Promise<void> at the public client boundary.
	}) => Promise<void>;
	// repository-health:allow EFF2 -- Generated browser approval withdrawal intentionally exposes completion as Promise<void> at the public client boundary.
	readonly withdraw: (approvalRequestId: string) => Promise<void>;
}

export interface CollectionRecordOperations {
	findMany(
		collectionName: string,
		query?: CollectionQuery<CollectionRecord>
	): CollectionPageQuery<CollectionRecord>;
}

export interface CollectionRecordHistoryEntry {
	readonly values: CollectionRecord;
	readonly validFrom: string;
	readonly validTo: string | null;
	readonly version: number;
}

export interface CollectionHistoryOperations {
	findMany(
		collectionName: string,
		recordId: string,
		limit?: number
	): RemoteQuery<readonly CollectionRecordHistoryEntry[]>;
}

/** Type-only witness that preserves the exact generated registry across structural client views. */
declare const collectionRegistryType: unique symbol;

export interface CollectionClient<TCollections extends CollectionRegistry> {
	readonly [collectionRegistryType]?: TCollections;
	readonly db: {
		readonly [TName in keyof TCollections]: CollectionOperations<TCollections[TName]>;
	};
	readonly collections: {
		readonly [TName in keyof TCollections]: CollectionDefinition<TCollections[TName]>;
	};
	readonly records: CollectionRecordOperations;
	readonly history?: CollectionHistoryOperations;
	readonly approvals?: CollectionApprovalOperations;
}

/**
 * Tenant-authored collection surfaces receive only the typed database vocabulary they consume.
 *
 * A surface for one authored collection must not require unrelated collections to expose the same
 * capabilities. In particular, the generic `approval_request` projection is deliberately
 * read-only in generated browser clients and therefore cannot satisfy a whole-registry writable
 * client contract.
 */
export interface CollectionDbClient<
	TCollections extends CollectionRegistry,
	TName extends keyof TCollections = keyof TCollections
> {
	readonly [collectionRegistryType]?: TCollections;
	readonly db:
		CollectionClient<TCollections>['db'] | Pick<CollectionClient<TCollections>['db'], TName>;
}
