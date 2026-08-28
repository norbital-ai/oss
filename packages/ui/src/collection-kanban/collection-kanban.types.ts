import type {
	CollectionDbClient,
	CollectionField,
	CollectionQuery,
	CollectionRelationOptions,
	CollectionRegistry,
	CollectionRow,
	SystemCollectionFieldName
} from '@norbital-ai/std/collection';
import type {
	Component,
	ComponentConstructorOptions,
	ComponentInternals,
	Snippet,
	SvelteComponent
} from 'svelte';
import type { Effect } from 'effect';
import type { CollectionRecordMetadataResolver } from '#lib/collection-record-metadata';
import type { AuthoredLaneInput } from './collection-kanban-lanes.js';
import type { CollectionIntegrationStatus, CollectionPipeline } from '#lib/collection-surface';
import type {
	FieldRendererCallerProps,
	FieldRendererProps,
	FieldRendererPropsOf
} from '#lib/data-renderer';

export type CollectionKanbanName<TCollections extends CollectionRegistry> = Extract<
	keyof TCollections,
	string
>;

export interface CollectionKanbanMove<Row> {
	record: Row;
	fromLane: string;
	toLane: string;
}

type CollectionKanbanFieldName<TRow extends object> = Exclude<
	Extract<keyof TRow, string>,
	SystemCollectionFieldName
>;

export type CollectionKanbanCardRole = 'title' | 'subtitle' | 'badge';

export interface CollectionKanbanField<
	TRow extends object,
	TRenderer extends Component<never> = Component<FieldRendererProps>
> {
	key: CollectionKanbanFieldName<TRow>;
	/** Optional explicit placement; undeclared roles are filled from declared field order. */
	card?: CollectionKanbanCardRole;
	/** Explicit datatype renderer override. Omit for automatic relationship/datatype routing. */
	renderer?: TRenderer;
	rendererProps?: FieldRendererCallerProps<FieldRendererPropsOf<TRenderer>>;
	relationOptions?: CollectionRelationOptions;
}

export type CollectionKanbanFieldPrimitiveProps<
	TRow extends object,
	TRenderer extends Component<never> = Component<FieldRendererProps>
> = Omit<CollectionKanbanField<TRow, TRenderer>, 'key'> & {
	name: CollectionKanbanFieldName<TRow>;
};

export interface CollectionKanbanFieldComponent<TRow extends object> {
	new <TRenderer extends Component<never> = Component<FieldRendererProps>>(
		options: ComponentConstructorOptions<CollectionKanbanFieldPrimitiveProps<TRow, TRenderer>>
	): SvelteComponent<CollectionKanbanFieldPrimitiveProps<TRow, TRenderer>>;
	<TRenderer extends Component<never> = Component<FieldRendererProps>>(
		this: void,
		internals: ComponentInternals,
		props: CollectionKanbanFieldPrimitiveProps<TRow, TRenderer>
	): ReturnType<Component<CollectionKanbanFieldPrimitiveProps<TRow, TRenderer>>>;
	element?: typeof HTMLElement;
	z_$$bindings?: string;
}

export interface CollectionKanbanFieldsComposition<TRow extends object> {
	Field: CollectionKanbanFieldComponent<TRow>;
}

export interface CollectionKanbanProps<
	TCollections extends CollectionRegistry,
	TName extends CollectionKanbanName<TCollections>
> {
	client: CollectionDbClient<TCollections, TName>;
	collection: TName;
	view?: string;
	groupBy: CollectionKanbanFieldName<CollectionRow<TCollections[TName]>>;
	/** Lane subset pick/order with optional labels/colours. Omit to derive from the groupBy field (RFC V.3). */
	lanes?: readonly AuthoredLaneInput[];
	/** Number of visual lane rows. Defaults to one horizontal row. */
	rows?: number;
	query?: CollectionQuery<CollectionRow<TCollections[TName]>>;
	recordMetadata?: CollectionRecordMetadataResolver<CollectionRow<TCollections[TName]>>;
	selectable?: boolean;
	title?: string;
	description?: string;
	exportPipelines?: readonly CollectionPipeline<CollectionRow<TCollections[TName]>>[];
	importPipelines?: readonly CollectionPipeline<CollectionRow<TCollections[TName]>>[];
	integrations?: readonly CollectionIntegrationStatus[];
	/**
	 * Required card field declaration. The framework never enumerates schema fields into cards;
	 * omitted fields are omitted and omitted renderers use the automatic datatype strategy.
	 */
	fields: Snippet<[CollectionKanbanFieldsComposition<CollectionRow<TCollections[TName]>>]>;
	/** Whole-card layout override. Declared `fields` remain the canonical automatic-card contract. */
	Card?: Snippet<[CollectionRow<TCollections[TName]>]>;
	/**
	 * Move handler. Omit for the default optimistic move that writes `toLane` into the groupBy
	 * field with rollback on failure (RFC V.3c).
	 */
	onCardMove?: (
		move: CollectionKanbanMove<CollectionRow<TCollections[TName]>>
	) => Effect.Effect<void, unknown>;
	class?: string;
}
