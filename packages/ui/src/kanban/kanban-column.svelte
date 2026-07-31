<script lang="ts">
	/**
	 * KanbanColumn.svelte
	 * - Virtualized infinite scroll while a lane is still paginating
	 * - Sortable drag-and-drop once a lane is fully loaded
	 */
	import * as Card from '#lib/card';
	import { Cover, Inline, Scroll, Stack } from '#lib/layout';
	import { Skeleton } from '#lib/skeleton';
	import { Sortable } from '#lib/sortable';
	import { createVirtualizer } from '#lib/utils/virtualizer.svelte';
	import type SortablePrimitive from 'sortablejs';
	import { fade } from 'svelte/transition';
	import type {
		KanbanCardMove,
		TCardSnippet,
		TColumnHeaderActionSnippet,
		TColumnTitleSnippet,
		TKanbanColumnData,
		TKanbanItem
	} from './index.js';

	export interface KanbanColumnProps {
		column: TKanbanColumnData;
		cardSnippet: TCardSnippet;
		onCardMove?: (move: KanbanCardMove) => void;
		onLoadMore: (columnId: string, lastVirtualIndex: number) => Promise<void>;
		itemHeight: number;
		minColumnWidth: number;
		groupName: string;
		sortable: boolean;
		sortWithinColumn: boolean;
		dragHandleClass?: string;
		columnHeaderActionSnippet?: TColumnHeaderActionSnippet;
		columnTitleSnippet?: TColumnTitleSnippet;
	}

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

	const OVERSCAN = 5;
	const LOAD_THRESHOLD = 5;
	const ITEM_GAP = 8;
	/** Fully loaded columns still virtualize above this count to avoid mounting hundreds of cards. */
	const VIRTUALIZE_WHEN_LOADED_MIN_ITEMS = 8;

	let containerRef: HTMLDivElement | null = $state(null);
	let sortableColumn: HTMLElement | null = $state(null);
	const sortableIds = $derived(column.items.map((it) => it._id));
	const rowSize = $derived(itemHeight + ITEM_GAP);
	/** Sortable once a lane has fully loaded — not while paginating (avoids DOM duplicates). */
	const laneFullyLoaded = $derived(
		(!column.hasMore && !(column.isFetchingNextPage ?? false)) ||
			(column.totalCount !== undefined && column.items.length >= column.totalCount)
	);
	const canSort = $derived(sortable && laneFullyLoaded);
	/** Prefer the sortable DOM path over virtualization whenever drag-and-drop is active. */
	const useVirtualizer = $derived(
		!canSort &&
			(column.hasMore ||
				(column.isLoading === true && column.items.length === 0) ||
				column.items.length >= VIRTUALIZE_WHEN_LOADED_MIN_ITEMS)
	);

	const stableCount = $derived(column.totalCount ?? column.items.length);
	const virtualRowCount = $derived(stableCount);
	const loadedCount = $derived(column.items.length);

	const getItemKey = (index: number) => column.items[index]?._id ?? `skel:${column._id}:${index}`;

	const virtualizer = createVirtualizer({
		count: () => virtualRowCount,
		scrollElement: () => containerRef,
		estimateSize: () => rowSize,
		overscan: OVERSCAN,
		indexAttribute: 'data-index',
		getItemKey,
		onChange: (inst) => {
			const v = inst.virtualItems;
			if (!v.length) return;
			const last = v[v.length - 1]!;
			if (
				column.hasMore &&
				!column.isLoading &&
				!column.isFetchingNextPage &&
				last.index >= loadedCount - LOAD_THRESHOLD
			) {
				void onLoadMore(column._id, last.index);
			}
		}
	});

	const virtualRows = $derived(virtualizer.virtualItems);
	const totalSize = $derived(virtualizer.totalSize);

	const [paddingTop, paddingBottom] = $derived.by((): [number, number] => {
		if (!virtualRows.length) return [0, 0];
		const first = virtualRows[0]!;
		const last = virtualRows[virtualRows.length - 1]!;
		return [Math.max(0, first.start), Math.max(0, totalSize - last.end)];
	});

	type SEvent = SortablePrimitive.SortableEvent;

	function emitCardMove(evt: SEvent): void {
		const recordId = evt.item.getAttribute('data-sortable-id');
		const fromColumnId = evt.from?.getAttribute('data-column-id');
		const toColumnId = evt.to?.getAttribute('data-column-id');
		if (!recordId || !fromColumnId || !toColumnId) return;
		onCardMove?.({
			recordId,
			fromColumnId,
			toColumnId,
			toIndex: evt.newIndex ?? undefined
		});
	}

	function handleSortIds(_orderedIds: string[], evt: SEvent): void {
		if (onCardMove) {
			emitCardMove(evt);
		}
	}
</script>

<div
	class="min-w-0 flex-1 shrink-0"
	style="min-width: {minColumnWidth}px; width: {minColumnWidth}px;"
>
	<Cover as="div" gap="sm" top={columnHeader}>
		<Scroll
			axis="y"
			name={`${column.title} column`}
			bind:ref={containerRef}
			class="rounded-md px-0.5"
		>
			{#if column.isLoading && column.items.length === 0}
				<div class="w-full" transition:fade={{ duration: 150 }}>
					<Stack gap="sm">
						{#each Array.from({ length: 4 }) as _, index (index)}
							{@render CardSkeleton()}
						{/each}
					</Stack>
				</div>
			{:else if column.items.length === 0}
				<Stack gap="none" class="h-full items-center justify-center p-4 text-muted-foreground">
					<p>No items in this column</p>
				</Stack>
			{:else if canSort}
				<Sortable.Root
					items={sortableIds}
					sortableGroup={groupName}
					handle={dragHandleClass}
					sort={sortWithinColumn}
					onSort={handleSortIds}
					element={sortableColumn}
				>
					{#snippet child({ draggedItemId })}
						<div
							bind:this={sortableColumn}
							data-column-id={column._id}
							class="norbital-kanban-column flex flex-col"
							style="gap: {ITEM_GAP}px;"
						>
							{#each column.items as item (item._id)}
								<Sortable.Item id={item._id} isDragging={draggedItemId === item._id}>
									{#snippet child({ props })}
										<div {...props} class="relative box-border w-full {props.class}">
											{@render KanbanCard({ card: item, columnId: column._id, cardSnippet })}
										</div>
									{/snippet}
								</Sortable.Item>
							{/each}
						</div>
					{/snippet}
				</Sortable.Root>
			{:else}
				<div
					role="list"
					class="relative w-full [overflow-anchor:none]"
					style="height: {totalSize}px"
				>
					<div
						data-column-id={column._id}
						class="norbital-kanban-column"
						style="position: absolute; inset: 0; transform: translateY({paddingTop}px);"
					>
						{#each virtualRows as row (row.key)}
							{@const item = column.items[row.index]}
							{#if item}
								<div
									data-index={row.index}
									class="relative box-border w-full"
									style="height: {rowSize}px; padding-bottom: {ITEM_GAP}px;"
								>
									<div class="relative h-full w-full">
										{@render KanbanCard({ card: item, columnId: column._id, cardSnippet })}
									</div>
								</div>
							{:else}
								<div
									data-index={row.index}
									class="relative box-border flex w-full items-center justify-center"
									style="height: {rowSize}px; padding-bottom: {ITEM_GAP}px;"
								>
									{@render loadMoreIndicator({
										loading: (column.isLoading ?? false) || (column.isFetchingNextPage ?? false)
									})}
								</div>
							{/if}
						{/each}
						{#if paddingBottom > 0}
							<div style="height: {paddingBottom}px;"></div>
						{/if}
					</div>
				</div>
			{/if}
		</Scroll>
	</Cover>
</div>

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
		{#if column.totalCount !== undefined}
			<span class="text-xs text-muted-foreground tabular-nums">{column.totalCount}</span>
		{:else if column.items.length > 0}
			<span class="text-xs text-muted-foreground tabular-nums">{column.items.length}</span>
		{/if}
		{#if columnHeaderActionSnippet}
			<div class="ml-auto">
				{@render columnHeaderActionSnippet({ columnId: column._id })}
			</div>
		{/if}
	</Inline>
{/snippet}

{#snippet KanbanCard({
	card,
	columnId,
	cardSnippet
}: {
	card: TKanbanItem;
	columnId: string;
	cardSnippet: TCardSnippet;
})}
	{@render cardSnippet({ ...card, columnId })}
{/snippet}

{#snippet CardSkeleton()}
	<Card.Root class="rounded-md" style="height: {itemHeight}px;">
		<Card.Content class="h-full animate-pulse p-3">
			<Stack gap="sm" class="h-full">
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

{#snippet loadMoreIndicator({ loading }: { loading: boolean })}
	<div class="flex items-center justify-center py-2 text-xs text-muted-foreground">
		{#if loading}
			<span class="animate-pulse">Loading…</span>
		{:else}
			<span>Scroll for more</span>
		{/if}
	</div>
{/snippet}
