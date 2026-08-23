import { Effect, Schema } from 'effect';
import type {
	CollectionDbClient,
	CollectionField,
	CollectionQuery,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/std/collection';
import type { Component, Snippet } from 'svelte';
import type {
	CollectionRecordMetadataResolver,
	ResolvedCollectionRecordMetadata
} from '#lib/collection-record-metadata';
import type { CollectionFilterOperator } from '#lib/collection-table/collection-table-filter-operators';

export type CollectionName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

/**
 * A filter condition the view opens with, seeded into the filter builder as an ordinary row.
 *
 * This is the *builder's* vocabulary, not the wire's: `field` is the same path the field picker
 * uses (`effective_range`, or `relation.field`), and `value` is what the operand editor would
 * produce — a calendar day for `contains_date`, which `collectionFilterClause` converts to an
 * instant on its way out. Seeding the wire shape instead would mean reversing that conversion, and
 * unwrapping the `%…%` an `ilike` operand is published with.
 *
 * A seed is a *default*, not a constraint. It arrives as a normal chip the operator can edit or
 * remove, and removing it is remembered per view — unlike a condition baked into `query.where`,
 * which is invisible, locked, and can only be narrated by the "Applied by this view" tooltip.
 */
export interface CollectionTableInitialFilter {
	/** Field path as the picker addresses it: `status`, or `agreement_employment.employee_number`. */
	readonly field: string;
	readonly operator: CollectionFilterOperator;
	/** Omitted for the operators that take none (`isNull`, `isNotNull`). */
	readonly value?: unknown;
}

export type CollectionTableRow<
	TCollections extends CollectionRegistry,
	TName extends CollectionName<TCollections>
> = CollectionRow<TCollections[TName]>;

type CollectionTableFieldName<TRow extends object> = Extract<keyof TRow, string>;

const collectionTableCardRoleSchema = Schema.Literals(['title', 'subtitle', 'badge']);
/** The card slot a column feeds when the mobile/kanban card is auto-derived (RFC V.2c). */
type CollectionTableCardRole = typeof collectionTableCardRoleSchema.Type;

export interface CollectionTableColumn<TRow extends object> {
	key: CollectionTableFieldName<TRow>;
	label?: string;
	width?: number;
	minWidth?: number;
	maxWidth?: number;
	sortable?: boolean;
	resizable?: boolean;
	hideable?: boolean;
	pinnable?: boolean;
	/** Which auto-card slot this column feeds (title/subtitle/badge) when no `ListCard` is given. */
	card?: CollectionTableCardRole;
	render?: (context: { row: TRow; field: CollectionField; value: unknown }) => unknown;
}

const COLLECTION_TABLE_SCALAR_SORT_KINDS = new Set([
	'boolean',
	'clock_time',
	'date',
	'enum',
	'integer',
	'number',
	'numeric',
	'phone',
	'text',
	'timestamp',
	'timestamptz',
	'datetime',
	'uuid'
]);

interface CollectionTableSortability {
	readonly sortable?: boolean;
}

export function collectionTableColumnCanSort(
	field: CollectionField,
	options: CollectionTableSortability
): boolean {
	return (
		options.sortable !== false &&
		!field.array &&
		field.relation == null &&
		COLLECTION_TABLE_SCALAR_SORT_KINDS.has(field.kind)
	);
}

export type CollectionTableColumnPrimitiveProps<TRow extends object> = Omit<
	CollectionTableColumn<TRow>,
	'key'
> & {
	name: CollectionTableFieldName<TRow>;
};

export interface CollectionTableRowActionContext<TRow extends object> {
	row: TRow;
	hovered: boolean;
	metadata: readonly ResolvedCollectionRecordMetadata[];
}

/** Svelte snippets construct component parameters; retain the row type through that constructor. */
type CollectionTableColumnComponent<TRow extends object> = Component<
	CollectionTableColumnPrimitiveProps<TRow>
>;

export interface CollectionTableColumnsComposition<TRow extends object> {
	Column: CollectionTableColumnComponent<TRow>;
}

export interface CollectionTableFeatures {
	readonly search?: boolean;
	readonly filter?: boolean;
	readonly create?: boolean;
}

export interface CollectionTablePipelineContext<TRow extends object> {
	readonly collectionName: string;
	readonly selectedRows: readonly TRow[];
}

export interface CollectionTablePipeline<TRow extends object> {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly icon?: string;
	/** Keeps the pipeline visible but muted until at least one row is selected. */
	readonly requiresSelection?: boolean;
	/** Returns user-facing copy when the current selection cannot run this pipeline. */
	readonly getDisabledReason?: (selectedRows: readonly TRow[]) => string | null;
	run(context: CollectionTablePipelineContext<TRow>): Effect.Effect<unknown, unknown>;
}

const collectionTableIntegrationStateSchema = Schema.Literals([
	'connected',
	'configured',
	'degraded',
	'error',
	'disabled'
]);
export type CollectionTableIntegrationState = typeof collectionTableIntegrationStateSchema.Type;

const collectionTableIntegrationStatusSchema = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	description: Schema.optionalKey(Schema.String),
	state: collectionTableIntegrationStateSchema,
	statusLabel: Schema.optionalKey(Schema.String)
});
export type CollectionTableIntegrationStatus = typeof collectionTableIntegrationStatusSchema.Type;

interface CollectionTableBaseProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionName<TCollections>,
	TRow extends object
> {
	client: CollectionDbClient<TCollections>;
	collection: TName;
	view?: string;
	query?: CollectionQuery<NoInfer<TRow>>;
	/**
	 * Conditions the view opens with, shown in the filter UI as removable chips.
	 *
	 * Use this rather than `query.where` for anything that is a *default* the operator may
	 * reasonably want to drop — "in force today", "open items only". `query.where` stays the right
	 * home for scoping the view is not entitled to widen, such as the legal entity it belongs to.
	 * Clearing a seeded chip is remembered against `view`, so it does not come back on reload.
	 */
	initialFilters?: readonly CollectionTableInitialFilter[];
	disabled?: boolean;
	/**
	 * Application-authored record behaviour and flags. Bolt injects protected system metadata such as
	 * pending approval and sync state before any collection surface consumes the result.
	 */
	recordMetadata?: CollectionRecordMetadataResolver<NoInfer<TRow>>;
	selectable?: boolean;
	class?: string;
	/**
	 * Classes for the table's own root box. When supplied, the table is its own content container:
	 * toolbar, body and pagination share one outline (pair with `borderless` so the grid's inner
	 * border does not double it).
	 */
	rootClass?: string;
	/**
	 * Drops the grid body's own border so a `rootClass` outline is the table's only line.
	 */
	borderless?: boolean;
	title?: string;
	description?: string;
	features?: CollectionTableFeatures;
	exportPipelines?: readonly CollectionTablePipeline<NoInfer<TRow>>[];
	importPipelines?: readonly CollectionTablePipeline<NoInfer<TRow>>[];
	integrations?: readonly CollectionTableIntegrationStatus[];
	rowActions?: readonly Snippet<[CollectionTableRowActionContext<NoInfer<TRow>>]>[];
	emptyPlaceholder?: Snippet;
	/**
	 * Required column composition. Author each visible column explicitly with `<Column name="…" />`;
	 * table UI does not auto-derive columns from schema declaration order.
	 */
	columns: Snippet<[CollectionTableColumnsComposition<NoInfer<TRow>>]>;
	/**
	 * Mobile card override. Omit to auto-derive the card from column `card` roles + field structure
	 * (RFC V.2d) — the single field list then drives both desktop rows and mobile cards.
	 */
	ListCard?: Snippet<[NoInfer<TRow>]>;
}

export type CollectionTableProps<
	TCollections extends CollectionRegistry = CollectionRegistry,
	TName extends CollectionName<TCollections> = CollectionName<TCollections>,
	TRow extends object = CollectionTableRow<TCollections, TName>
> = CollectionTableBaseProps<TCollections, TName, TRow>;
