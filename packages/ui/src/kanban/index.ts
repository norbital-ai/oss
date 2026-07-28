import type { Snippet } from 'svelte';

// Core interfaces
export interface TKanbanItem {
	_id: string;
	type: 'card' | 'column';
}

export interface TKanbanColumnData {
	_id: string;
	title: string;
	items: TKanbanItem[];
	totalCount: number;
	hasMore?: boolean;
	isLoading?: boolean;
	isFetchingNextPage?: boolean;
}

// Card-specific interface
export interface TKanbanCardData extends TKanbanItem {
	type: 'card';
	title: string;
	description?: string;
}

// Snippet type for card rendering
export type TCardSnippet = Snippet<[TKanbanItem & { columnId: string }]>;

// Snippet type for column header actions (e.g. create-task button)
export type TColumnHeaderActionSnippet = Snippet<[{ columnId: string }]>;

// Snippet type for custom column title rendering
export type TColumnTitleSnippet = Snippet<
	[{ columnId: string; title: string; column: TKanbanColumnData }]
>;

export type KanbanCardMove = {
	recordId: string;
	fromColumnId: string;
	toColumnId: string;
	/** Target index in the destination column (from Sortable `newIndex`). */
	toIndex?: number;
};

// Main component props interface
export interface KanbanProps {
	value: TKanbanColumnData[];
	onCardMove?: (move: KanbanCardMove) => void;
	cardSnippet: TCardSnippet;
	onLoadMore: (columnId: string, lastVirtualIndex: number) => Promise<void>;
	itemHeight: number;
	minColumnWidth?: number;
	groupName?: string;
	sortable?: boolean;
	sortWithinColumn?: boolean;
	dragHandleClass?: string;
	columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
	columnTitleSnippet?: TColumnTitleSnippet;
}

// Component imports - adjust paths to match your actual file names
import KanbanColumnComponent from './kanban-column.svelte';
import KanbanProviderComponent from './kanban.svelte';

// Named exports
export { KanbanColumnComponent as Column, KanbanProviderComponent as Provider };

// Default export with explicit type (fixes TypeScript portability warning)
const Kanban = {
	Column: KanbanColumnComponent,
	Provider: KanbanProviderComponent
} as const;

export default Kanban;
