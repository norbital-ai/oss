<script lang="ts" generics="TData extends Record<string, unknown>, TCondition = unknown">
	import Icon from '@iconify/svelte';
	import * as Alert from '#lib/alert';
	import { Button } from '#lib/button';
	import { Input } from '#lib/input';
	import { Cluster, Cover, Inline, Scroll, Stack } from '#lib/layout';
	import { Separator } from '#lib/separator';
	import { Skeleton } from '#lib/skeleton';
	import { Sortable } from '#lib/sortable';
	import { Tooltip } from '#lib/tooltip';
	import { cn, RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
	import { createVirtualizer } from '#lib/utils/virtualizer.svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { debounce } from 'es-toolkit/function';
	import { watch } from 'runed';
	import { onMount, tick, type Snippet } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import CollectionTableColumnActions from './component/columns/collection-table-column-actions.svelte';
	import { ColumnAPI, RowAPI, TableAPI } from './collection-table-state.svelte';

	const { t } = useI18n<UiKeys>();

	// ----------------------------------------------------------------------------------
	// Types
	// ----------------------------------------------------------------------------------

	type ColCssVar = `--table-col-${string}-width`;

	type ColumnLayout<T extends Record<string, unknown>, TConditionValue = unknown> = {
		id: string;
		width: number;
		isPinned: boolean;
		isCheckbox: boolean;
		leftOffset: number; // offset within pinned or scroll stream
		index: number; // index among *visible* columns
		instance: ColumnAPI<T, TConditionValue>;
		cssVar: ColCssVar;
		canResize: boolean;
	};

	// Type aliases for snippet generics (formatter bug workaround)
	type TColumnLayout = ColumnLayout<TData, TCondition>;
	type TSortableProps = Record<string, unknown>;
	const HEADER_SCROLL_LEFT_VAR = '--collection-table-header-scroll-left';
	const BODY_SCROLL_LEFT_VAR = '--collection-table-body-scroll-left';
	const BODY_VIEWPORT_WIDTH_VAR = '--collection-table-body-viewport-width';
	const PINNED_LAYER_BORDER_CLASS = 'shadow-[inset_-1px_0_0_0_hsl(var(--border))]';

	interface Props {
		table: TableAPI<TData, TCondition>;
		disabled?: boolean;
		class?: string;

		isLoading?: boolean;
		error?: string;

		enableRowExpansion?: boolean;
		enableRowReordering?: boolean;
		enableColumnReordering?: boolean;
		enableSorting?: boolean;
		enableSelection?: boolean;

		hidePaginationWhenSinglePage?: boolean;
		hasNextPage?: boolean;
		onPreviousPage?: () => void;
		onNextPage?: () => void;
		borderless?: boolean;
		defaultExpanded?: boolean;

		leftActions?: Snippet<[{ table: TableAPI<TData, TCondition> }]>[];
		rightActions?: Snippet<[{ table: TableAPI<TData, TCondition> }]>[];
		rowActions?: Snippet<
			[{ row: RowAPI<TData, TCondition>; table: TableAPI<TData, TCondition>; hovered: boolean }]
		>[];
		stickyRowActions?: boolean;
		bottomRightActions?: Snippet<[{ table: TableAPI<TData, TCondition> }]>[];
		subComponent?: Snippet<
			[{ row: RowAPI<TData, TCondition>; table: TableAPI<TData, TCondition> }]
		>;
		emptyPlaceholder?: Snippet;

		onRowReorder?: (reorderedData: TData[]) => void;
		onColumnReorder?: (reorderedColumnIds: string[]) => void;
		onRowActivate?: (row: TData) => void;

		getRowHasChildren?: (row: TData) => boolean;

		getRowLeadingAccent?: (row: TData) => { borderClass: string; tooltip: string } | null;

		/** Record id currently open in the detail stack; drives the row active indicator. */
		activeRecordId?: string | null;
		/**
		 * When false, size to row content and scroll on the inline axis only so a parent
		 * can own vertical scrolling (avoids nested scroll traps in forms/sheets).
		 */
		bounded?: boolean;
	}

	let {
		table,
		disabled = false,
		class: className = '',
		isLoading = false,
		error = '',

		enableRowExpansion = false,
		enableRowReordering = false,
		enableColumnReordering = true,
		enableSorting = true,
		enableSelection = true,
		hidePaginationWhenSinglePage = false,
		hasNextPage = false,
		onPreviousPage,
		onNextPage,
		borderless = false,
		defaultExpanded = false,

		leftActions,
		rightActions,
		rowActions,
		stickyRowActions = false,
		bottomRightActions,
		subComponent,
		emptyPlaceholder,

		onRowReorder,
		onColumnReorder,
		onRowActivate,
		getRowHasChildren,
		getRowLeadingAccent,
		activeRecordId = null,
		bounded = true
	}: Props = $props();

	// ----------------------------------------------------------------------------------
	// Locals / constants
	// ----------------------------------------------------------------------------------

	function sanitizeForCssClass(input: string): string {
		return String(input)
			.replace(/[^a-zA-Z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	function expandedRegionId(rowId: string): string {
		return `collection-row-details-${sanitizeForCssClass(table.viewKey)}-${sanitizeForCssClass(rowId)}`;
	}

	const { rowDragClass, bodySortableClass, headerSortableClass, headerSortableHandlerClass } =
		$derived.by(() => {
			const key = sanitizeForCssClass(table.viewKey);
			return {
				rowDragClass: `row-drag-${key}`,
				bodySortableClass: `body-sortable-${key}`,
				headerSortableClass: `header-sortable-${key}`,
				headerSortableHandlerClass: `header-sortable-handler-${key}`
			};
		});
	let headerSortableElement: HTMLElement | null = $state(null);
	let bodySortableElement: HTMLElement | null = $state(null);

	const ROW_HEIGHT = 48;
	const HEADER_HEIGHT = 48;
	const ROW_OVERSCAN = 4;
	const COL_OVERSCAN = 1;

	let bodyScrollElement: HTMLDivElement | null = $state(null);
	let tableHeaderElement: HTMLDivElement | null = $state(null);
	let hoveredRowId = $state<string | null>(null);
	let pageSizeError = $state(false);

	// ----------------------------------------------------------------------------------
	// Table API (single source of truth)
	// ----------------------------------------------------------------------------------

	const tableApi = $derived(table);

	// ----------------------------------------------------------------------------------
	// Derived helpers for layout/virtualization
	// ----------------------------------------------------------------------------------

	const layouts = $derived(tableApi.columnLayouts as ColumnLayout<TData, TCondition>[]);
	const pinnedLayouts = $derived(layouts.filter((l) => l.isPinned));
	const scrollLayouts = $derived(layouts.filter((l) => !l.isPinned));
	const pinnedWidth = $derived(pinnedLayouts.reduce((a, l) => a + l.width, 0));
	const scrollTotalWidth = $derived(scrollLayouts.reduce((a, l) => a + l.width, 0));
	const totalTableWidth = $derived(pinnedWidth + scrollTotalWidth);

	const sortingEnabled = $derived(enableSorting && !disabled);
	const columnReorderEnabled = $derived(enableColumnReordering && !disabled);

	function getPinnedLayerClass(top = false): string {
		return cn(
			'sticky left-0 z-40 h-full bg-card',
			top && 'top-0',
			!borderless && PINNED_LAYER_BORDER_CLASS
		);
	}

	function handleSort(inst: ColumnAPI<TData, TCondition>) {
		if (!sortingEnabled || !inst.enableSorting) return;
		inst.toggleSort();
		tableApi.setPagination({ pageIndex: 0, pageSize: tableApi.pagination.current.pageSize });
	}

	function activateRow(event: MouseEvent | KeyboardEvent, row: TData): void {
		if (!onRowActivate || event.defaultPrevented) return;
		if (
			event.target instanceof Element &&
			event.target.closest('button, a, input, select, textarea')
		) {
			return;
		}
		if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
		if (event instanceof KeyboardEvent) event.preventDefault();
		onRowActivate(row);
		// Drop keyboard focus so Button/row focus rings don't linger as a cut-off brand border.
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	}

	function handleColumnReorder(reorderedIds: string[]) {
		const scrollableIds = scrollLayouts.map((l) => l.id);
		const next = reorderedIds.filter((id) => scrollableIds.includes(id));
		tableApi.columnOrder.current = next;
		onColumnReorder?.(next);
	}

	function isRecordDetailActive(rowId: string): boolean {
		return activeRecordId === rowId;
	}

	function rowSurfaceClass(detailActive: boolean, expanded: boolean): string {
		return cn(
			'relative transition-colors',
			!borderless && 'border-b',
			detailActive && 'bg-accent/50',
			!detailActive && expanded && 'bg-muted/50',
			!detailActive && !expanded && 'hover:bg-muted/50'
		);
	}

	function handleHeaderWheel(event: WheelEvent) {
		if (!bodyScrollElement) return;
		if (event.deltaX === 0 && event.deltaY === 0) return;
		// Unbounded grids yield vertical wheel to the parent scrollport.
		if (!bounded && event.deltaX === 0) return;

		event.preventDefault();
		bodyScrollElement.scrollLeft += event.deltaX;
		if (bounded) bodyScrollElement.scrollTop += event.deltaY;
	}

	function syncHeaderScrollPosition() {
		if (!bodyScrollElement || !tableHeaderElement) return;
		tableHeaderElement.style.setProperty(
			HEADER_SCROLL_LEFT_VAR,
			`${bodyScrollElement.scrollLeft}px`
		);
	}

	/**
	 * Publishes the body scroll container's scrollLeft and clientWidth as CSS
	 * custom properties on `bodyScrollElement` so that descendants (like the
	 * right-pinned row actions) can position themselves at the right edge of
	 * the visible viewport using `transform: translateX(...)` without having to
	 * rely on `position: sticky` (which is unreliable inside the
	 * virtualizer/Sortable container chain).
	 */
	function syncBodyScrollState() {
		if (!bodyScrollElement) return;
		bodyScrollElement.style.setProperty(BODY_SCROLL_LEFT_VAR, `${bodyScrollElement.scrollLeft}px`);
		bodyScrollElement.style.setProperty(
			BODY_VIEWPORT_WIDTH_VAR,
			`${bodyScrollElement.clientWidth}px`
		);
	}

	function syncScrollState() {
		syncHeaderScrollPosition();
		syncBodyScrollState();
	}

	const resizer = $derived.by(() =>
		tableApi.createColumnResizer({
			containerElement: () => bodyScrollElement,
			tableHeaderElement: () => tableHeaderElement,
			onColumnResize: ({ columnId, newSize }) => {
				tableApi.setColumnSize(columnId, newSize);
			},
			getIndexById: (id) => layouts.findIndex((l) => l.id === id)
		})
	);

	onMount(() => {
		if (defaultExpanded && tableApi.rowInstances.length > 0) {
			for (const r of tableApi.rowInstances) {
				const hasChildren = getRowHasChildren?.(r.raw) ?? Boolean(subComponent);
				if (hasChildren) tableApi.toggleRowExpanded(r.id);
			}
		}

		tick().then(() => {
			syncScrollState();
		});

		const resizeObserver =
			typeof ResizeObserver !== 'undefined'
				? new ResizeObserver(() => syncBodyScrollState())
				: null;
		if (resizeObserver && bodyScrollElement) {
			resizeObserver.observe(bodyScrollElement);
		}

		return () => {
			resizeObserver?.disconnect();
		};
	});

	// --------------------- Virtualization ---------------------
	// Using custom Svelte 5 virtualizer - no store workarounds needed
	const rowVirtualizer = createVirtualizer({
		count: () => tableApi.data.length,
		scrollElement: () => bodyScrollElement,
		estimateSize: () => ROW_HEIGHT,
		overscan: ROW_OVERSCAN,
		getItemKey: (i: number) => tableApi.rowIds[i] ?? `idx:${i}`
	});

	function remeasureRows() {
		tick().then(() => {
			rowVirtualizer.measure();
		});
	}

	const virtualRows = $derived(rowVirtualizer.virtualItems);
	const totalVirtualRowSize = $derived(rowVirtualizer.totalSize);

	const colVirtualizer = createVirtualizer({
		count: () => scrollLayouts.length,
		horizontal: true,
		scrollElement: () => bodyScrollElement,
		estimateSize: (i: number) => scrollLayouts[i]?.width ?? 0,
		overscan: COL_OVERSCAN,
		getItemKey: (i: number) => scrollLayouts[i]?.id ?? `idx:${i}`
	});

	const virtualCols = $derived(colVirtualizer.virtualItems);

	// Re-measure columns when layouts change
	watch(
		() => scrollLayouts.map((l) => `${l.id}:${l.width}`).join(','),
		() => {
			colVirtualizer.measure();
		}
	);

	watch(
		() => tableApi.rowIds.join(','),
		() => {
			remeasureRows();
		}
	);

	function measureRow(_expanded: boolean): Attachment {
		return (el) => rowVirtualizer.measureElement(el as HTMLElement);
	}

	// --------------------- Pagination helpers ---------------------
	const pageCount = $derived(
		Math.max(1, Math.ceil(tableApi.totalRows / tableApi.pagination.current.pageSize))
	);

	const debouncedPageSizeChange = debounce((size: number) => {
		tableApi.setPagination({ pageIndex: 0, pageSize: Math.max(1, Math.min(500, size)) });
	}, 300);

	function handlePageSizeInput(event: Event) {
		if (disabled) return;
		const input = event.currentTarget as HTMLInputElement;
		if (input.value === '') {
			pageSizeError = false;
			return debouncedPageSizeChange.cancel();
		}
		const value = parseInt(input.value, 10);
		if (!Number.isNaN(value) && value >= 1 && value <= 500) {
			pageSizeError = false;
			debouncedPageSizeChange(value);
		} else {
			pageSizeError = true;
			debouncedPageSizeChange.cancel();
		}
	}

	function formatNumber(num: number): string {
		if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
		if (num >= 1_000) return (num / 1_000).toFixed(num >= 10_000 ? 0 : 1) + 'K';
		return num.toLocaleString();
	}

	const selectedCount = $derived(
		Object.values(tableApi.rowSelection.current).filter(Boolean).length
	);
</script>

{#snippet actionsRow()}
	<Cluster
		gap="sm"
		align="center"
		justify={leftActions ? 'between' : 'end'}
		data-collection-grid-toolbar
	>
		{#if leftActions}
			<Scroll axis="x" name={t('table.toolbarRegion')} grow class="min-w-0">
				<Inline gap="sm" fill class="min-w-0">
					{#each leftActions as action}
						{@render action({ table: tableApi })}
					{/each}
				</Inline>
			</Scroll>
		{/if}
		{#if rightActions}
			<Inline gap="xs" shrink={false}>
				{#each rightActions as action}
					{@render action({ table: tableApi })}
				{/each}
			</Inline>
		{/if}
	</Cluster>
{/snippet}

<Cover
	as="div"
	gap={leftActions || rightActions ? 'sm' : 'none'}
	class={className}
	style={bounded ? undefined : 'height: auto; max-height: none;'}
	role="grid"
	aria-rowcount={tableApi.totalRows}
	aria-colcount={layouts.length}
	aria-busy={isLoading}
	top={leftActions || rightActions ? actionsRow : undefined}
	bottom={pagination}
>
	<Cover
		as="div"
		gap="none"
		class={cn('relative rounded-md bg-card', !borderless && 'border')}
		style={bounded ? undefined : 'height: auto; max-height: none;'}
		top={renderTableHeader}
	>
		<Scroll
			axis={bounded ? 'both' : 'x'}
			name={t('table.rowsRegion')}
			bind:ref={bodyScrollElement}
			class="relative"
			style={bounded ? undefined : 'height: auto; max-height: none;'}
			data-collection-grid-scroll-owner
			onscroll={syncScrollState}
		>
			{@render renderTableBody()}
		</Scroll>
	</Cover>
</Cover>

{#snippet pagination()}
	{@const pageCountLocal = pageCount}
	{@const shouldHide =
		hidePaginationWhenSinglePage && tableApi.pagination.current.pageIndex === 0 && !hasNextPage}
	{@const hasBR = bottomRightActions && bottomRightActions.length > 0}

	{#if !shouldHide}
		<Cluster
			gap="md"
			justify="between"
			align="center"
			shrink={false}
			class="p-1 text-xs text-muted-foreground"
		>
			<Cluster gap="sm">
				{#if enableSelection}
					<span
						class="whitespace-nowrap"
						title={t('common.selectedOfTotal', {
							selected: selectedCount.toLocaleString(),
							total: tableApi.totalRows.toLocaleString()
						})}
					>
						{t('table.selectedFraction', {
							selected: formatNumber(selectedCount),
							total: formatNumber(tableApi.totalRows)
						})}
					</span>
					<Separator orientation="vertical" class="h-4" />
				{/if}
				<Tooltip delayDuration={0} text={disabled ? t('table.pageSizeDisabled') : undefined}>
					{#snippet trigger({ props })}
						<Inline gap="xs" {...props}>
							<Input
								type="number"
								class={cn('h-6 w-14 text-xs', pageSizeError && 'border-red-500')}
								max={500}
								min={1}
								value={tableApi.pagination.current.pageSize}
								oninput={handlePageSizeInput}
								{disabled}
							/>
							<span class="text-xs text-muted-foreground">{t('table.perPage')}</span>
						</Inline>
					{/snippet}
				</Tooltip>
			</Cluster>

			<Inline gap="sm" justify="center">
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="size-8"
					aria-label={t('table.previousPage')}
					disabled={disabled || tableApi.pagination.current.pageIndex === 0}
					onclick={onPreviousPage}
				>
					<Icon icon="lucide:chevron-left" class="size-4" />
				</Button>
				<span class="min-w-20 text-center tabular-nums">
					{t('table.pageOf', {
						page: tableApi.pagination.current.pageIndex + 1,
						pages: pageCountLocal
					})}
				</span>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="size-8"
					aria-label={t('table.nextPage')}
					disabled={disabled || !hasNextPage}
					onclick={onNextPage}
				>
					<Icon icon="lucide:chevron-right" class="size-4" />
				</Button>
			</Inline>

			{#if hasBR}
				<Inline gap="xs" justify="end">
					{#each bottomRightActions as action}
						{@render action({ table: tableApi })}
					{/each}
				</Inline>
			{/if}
		</Cluster>
	{:else if bottomRightActions}
		<Inline gap="xs" justify="end">
			{#each bottomRightActions as action}
				{@render action({ table: tableApi })}
			{/each}
		</Inline>
	{/if}
{/snippet}

{#snippet renderTableHeader()}
	<div
		class="z-40 flex-none border-b bg-muted/80"
		style="height: {HEADER_HEIGHT}px;"
		role="rowgroup"
		onwheel={handleHeaderWheel}
	>
		<div class="relative h-full" bind:this={tableHeaderElement} role="row">
			<!-- Pinned columns -->
			<div class="absolute top-0 left-0 z-50 h-full bg-muted/80" style="width: {pinnedWidth}px;">
				{#each pinnedLayouts as layout (layout.id)}
					{@render renderHeaderCell(layout)}
				{/each}
			</div>

			<!-- Scrollable columns -->
			<!-- stupidity:allow UI5 -- virtualizer column pane clips its own viewport -->
			<div class="absolute top-0 right-0 h-full overflow-hidden" style="left: {pinnedWidth}px;">
				<div
					class="relative h-full"
					style="width: {scrollTotalWidth}px; transform: translateX(calc(-1 * var(--collection-table-header-scroll-left, 0px)));"
				>
					{#if columnReorderEnabled && scrollLayouts.length > 0}
						<Sortable.Root
							direction="horizontal"
							items={scrollLayouts.map((l) => l.id)}
							onSort={handleColumnReorder}
							element={headerSortableElement}
							handle={headerSortableHandlerClass}
						>
							{#snippet child({ sortedItems, draggedItemId })}
								<div
									bind:this={headerSortableElement}
									class={cn('relative h-full w-full', headerSortableClass)}
								>
									{#each sortedItems as id (id)}
										{@const layout = scrollLayouts.find((l) => l.id === id)}
										{#if layout}
											<Sortable.Item id={layout.id} isDragging={draggedItemId === layout.id}>
												{#snippet child({ props })}
													{@render renderHeaderCell(layout, props)}
												{/snippet}
											</Sortable.Item>
										{/if}
									{/each}
								</div>
							{/snippet}
						</Sortable.Root>
					{:else}
						{#each virtualCols as vi (scrollLayouts[vi.index]?.id ?? `idx:${vi.index}`)}
							{@const layout = scrollLayouts[vi.index]}
							{#if layout}
								{@render renderHeaderCell(layout)}
							{/if}
						{/each}
					{/if}
				</div>
			</div>
		</div>
	</div>
{/snippet}

{#snippet renderHeaderCell(layout: TColumnLayout, sortableProps?: TSortableProps)}
	{@const inst = layout.instance}
	{@const isCheckbox = layout.isCheckbox}
	{@const dir = inst.sortDirection}
	{@const isSorted = Boolean(dir)}
	{@const headerContent = inst.header({ table: tableApi })}
	{@const headerLabel =
		typeof headerContent === 'string' || typeof headerContent === 'number'
			? String(headerContent)
			: inst.id}
	{@const ariaSortValue =
		!inst.enableSorting || !sortingEnabled
			? undefined
			: dir === 'asc'
				? 'ascending'
				: dir === 'desc'
					? 'descending'
					: 'none'}

	<Inline
		{...sortableProps || {}}
		gap="none"
		fill
		class={cn('group absolute top-0 bg-muted/80', {
			'border-r': !borderless,
			[String(sortableProps?.class || '')]: true
		})}
		style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
		role="columnheader"
		data-colindex={layout.index + 1}
		aria-colindex={layout.index + 1}
		aria-sort={ariaSortValue}
		aria-label={headerLabel}
	>
		{#if isCheckbox}
			<Inline
				gap="none"
				fill
				grow
				justify="center"
				class="min-w-0 overflow-hidden px-3.5 py-1.5"
			>
				{#if headerContent instanceof RenderComponentConfig}
					{@const { component: Component, props } = headerContent}
					<Component {...props} />
				{:else if headerContent instanceof RenderSnippetConfig}
					{@const { snippet, params } = headerContent}
					{@render snippet(params)}
				{:else}
					{String(headerContent ?? '')}
				{/if}
			</Inline>
		{:else}
			<!-- stupidity:allow UI10 -- a virtualized header cell clips its label inside an explicitly sized column -->
			<Inline
				gap="none"
				grow
				fill
				class={cn(
					'min-w-0 overflow-hidden px-3 text-left text-[13px] font-medium',
					headerSortableHandlerClass,
					{
						'cursor-grab': columnReorderEnabled,
						'cursor-default': !columnReorderEnabled || disabled
					}
				)}
			>
				{#if headerContent instanceof RenderComponentConfig}
					{@const { component: Component, props } = headerContent}
					<Component {...props} />
				{:else if headerContent instanceof RenderSnippetConfig}
					{@const { snippet, params } = headerContent}
					{@render snippet(params)}
				{:else}
					<span class="min-w-0 truncate whitespace-nowrap" title={headerLabel}>
						{headerLabel}
					</span>
				{/if}
			</Inline>

			<Inline gap="none" class="absolute inset-y-0 right-0">
				{#if inst.enableSorting && sortingEnabled}
					<button
						type="button"
						aria-label={dir === 'asc'
							? t('table.sortLabelDescending', { label: headerLabel })
							: dir === 'desc'
								? t('table.sortClearLabel', { label: headerLabel })
								: t('table.sortLabelAscending', { label: headerLabel })}
						title={dir === 'asc'
							? t('table.sortDescending')
							: dir === 'desc'
								? t('table.sortClear')
								: t('table.sortAscending')}
						onclick={() => handleSort(inst)}
						class={cn(
							'flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground transition-opacity duration-150 hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
							isSorted
								? 'opacity-100'
								: 'opacity-0 group-hover:opacity-100'
						)}
					>
						<Icon
							icon={dir === 'desc'
								? 'lucide:arrow-down'
								: dir === 'asc'
									? 'lucide:arrow-up'
									: 'lucide:arrow-up-down'}
							class="h-3.5 w-3.5 text-muted-foreground"
						/>
					</button>
				{/if}

				{#if !disabled}
					<CollectionTableColumnActions {inst} table={tableApi} />
				{/if}
			</Inline>

			{@const canResize = layout.canResize && !disabled}
			{@const isResizing = resizer.activeColumnId === inst.id}
			{#if canResize}
				<button
					type="button"
					title={t('table.resizeColumn')}
					onmousedown={(e) => resizer.handle(e, inst.id)}
					ontouchstart={(e) => resizer.handle(e, inst.id)}
					class={cn(
						'absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none',
						sortableProps && 'z-10'
					)}
				>
					<div
						data-column-resize-indicator
						class={cn(
							'flex h-full w-full items-center justify-center transition-opacity',
							'opacity-0 group-hover:opacity-100',
							isResizing && 'opacity-100'
						)}
					>
						<div
							class={cn(
								'h-5 rounded-full',
								isResizing ? 'w-0.5 bg-brand' : 'w-px bg-muted-foreground/50'
							)}
						></div>
					</div>
				</button>
			{/if}
		{/if}
	</Inline>
{/snippet}

{#snippet renderTableBody()}
	<div
		class="relative min-h-full"
		style="width: {totalTableWidth}px; min-width: 100%;"
		role="rowgroup"
	>
		{#if isLoading}
			{@render renderLoadingSkeleton()}
		{:else if error}
			{@render renderError()}
		{:else if tableApi.data.length === 0}
			{@render renderEmptyState()}
		{:else}
			{@render renderDataRows()}
		{/if}
	</div>
{/snippet}

{#snippet renderLoadingSkeleton()}
	<!--
		A loading surface, not a half-drawn table. This used to repeat the grid's own chrome —
		`border-b` per row, `border-r` per cell — so the skeleton rendered gridlines around empty
		cells and read as a table that had failed to fill in rather than one still arriving. It is
		now one opaque block of pulsing bars: the structure returns when the data does.
	-->
	<div class="w-full bg-card">
		{#each Array(20) as _, i (i)}
			<div class="relative" style="height: {ROW_HEIGHT}px;">
				<div class={getPinnedLayerClass()} style="width: {pinnedWidth}px;">
					{#each pinnedLayouts as layout (layout.id)}
						<Inline
							gap="none"
							fill
							class="absolute top-0 bg-card p-2.5"
							style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
						>
							<Skeleton class="h-4 w-full" />
						</Inline>
					{/each}
				</div>
				<div
					class="absolute top-0 h-full bg-card"
					style="left: {pinnedWidth}px; width: {scrollTotalWidth}px;"
				>
					{#each virtualCols as vi (scrollLayouts[vi.index]?.id ?? `idx:${vi.index}`)}
						{@const layout = scrollLayouts[vi.index]}
						{#if layout}
							<Inline
								gap="none"
								fill
								class="absolute top-0 p-2.5"
								style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
							>
								<Skeleton class="h-4 w-full" />
							</Inline>
						{/if}
					{/each}
				</div>
			</div>
		{/each}
	</div>
{/snippet}

{#snippet renderError()}
	<Inline justify="center" align="center" class="min-h-48 p-8">
		<Alert.Root variant="destructive" class="max-w-md">
			<Icon icon="lucide:alert-circle" class="h-4 w-4" />
			<Alert.Title>{t('table.loadError')}</Alert.Title>
			<Alert.Description class="mt-2">{error}</Alert.Description>
		</Alert.Root>
	</Inline>
{/snippet}

{#snippet renderEmptyState()}
	<Inline justify="center" align="center" class="min-h-48 p-4">
		{#if emptyPlaceholder}
			{@render emptyPlaceholder()}
		{:else}
			<Stack gap="xs" class="text-center text-muted-foreground">
				<Icon icon="lucide:inbox" class="mx-auto h-6 w-6 text-muted-foreground" />
				<p class="text-sm font-medium">{t('common.noResultsFound')}</p>
				<p class="text-xs text-muted-foreground">{t('table.emptyStateHint')}</p>
			</Stack>
		{/if}
	</Inline>
{/snippet}

{#snippet renderDataRows()}
	{@const items = virtualRows}
	{@const first = items[0]}
	{@const last = items[items.length - 1]}
	{@const paddingTop = first ? Math.max(0, first.start) : 0}
	{@const paddingBottom = last ? Math.max(0, totalVirtualRowSize - last.end) : 0}
	<Sortable.Root
		element={bodySortableElement}
		direction="vertical"
		items={tableApi.rowIds}
		handle={rowDragClass}
		disabled={!enableRowReordering || isLoading}
		onSort={(orderedIds) => {
			const map = new Map(tableApi.data.map((r, i) => [tableApi.rowIds[i], r]));
			const reordered: TData[] = [];
			for (const id of orderedIds) {
				const r = map.get(String(id));
				if (r) reordered.push(r);
			}
			onRowReorder?.(reordered);
		}}
	>
		{#snippet child({ draggedItemId })}
			<div class="relative w-full">
				<div style="height: {totalVirtualRowSize}px;"></div>
				<div
					bind:this={bodySortableElement}
					class={bodySortableClass}
					style="position: absolute; top: {paddingTop}px; left: 0; right: 0;"
				>
					{#each items as vi (vi.key)}
						{@const row = tableApi.data.at(vi.index)}
						{@const rowObj = tableApi.rowInstances[vi.index]}
						{@const rowId = rowObj?.id ?? String(vi.key)}
						{@const isRowSelected = !!tableApi.rowSelection.current[rowId]}
						{@const isRowExpanded = !!tableApi.expanded.current[rowId]}
						{@const isDetailActive = isRecordDetailActive(rowId)}
						{@const rowLeadingAccent = row ? (getRowLeadingAccent?.(row) ?? null) : null}
						{#if row && rowObj}
							<Sortable.Item id={String(vi.key)} isDragging={draggedItemId === String(vi.key)}>
								{#snippet child({ props })}
									<div
										{...props}
										data-index={vi.index}
										data-record-id={rowId}
										data-detail-active={isDetailActive ? 'true' : undefined}
										role="row"
										aria-rowindex={tableApi.pagination.current.pageIndex *
											tableApi.pagination.current.pageSize +
											vi.index +
											2}
										aria-selected={isRowSelected}
										aria-current={isDetailActive ? 'true' : undefined}
										aria-expanded={enableRowExpansion ? isRowExpanded : undefined}
										class={cn(
											'group relative transition-colors',
											onRowActivate && 'cursor-pointer'
										)}
										onclick={(event) => activateRow(event, row)}
										onmouseenter={() => (hoveredRowId = rowId)}
										onmouseleave={() => (hoveredRowId = null)}
										{@attach measureRow(isRowExpanded)}
									>
										<div
											class={rowSurfaceClass(isDetailActive, isRowExpanded)}
											style="min-height: {ROW_HEIGHT}px; height: {ROW_HEIGHT}px;"
										>
											{#if enableRowReordering}
												<div
													class={cn(
														'absolute top-1/2 -left-1 z-40 h-6 w-1 -translate-y-1/2 cursor-grab rounded-l-md transition-all duration-150 group-hover:-left-3 active:cursor-grabbing',
														rowDragClass,
														'bg-accent group-hover:w-3 hover:bg-input',
														'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
													)}
													title={t('form.dragToReorder')}
												>
													<div
														class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
													>
														<Icon icon="lucide:grip-vertical" class="h-3 w-3 text-white" />
													</div>
												</div>
											{/if}

											{#if rowLeadingAccent}
												<span
													role="img"
													class={cn(
														'absolute inset-y-0 left-0 z-50 border-l-2',
														rowLeadingAccent.borderClass
													)}
													title={rowLeadingAccent.tooltip}
													aria-label={rowLeadingAccent.tooltip}
												></span>
											{:else if isDetailActive}
												<span
													class="absolute inset-y-1.5 left-0 z-50 w-0.5 rounded-full bg-brand"
													aria-hidden="true"
												></span>
											{/if}

											{@render renderRowCells(row, vi.index)}

											{#if rowActions?.length}
												<!--
													When `stickyRowActions` is true the action block is anchored at
													`right: 0` of the row (= `totalTableWidth`) and translated
													leftwards by however much the row overflows past the scroll
													viewport, so the buttons always appear at the right edge of the
													visible table area regardless of horizontal scroll position.
											The CSS custom properties `--collection-table-body-scroll-left` and
											`--collection-table-body-viewport-width` are kept in sync by
													`syncScrollState` on scroll + a `ResizeObserver` on the body
													scroll element. `min(0px, ...)` clamps the translation so the
													buttons never drift past the row's natural right edge when the
													row already fits inside the viewport.
												-->
												<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
												<div
													class={cn(
														'pointer-events-none absolute inset-y-0 z-50 flex items-center gap-0.5',
														stickyRowActions ? 'right-0 pr-2' : 'right-1'
													)}
													style={stickyRowActions
														? `transform: translateX(min(0px, calc(var(${BODY_SCROLL_LEFT_VAR}, 0px) + var(${BODY_VIEWPORT_WIDTH_VAR}, 0px) - ${totalTableWidth}px)));`
														: undefined}
												>
													{#each rowActions as action}
														<div class="pointer-events-auto">
															{@render action({
																row: rowObj,
																table: tableApi,
																hovered: hoveredRowId === rowObj.id
															})}
														</div>
													{/each}
												</div>
											{/if}
										</div>

										{#if subComponent && enableRowExpansion && isRowExpanded}
											<div id={expandedRegionId(rowObj.id)} class="border-b bg-muted/30 p-4">
												{@render subComponent({ row: rowObj, table: tableApi })}
											</div>
										{/if}
									</div>
								{/snippet}
							</Sortable.Item>
						{:else}
							{@render renderPlaceholderRow()}
						{/if}
					{/each}
					{#if paddingBottom > 0}
						<div style="height: {paddingBottom}px;" data-sortable-disabled="true"></div>
					{/if}
				</div>
			</div>
		{/snippet}
	</Sortable.Root>
{/snippet}

{#snippet renderPlaceholderRow()}
	<div class="relative" style="height: {ROW_HEIGHT}px;">
		<div class={getPinnedLayerClass()} style="width: {pinnedWidth}px;">
			{#each pinnedLayouts as layout (layout.id)}
				<div
					class={cn('absolute top-0 h-full items-center p-2.5', !borderless && 'border-r')}
					style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
				>
					<Skeleton class="h-4 w-full" />
				</div>
			{/each}
		</div>
		<div class="absolute top-0 h-full" style="left: {pinnedWidth}px; width: {scrollTotalWidth}px;">
			{#each virtualCols as cvi (scrollLayouts[cvi.index]?.id ?? `idx:${cvi.index}`)}
				{@const layout = scrollLayouts[cvi.index]}
				{#if layout}
					<div
						class={cn('absolute top-0 h-full items-center p-2.5', !borderless && 'border-r')}
						style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
					>
						<Skeleton class="h-4 w-full" />
					</div>
				{/if}
			{/each}
		</div>
	</div>
{/snippet}

{#snippet renderRowCells(row: TData, index: number)}
	{@const firstDataColumn = layouts.find((l) => !l.isCheckbox)}

	<!-- pinned cells -->
	<div class={getPinnedLayerClass(true)} style="width: {pinnedWidth}px;">
		<div class="relative h-full bg-card">
			{#each pinnedLayouts as layout (layout.id)}
				{@render renderCell(layout, row, index, true, 'bg-card', firstDataColumn?.id ?? null)}
			{/each}
		</div>
	</div>

	<!-- scrollable cells -->
	<!-- stupidity:allow UI5 -- virtualizer column pane clips its own viewport -->
	<div
		class="absolute top-0 h-full overflow-hidden"
		style="left: {pinnedWidth}px; width: {scrollTotalWidth}px;"
	>
		{#each virtualCols as cvi (scrollLayouts[cvi.index]?.id ?? `idx:${cvi.index}`)}
			{@const layout = scrollLayouts[cvi.index]}
			{#if layout}
				{@render renderCell(
					layout,
					row,
					index,
					false,
					!!tableApi.expanded.current[tableApi.rowInstances[index]!.id] ? 'bg-muted/50' : 'bg-card',
					firstDataColumn?.id ?? null
				)}
			{/if}
		{/each}
	</div>
{/snippet}

{#snippet renderCell(
	layout: TColumnLayout | undefined,
	row: TData | undefined,
	index: number,
	isPinned: boolean,
	bgClass: string,
	firstDataColumnId: string | null
)}
	{#if layout && row}
		{@const inst = layout.instance}
		{@const rowObj = tableApi.rowInstances[index]!}
		{@const value = inst.accessor ? inst.accessor(rowObj) : row[inst.id]}
		{@const hasRowControls = enableRowExpansion || enableRowReordering}

		<Inline
			gap="none"
			fill
			class={cn('absolute top-0', !borderless && 'border-r', bgClass, isPinned && 'bg-card')}
			style={`left: ${layout.leftOffset}px; width: ${layout.width}px;`}
			role="gridcell"
			aria-colindex={layout.index + 1}
		>
			{#if layout.id === firstDataColumnId && hasRowControls}
				{#if enableRowExpansion && (getRowHasChildren?.(row) ?? Boolean(subComponent))}
					{@const isExpanded = !!tableApi.expanded.current[rowObj.id]}
					<button
						type="button"
						class="absolute top-1/2 left-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-xs transition-colors hover:bg-muted hover:text-secondary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onclick={(event) => {
							event.stopPropagation();
							tableApi.toggleRowExpanded(rowObj.id);
						}}
						aria-expanded={isExpanded}
						aria-controls={expandedRegionId(rowObj.id)}
						aria-label={isExpanded ? t('table.collapseRowDetails') : t('table.expandRowDetails')}
						title={isExpanded ? t('table.collapseRowDetails') : t('table.expandRowDetails')}
					>
						<Icon
							icon={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
							class="size-3.5"
						/>
					</button>
				{/if}
			{/if}

			<!-- stupidity:allow UI10 -- a virtualized grid cell clips content at its declared column boundary -->
			<Inline
				gap="none"
				grow
				justify={layout.isCheckbox ? 'center' : 'start'}
				class={cn(
					'min-w-0 overflow-hidden px-3.5 py-1.5 text-xs',
					layout.id === firstDataColumnId && hasRowControls && 'pl-10'
				)}
			>
				{#if inst.cell}
					{@const cellCfg = inst.cell({ row: rowObj })}
					{#if cellCfg instanceof RenderComponentConfig}
						{@const { component: Component, props } = cellCfg}
						<Component {...props} />
					{:else if cellCfg instanceof RenderSnippetConfig}
						{@const { snippet, params } = cellCfg}
						{@render snippet(params)}
					{:else}
						<span class="min-w-0 truncate">{String(cellCfg ?? '')}</span>
					{/if}
				{:else}
					<span class="truncate">{String(value ?? '')}</span>
				{/if}
			</Inline>
		</Inline>
	{/if}
{/snippet}
