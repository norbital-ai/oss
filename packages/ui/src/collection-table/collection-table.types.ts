import type {
	CollectionDbClient,
	CollectionField,
	CollectionQuery,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/platform-utils/collection';
import type { Component, Snippet } from 'svelte';

export type CollectionName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export type CollectionTableRow<
	TCollections extends CollectionRegistry,
	TName extends CollectionName<TCollections>
> = CollectionRow<TCollections[TName]>;

export type CollectionTableFieldName<TRow extends object> = Extract<keyof TRow, string>;

/** The card slot a column feeds when the mobile/kanban card is auto-derived (RFC V.2c). */
export type CollectionTableCardRole = 'title' | 'subtitle' | 'badge';

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
	'uuid'
]);

export interface CollectionTableSortability {
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
}

export interface CollectionTableColumnsComposition<TRow extends object> {
	Column: Component<CollectionTableColumnPrimitiveProps<TRow>>;
}

export interface CollectionTableFeatures {
	readonly search?: boolean;
	readonly filter?: boolean;
	readonly bulk?: boolean;
	readonly create?: boolean;
}

export interface CollectionTablePipelineContext<TRow extends object> {
	readonly collectionName: string;
	readonly selectedRows: readonly TRow[];
	refresh(): Promise<void>;
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
	run(context: CollectionTablePipelineContext<TRow>): unknown | Promise<unknown>;
}

export type CollectionTableIntegrationState =
	'connected' | 'configured' | 'degraded' | 'error' | 'disabled';

export interface CollectionTableIntegrationStatus {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly state: CollectionTableIntegrationState;
	readonly statusLabel?: string;
}

interface CollectionTableBaseProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionName<TCollections>,
	TRow extends object
> {
	client: CollectionDbClient<TCollections>;
	collection: TName;
	view?: string;
	query?: CollectionQuery<NoInfer<TRow>>;
	disabled?: boolean;
	selectable?: boolean;
	class?: string;
	title?: string;
	description?: string;
	searchPlaceholder?: string;
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
