import { z } from 'zod';
import type {
	CountWireSchema,
	CollectionFilterSchema,
	CreateManyWireSchema,
	CreateWireSchema,
	DeleteWireSchema,
	FindFirstWireSchema,
	FindGroupedWireSchema,
	FindHistoryWireSchema,
	FindManyWireSchema,
	UpdateManyWireSchema,
	UpdateWireSchema
} from '../remote/collection_wire_schemas.js';

export const CollectionMutationActionSchema = z.enum(['create', 'update', 'delete']);
export type CollectionMutationAction = z.infer<typeof CollectionMutationActionSchema>;

export interface CollectionRecord {
	readonly [field: string]: unknown;
}

export interface RemoteQuery<T> {
	readonly current: T | undefined;
	readonly loading: boolean;
	readonly error: Error | undefined;
	refresh(): Promise<void>;
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
	TCreate extends object = CollectionRecord,
	TUpdate extends object = CollectionRecord
> {
	readonly row: TRow;
	readonly create: TCreate;
	readonly update: TUpdate;
}

export type CollectionRegistry = Readonly<Record<string, CollectionType<object, object, object>>>;
export type ErasedCollectionRegistry = Readonly<Record<string, CollectionType>>;

export type CollectionRow<TCollection extends CollectionType<object, object, object>> =
	TCollection['row'];
export type CollectionCreateInput<TCollection extends CollectionType<object, object, object>> =
	TCollection['create'];
export type CollectionUpdateInput<TCollection extends CollectionType<object, object, object>> =
	TCollection['update'];
export type CollectionFieldName<TCollection extends CollectionType<object, object, object>> =
	Extract<keyof CollectionRow<TCollection>, string>;

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
	readonly values?: readonly string[];
	readonly options?: Readonly<Record<string, unknown>>;
	readonly currencies?: readonly string[];
	readonly mimeTypes?: readonly string[];
	readonly variant?: NumericRendererVariant;
	/**
	 * Explicit search opt-in, authored as `text({ search: true })`.
	 *
	 * Search is opt-in: only a non-array text/phone/enum field carrying `search: true` gets a
	 * trigram search index and participates in any search path — the collection search box, the
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
 * Whether a field is searchable — the predicate every search path and the trigram index creation
 * agree on. Search runs over exactly the fields that got a trigram index, and both are explicit
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

export function collectionSearchTrigramIndexName(tableName: string, columnName: string): string {
	const fullName = `${tableName}_${columnName}_search_trgm_idx`;
	if (fullName.length <= 63) return fullName;
	let hash = 2166136261;
	for (const character of fullName) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16777619);
	}
	const suffix = `_${(hash >>> 0).toString(36)}_trgm_idx`;
	return `${fullName.slice(0, 63 - suffix.length)}${suffix}`;
}

export interface CollectionRelationship {
	readonly name: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
}

export interface CollectionDefinition<
	TCollection extends CollectionType<object, object, object> = CollectionType
> {
	readonly name: string;
	readonly recordLabel?: string | null;
	readonly system?: boolean;
	readonly fields: readonly CollectionField<CollectionFieldName<TCollection>>[];
	readonly relationships?: readonly CollectionRelationship[];
}

export type CollectionWhere<_TRow extends object> = Readonly<Record<string, unknown>>;

export interface CollectionBaseQuery<TRow extends object> {
	readonly with?: Record<string, unknown>;
	readonly where?: CollectionWhere<TRow>;
	/** Typo-tolerant search across text/phone/enum fields and direct relationship text labels. */
	readonly search?: string;
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

export type CollectionFilter = z.infer<typeof CollectionFilterSchema>;

export interface CollectionFilterOptions {
	readonly filters?: readonly CollectionFilter[];
}

export interface CollectionOperations<TCollection extends CollectionType<object, object, object>> {
	readonly findMany: (
		query?: CollectionQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	) => CollectionPageQuery<CollectionRow<TCollection>>;
	readonly findFirst: (
		query?: CollectionBaseQuery<CollectionRow<TCollection>>
	) => RemoteQuery<CollectionRow<TCollection> | undefined>;
	readonly findGrouped: (
		query: CollectionGroupedQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	) => RemoteQuery<CollectionGroupedResult<CollectionRow<TCollection>>>;
	readonly count: (
		query?: CollectionBaseQuery<CollectionRow<TCollection>>,
		options?: CollectionFilterOptions
	) => RemoteQuery<number>;
	readonly create?: (
		input: CollectionCreateInput<TCollection>
	) => Promise<CollectionRow<TCollection>>;
	readonly createMany?: (
		inputs: readonly CollectionCreateInput<TCollection>[]
	) => Promise<CollectionRow<TCollection>[]>;
	readonly update?: (
		recordId: string,
		input: CollectionUpdateInput<TCollection>
	) => Promise<CollectionRow<TCollection>>;
	readonly updateMany?: (
		updates: readonly {
			readonly recordId: string;
			readonly input: CollectionUpdateInput<TCollection>;
		}[]
	) => Promise<CollectionRow<TCollection>[]>;
	readonly delete?: (recordId: string) => Promise<void>;
}

export interface CollectionApprovalRequest {
	readonly norbital_id: string;
	readonly status: string;
}

export interface CollectionApprovalOperations {
	readonly findMany: (
		approvalRequestId: string
	) => RemoteQuery<readonly CollectionApprovalRequest[]>;
	readonly process: (input: {
		readonly approvalRequestId: string;
		readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';
		readonly comments?: string;
	}) => Promise<void>;
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

export interface CollectionClient<TCollections extends CollectionRegistry> {
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

/** Tenant-authored collection surfaces receive only the typed database vocabulary. */
export interface CollectionDbClient<TCollections extends CollectionRegistry> {
	readonly db: CollectionClient<TCollections>['db'];
}

/** Schema-erased collection transport used below typed collection clients. */
export interface CollectionTransport {
	readonly findMany: (
		input: z.infer<typeof FindManyWireSchema>
	) => RemoteQuery<CollectionPage<CollectionRecord>>;
	readonly findFirst: (
		input: z.infer<typeof FindFirstWireSchema>
	) => RemoteQuery<CollectionRecord | undefined>;
	readonly findGrouped: (
		input: z.infer<typeof FindGroupedWireSchema>
	) => RemoteQuery<CollectionGroupedResult<CollectionRecord>>;
	readonly findHistory?: (
		input: z.infer<typeof FindHistoryWireSchema>
	) => RemoteQuery<readonly CollectionRecordHistoryEntry[]>;
	readonly count: (input: z.infer<typeof CountWireSchema>) => RemoteQuery<number>;
	readonly create: (input: z.infer<typeof CreateWireSchema>) => Promise<CollectionRecord>;
	readonly createMany: (input: z.infer<typeof CreateManyWireSchema>) => Promise<CollectionRecord[]>;
	readonly update: (input: z.infer<typeof UpdateWireSchema>) => Promise<CollectionRecord>;
	readonly updateMany?: (
		input: z.infer<typeof UpdateManyWireSchema>
	) => Promise<CollectionRecord[]>;
	readonly delete: (input: z.infer<typeof DeleteWireSchema>) => Promise<void>;
}
