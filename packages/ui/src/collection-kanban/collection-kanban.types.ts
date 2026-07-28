import type {
	CollectionDbClient,
	CollectionFieldName,
	CollectionQuery,
	CollectionRegistry,
	CollectionRow
} from '@norbital-ai/platform-utils/collection';
import type { Snippet } from 'svelte';
import type { AuthoredLaneInput } from '../collection-table/collection-card-derivation.js';
import type {
	CollectionTableIntegrationStatus,
	CollectionTablePipeline
} from '../collection-table/collection-table.types.js';

export type CollectionKanbanName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export interface CollectionKanbanMove<Row> {
	record: Row;
	fromLane: string;
	toLane: string;
}

export interface CollectionKanbanProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionKanbanName<TCollections>
> {
	client: CollectionDbClient<TCollections>;
	collection: TName;
	view?: string;
	groupBy: CollectionFieldName<TCollections[TName]>;
	/** Lane subset pick/order with optional labels/colours. Omit to derive from the groupBy field (RFC V.3). */
	lanes?: readonly AuthoredLaneInput[];
	/** Number of visual lane rows. Defaults to one horizontal row. */
	rows?: number;
	query?: CollectionQuery<CollectionRow<TCollections[TName]>>;
	selectable?: boolean;
	exportPipelines?: readonly CollectionTablePipeline<CollectionRow<TCollections[TName]>>[];
	importPipelines?: readonly CollectionTablePipeline<CollectionRow<TCollections[TName]>>[];
	integrations?: readonly CollectionTableIntegrationStatus[];
	/** Card override. Omit to auto-derive the card from field structure (RFC V.3). */
	Card?: Snippet<[CollectionRow<TCollections[TName]>]>;
	/**
	 * Move handler. Omit for the default optimistic move that writes `toLane` into the groupBy
	 * field with rollback on failure (RFC V.3c).
	 */
	onCardMove?: (move: CollectionKanbanMove<CollectionRow<TCollections[TName]>>) => Promise<void>;
	class?: string;
}
