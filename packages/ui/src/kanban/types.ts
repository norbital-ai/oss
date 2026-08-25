import { Effect, Schema } from 'effect';
import type { Snippet } from 'svelte';

// Core interfaces
export const TKanbanItemSchema = Schema.Struct({
	_id: Schema.String,
	type: Schema.Literals(['card', 'column'])
});
export type TKanbanItem = typeof TKanbanItemSchema.Type;

export const TKanbanColumnDataSchema = Schema.Struct({
	_id: Schema.String,
	title: Schema.String,
	items: Schema.Array(TKanbanItemSchema),
	totalCount: Schema.Number,
	hasMore: Schema.optional(Schema.Boolean),
	isLoading: Schema.optional(Schema.Boolean),
	isFetchingNextPage: Schema.optional(Schema.Boolean)
});
export type TKanbanColumnData = typeof TKanbanColumnDataSchema.Type;

// Card-specific interface
export type TKanbanCardData = TKanbanItem & {
	type: 'card';
	title: string;
	description?: string;
};

// Snippet type for card rendering
export type TCardSnippet = Snippet<[TKanbanItem & { columnId: string }]>;

// Snippet type for column header actions (e.g. create-task button)
export type TColumnHeaderActionSnippet = Snippet<[{ columnId: string }]>;

// Snippet type for custom column title rendering
export type TColumnTitleSnippet = Snippet<
	[{ columnId: string; title: string; column: TKanbanColumnData }]
>;

export const KanbanCardMoveSchema = Schema.Struct({
	recordId: Schema.String,
	fromColumnId: Schema.String,
	toColumnId: Schema.String,
	/** Target index in the destination column (from Sortable `newIndex`). */
	toIndex: Schema.optional(Schema.Number)
});
export type KanbanCardMove = typeof KanbanCardMoveSchema.Type;

// Main component props interface
export interface KanbanProps {
	value: TKanbanColumnData[];
	onCardMove?: (move: KanbanCardMove) => void;
	cardSnippet: TCardSnippet;
	onLoadMore: (columnId: string, lastVirtualIndex: number) => Effect.Effect<void, unknown>;
	itemHeight: number;
	minColumnWidth?: number;
	groupName?: string;
	sortable?: boolean;
	sortWithinColumn?: boolean;
	dragHandleClass?: string;
	columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
	columnTitleSnippet?: TColumnTitleSnippet;
}

export interface KanbanColumnProps {
	column: TKanbanColumnData;
	cardSnippet: TCardSnippet;
	onCardMove?: (move: KanbanCardMove) => void;
	onLoadMore: (columnId: string, lastVirtualIndex: number) => Effect.Effect<void, unknown>;
	itemHeight: number;
	minColumnWidth: number;
	groupName: string;
	sortable: boolean;
	sortWithinColumn: boolean;
	dragHandleClass?: string;
	columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
	columnTitleSnippet?: TColumnTitleSnippet;
}
