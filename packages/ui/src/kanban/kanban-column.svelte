<script lang="ts">
	/** One lane: always virtualized, sortable once fully loaded, paginates near its end. */
	import * as Card from '#lib/card';
	import { Cover, Inline, Scroll, Stack } from '#lib/layout';
	import { Skeleton } from '#lib/skeleton';
	import { Sortable } from '#lib/sortable';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { VirtualList } from '#lib/virtual-list';
	import { cn } from '#lib/utils';
	import type SortablePrimitive from 'sortablejs';
	import type { KanbanColumnProps } from './types.js';
	import { Effect } from 'effect';

	let {
		column,
		cardSnippet,
		onCardMove,
		onLoadMore,
		itemHeight,
		minColumnWidth,
		groupName,
		sortable,
		sortWithinColumn,
		dragHandleClass,
		columnHeaderActionSnippet,
		columnTitleSnippet
	}: KanbanColumnProps = $props();

	const LOAD_THRESHOLD = 5;
	const ITEM_GAP = 8;
	const { t } = useI18n<UiKeys>();

	let listElement: HTMLElement | null = $state(null);
	const columnId = $derived(column._id);
	const loading = $derived((column.isLoading ?? false) || (column.isFetchingNextPage ?? false));
	/** Sortable once a lane has fully loaded — a paginating lane would reorder a partial list. */
	const canSort = $derived(
		sortable && ((!column.hasMore && !loading) || column.items.length >= column.totalCount)
	);

	function loadMoreNear(lastIndex: number): void {
		if (column.hasMore && !loading && lastIndex >= column.items.length - LOAD_THRESHOLD) {
			Effect.runFork(onLoadMore(columnId, lastIndex));
		}
	}

	/** Sortable's `newIndex` counts mounted items; the first mounted `data-index` makes it absolute. */
	function absoluteIndex(list: HTMLElement, newIndex: number | undefined): number | undefined {
		if (newIndex === undefined) return undefined;
		const indices = [...list.children].map((child) => Number((child as HTMLElement).dataset.index));
		const first = Math.min(...indices.filter(Number.isFinite));
		return Number.isFinite(first) ? first + newIndex : newIndex;
	}

	function handleSort(_orderedIds: string[], evt: SortablePrimitive.SortableEvent): void {
		const recordId = evt.item.getAttribute('data-sortable-id');
		const fromColumnId = evt.from?.getAttribute('data-column-id');
		const toColumnId = evt.to?.getAttribute('data-column-id');
		if (!recordId || !fromColumnId || !toColumnId) return;
		onCardMove?.({
			recordId,
			fromColumnId,
			toColumnId,
			toIndex: absoluteIndex(evt.to, evt.newIndex)
		});
	}
</script>

<Cover as="div" gap="sm" top={columnHeader} class="shrink-0" style="width: {minColumnWidth}px;">
	<Scroll axis="y" name={t('kanban.columnRegion', { column: column.title })} class="px-0.5">
		{#if column.isLoading && column.items.length === 0}
			<Stack gap="sm">
				{#each Array.from({ length: 4 }) as _, index (index)}
					{@render CardSkeleton()}
				{/each}
			</Stack>
		{:else if column.items.length === 0}
			<p class="p-4 text-center text-muted-foreground">{t('kanban.emptyLane')}</p>
		{:else}
			<Sortable.Root
				items={column.items.map((item) => item._id)}
				sortableGroup={groupName}
				handle={dragHandleClass}
				sort={sortWithinColumn}
				disabled={!canSort}
				onSort={handleSort}
				element={listElement}
			>
				{#snippet child({ draggedItemId })}
					<VirtualList
						items={column.items}
						key={(item) => item._id}
						estimateSize={itemHeight}
						gap={ITEM_GAP}
						role="list"
						data-column-id={columnId}
						class="norbital-kanban-column"
						bind:ref={listElement}
						onRange={loadMoreNear}
						itemProps={(item) => ({
							'data-sortable-id': item._id,
							class: cn('sortable-item', draggedItemId === item._id && 'sortable-dragging')
						})}
					>
						{#snippet item(card)}
							{@render cardSnippet({ ...card, columnId })}
						{/snippet}
					</VirtualList>
				{/snippet}
			</Sortable.Root>
			{#if column.hasMore}
				<p class="py-2 text-center text-meta" class:animate-pulse={loading}>
					{loading ? t('common.loading') : t('kanban.scrollForMore')}
				</p>
			{/if}
		{/if}
	</Scroll>
</Cover>

{#snippet columnHeader()}
	<Inline gap="xs" class="px-1">
		{#if columnTitleSnippet}
			<div class="min-w-0">
				{@render columnTitleSnippet({
					columnId: column._id,
					title: column.title,
					column
				})}
			</div>
		{:else}
			<h2 class="text-sm font-semibold">{column.title}</h2>
		{/if}
		<span class="text-meta tabular-nums">{column.totalCount}</span>
		{#if columnHeaderActionSnippet}
			<div class="ml-auto">
				{@render columnHeaderActionSnippet({ columnId })}
			</div>
		{/if}
	</Inline>
{/snippet}

{#snippet CardSkeleton()}
	<Card.Root class="rounded-md" style="height: {itemHeight}px;">
		<Card.Content class="h-full animate-pulse p-3">
			<Stack gap="sm" fill>
				<Skeleton class="h-4 w-3/4 rounded" />
				<Skeleton class="h-3 w-full rounded" />
				<Skeleton class="h-3 w-2/3 rounded" />
				<div class="flex-1"></div>
				<Inline gap="sm">
					<Skeleton class="h-5 w-12 rounded" />
					<Skeleton class="h-5 w-16 rounded" />
				</Inline>
			</Stack>
		</Card.Content>
	</Card.Root>
{/snippet}
