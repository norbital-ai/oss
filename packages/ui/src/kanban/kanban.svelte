<script lang="ts">
	/*************************************************************************
	 * Kanban Provider - Main container component                           *
	 *************************************************************************/
	import { fly } from 'svelte/transition';
	import { Inline, Scroll } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { KanbanProps } from '#lib/kanban';
	import KanbanColumn from './kanban-column.svelte';

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
	const { t } = useI18n<UiKeys>();

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
<Scroll axis="x" name={t('kanban.boardRegion')} class="p-3">
	<Inline gap="md" align="stretch" fill>
		{#each value as column, index (column._id)}
			<Inline gap="none" align="stretch" fill>
				<div class="flex h-full" in:slideIn={{ columnId: column._id, index }}>
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
			</Inline>
		{/each}
	</Inline>
</Scroll>
