<script lang="ts">
	/*************************************************************************
	 * Kanban Provider - Main container component                           *
	 *************************************************************************/
	import { fly } from 'svelte/transition';
	import type {
		KanbanCardMove,
		TCardSnippet,
		TColumnHeaderActionSnippet,
		TColumnTitleSnippet,
		TKanbanColumnData
	} from './index.js';
	import KanbanColumn from './kanban-column.svelte';

	/* --------------------------------------------------------------------- *
	 * Props                                                                  *
	 * --------------------------------------------------------------------- */
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

	let {
		value,
		cardSnippet,
		onCardMove,
		onLoadMore,
		itemHeight,
		minColumnWidth = 320,
		groupName = 'kanban-shared',
		sortable = true,
		sortWithinColumn = true,
		dragHandleClass,
		columnHeaderActionSnippet,
		columnTitleSnippet
	}: KanbanProps = $props();

	/* --------------------------------------------------------------------- *
	 * Local state                                                            *
	 * --------------------------------------------------------------------- */
	let localState = $derived(value);

	// Track which columns have been animated to prevent re-animation
	let animatedColumns: Set<string> = $state(new Set());

	/* --------------------------------------------------------------------- *
	 * Svelte transition for columns (only animates once per column)         *
	 * --------------------------------------------------------------------- */
	function slideIn(node: HTMLElement, { columnId, index }: { columnId: string; index: number }) {
		if (animatedColumns.has(columnId)) {
			return { duration: 0 };
		}

		animatedColumns.add(columnId);

		// Slide from left (x: -20) with staggered delay
		return fly(node, { x: -20, duration: 400, delay: index * 100 });
	}
</script>

<!-- Board-wide horizontal scroll with full height ----------------------->
<div class="flex h-full gap-3 overflow-x-auto overflow-y-hidden p-3">
	{#each localState as column, index (column._id)}
		<div class="flex h-full min-h-0" in:slideIn={{ columnId: column._id, index }}>
			<KanbanColumn
				{column}
				{cardSnippet}
				{onCardMove}
				{onLoadMore}
				{itemHeight}
				{minColumnWidth}
				{groupName}
				{sortable}
				{sortWithinColumn}
				{dragHandleClass}
				{columnHeaderActionSnippet}
				{columnTitleSnippet}
			/>
		</div>
	{/each}
</div>
