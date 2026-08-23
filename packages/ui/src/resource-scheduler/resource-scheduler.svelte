<script
	lang="ts"
	generics="TResource extends ResourceSchedulerResource, TItem extends ResourceSchedulerItem"
>
	import Icon from '@iconify/svelte';
	import { Number as EffectNumber } from 'effect';
	import { Checkbox } from '#lib/checkbox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { cn } from '#lib/utils';
	import { Cover, Inline, Scroll } from '#lib/layout';
	import { createVirtualizer } from '#lib/utils/virtualizer.svelte';
	import type {
		ResourceSchedulerChange,
		ResourceSchedulerCell,
		ResourceSchedulerCollision,
		ResourceSchedulerItem,
		ResourceSchedulerProps,
		ResourceSchedulerResource
	} from './resource-scheduler.types.js';
	import {
		buildResourceSchedulerDays,
		resourceSchedulerIntervalPosition,
		shiftResourceSchedulerInterval
	} from './resource-scheduler.utils.js';

	type DragState =
		| {
				kind: 'create';
				resourceId: string;
				startIndex: number;
				endIndex: number;
		  }
		| {
				kind: 'move' | 'resize-start' | 'resize-end';
				itemId: string;
				resourceId: string;
				startX: number;
				deltaDays: number;
				start: string;
				end: string;
		  };

	const { t } = useI18n<UiKeys>();

	let {
		resources,
		items,
		view,
		anchorDate,
		layout = 'timeline',
		selectedItemIds = [],
		rowHeight: configuredRowHeight,
		resourceWidth = 220,
		dayWidth: configuredDayWidth,
		resourceLabel = t('misc.resources'),
		maxVisibleCellItems = 3,
		disabled = false,
		readonly = false,
		class: className,
		resourceContent,
		itemContent,
		cellContent,
		onSelectionChange,
		onCreate,
		onMove,
		onResize,
		onCollision,
		onItemActivate,
		onCellActivate
	}: ResourceSchedulerProps<TResource, TItem> = $props();

	const days = $derived(buildResourceSchedulerDays(anchorDate, view, useI18n<UiKeys>().intlLocale));
	const rowHeight = $derived(configuredRowHeight ?? (layout === 'matrix' ? 88 : 56));
	const dayWidth = $derived(
		configuredDayWidth ?? (layout === 'matrix' ? 156 : view === 'week' ? 128 : 48)
	);
	const timelineWidth = $derived(days.length * dayWidth);
	const totalWidth = $derived(resourceWidth + timelineWidth);
	const rangeStart = $derived(days[0]?.start ?? anchorDate);
	const rangeEnd = $derived(days.at(-1)?.end ?? anchorDate);
	const selected = $derived(new Set(selectedItemIds));
	let bodyElement: HTMLElement | null = $state(null);
	let headerTimelineElement: HTMLDivElement | null = $state(null);
	let drag: DragState | null = $state(null);

	const virtualizer = createVirtualizer({
		count: () => resources.length,
		scrollElement: () => bodyElement,
		estimateSize: () => rowHeight,
		overscan: 5,
		getItemKey: (index) => resources[index]?.id ?? index
	});
	const virtualRows = $derived(virtualizer.virtualItems);
	const itemsByResource = $derived.by(() => {
		const grouped = new Map<string, TItem[]>();
		for (const item of items) {
			const current = grouped.get(item.resourceId) ?? [];
			current.push(item);
			grouped.set(item.resourceId, current);
		}
		return grouped;
	});
	const matrixItemsByCell = $derived.by(() => {
		const grouped = new Map<string, TItem[]>();
		for (const item of items) {
			const key = `${item.resourceId}:${item.start.slice(0, 10)}`;
			const current = grouped.get(key) ?? [];
			current.push(item);
			grouped.set(key, current);
		}
		return grouped;
	});

	function syncHeaderScroll(): void {
		if (bodyElement && headerTimelineElement) {
			headerTimelineElement.scrollLeft = bodyElement.scrollLeft;
		}
	}

	function toggleItem(itemId: string, additive: boolean): void {
		if (!onSelectionChange) return;
		const next = additive ? new Set(selected) : new Set<string>();
		if (next.has(itemId)) next.delete(itemId);
		else next.add(itemId);
		onSelectionChange([...next]);
	}

	function toggleResource(resourceId: string, checked: boolean): void {
		if (!onSelectionChange) return;
		const next = new Set(selected);
		for (const item of itemsByResource.get(resourceId) ?? []) {
			if (checked) next.add(item.id);
			else next.delete(item.id);
		}
		onSelectionChange([...next]);
	}

	function collision(
		change: {
			readonly itemId?: string;
			readonly resourceId: string;
			readonly start: string;
			readonly end: string;
		},
		kind: ResourceSchedulerCollision['kind']
	): boolean {
		const start = new Date(change.start).getTime();
		const end = new Date(change.end).getTime();
		const collidingItemIds = items
			.filter(
				(item) =>
					item.id !== change.itemId &&
					item.resourceId === change.resourceId &&
					new Date(item.start).getTime() < end &&
					new Date(item.end).getTime() > start
			)
			.map((item) => item.id);
		if (collidingItemIds.length === 0) return true;
		return onCollision?.({ ...change, kind, collidingItemIds }) !== false;
	}

	function commitMove(
		item: TItem,
		resourceId: string,
		daysDelta: number,
		resize: 'start' | 'end' | null
	): void {
		const interval = shiftResourceSchedulerInterval(item.start, item.end, daysDelta, resize);
		const change = { itemId: item.id, resourceId, ...interval };
		const kind = resize ? 'resize' : 'move';
		if (!collision(change, kind)) return;
		if (resize) onResize?.(change);
		else onMove?.(change);
	}

	function handleItemKeydown(event: KeyboardEvent, item: TItem): void {
		if (event.key === 'Enter') return onItemActivate?.(item);
		if (disabled || readonly || item.disabled || item.editable === false) return;
		if (event.key === ' ') {
			event.preventDefault();
			toggleItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey);
			return;
		}
		if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			event.preventDefault();
			const delta = event.key === 'ArrowLeft' ? -1 : 1;
			commitMove(
				item,
				item.resourceId,
				delta,
				event.shiftKey ? (event.altKey ? 'start' : 'end') : null
			);
			return;
		}
		if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			event.preventDefault();
			const currentIndex = resources.findIndex((resource) => resource.id === item.resourceId);
			const nextIndex = EffectNumber.clamp(currentIndex + (event.key === 'ArrowUp' ? -1 : 1), {
				minimum: 0,
				maximum: resources.length - 1
			});
			const resourceId = resources[nextIndex]?.id;
			if (resourceId) commitMove(item, resourceId, 0, null);
		}
	}

	function beginItemDrag(event: PointerEvent, item: TItem, kind: DragState['kind']): void {
		if (disabled || readonly || item.disabled || item.editable === false || kind === 'create')
			return;
		event.preventDefault();
		if (event.currentTarget instanceof Element) {
			event.currentTarget.closest('[data-scheduler-item]')?.setPointerCapture(event.pointerId);
		}
		drag = {
			kind,
			itemId: item.id,
			resourceId: item.resourceId,
			startX: event.clientX,
			deltaDays: 0,
			start: item.start,
			end: item.end
		};
	}

	function commitCreate(resourceId: string, start: string, end: string): void {
		const change = { resourceId, start, end };
		if (collision(change, 'create')) onCreate?.(change);
	}

	function updateItemDrag(event: PointerEvent): void {
		if (!drag || drag.kind === 'create') return;
		drag.deltaDays = Math.round((event.clientX - drag.startX) / dayWidth);
		const target = document
			.elementFromPoint(event.clientX, event.clientY)
			?.closest('[data-resource-id]');
		const resourceId = target?.getAttribute('data-resource-id');
		if (resourceId) drag.resourceId = resourceId;
	}

	function finishItemDrag(item: TItem): void {
		if (!drag || drag.kind === 'create' || drag.itemId !== item.id) return;
		const resize =
			drag.kind === 'resize-start' ? 'start' : drag.kind === 'resize-end' ? 'end' : null;
		if (resize == null && drag.deltaDays === 0 && drag.resourceId === item.resourceId) {
			drag = null;
			return;
		}
		commitMove(item, drag.resourceId, drag.deltaDays, resize);
		drag = null;
	}

	function beginCreate(event: PointerEvent, resourceId: string): void {
		if (disabled || readonly || !onCreate || !(event.target instanceof Element)) return;
		if (event.target.closest('[data-scheduler-item]')) return;
		const dayElement = event.target.closest('[data-day-index]');
		const index = Number(dayElement?.getAttribute('data-day-index'));
		if (!Number.isInteger(index)) return;
		event.currentTarget instanceof Element &&
			event.currentTarget.setPointerCapture(event.pointerId);
		drag = { kind: 'create', resourceId, startIndex: index, endIndex: index };
	}

	function updateCreate(event: PointerEvent): void {
		if (!drag || drag.kind !== 'create' || !(event.currentTarget instanceof HTMLElement)) return;
		const rectangle = event.currentTarget.getBoundingClientRect();
		const index = EffectNumber.clamp(
			Math.floor((event.clientX - rectangle.left - resourceWidth) / dayWidth),
			{ minimum: 0, maximum: days.length - 1 }
		);
		drag.endIndex = index;
	}

	function finishCreate(): void {
		if (!drag || drag.kind !== 'create') return;
		const first = Math.min(drag.startIndex, drag.endIndex);
		const last = Math.max(drag.startIndex, drag.endIndex);
		const start = days[first]?.start;
		const end = days[last]?.end;
		if (start && end) {
			commitCreate(drag.resourceId, start, end);
		}
		drag = null;
	}

	function visible(item: TItem): boolean {
		return (
			new Date(item.start).getTime() < new Date(rangeEnd).getTime() &&
			new Date(item.end).getTime() > new Date(rangeStart).getTime()
		);
	}

	function schedulerCell(
		resourceId: string,
		start: string,
		end: string
	): ResourceSchedulerCell<TItem> {
		return {
			resourceId,
			start,
			end,
			items: matrixItemsByCell.get(`${resourceId}:${start.slice(0, 10)}`) ?? []
		};
	}
</script>

{#snippet schedulerHeader()}
	<div
		class="grid h-10 border-b bg-muted/80"
		style={`grid-template-columns:${resourceWidth}px minmax(0,1fr)`}
	>
		<div class="z-20 flex items-center border-r px-3 text-xs font-semibold">{resourceLabel}</div>
		<div bind:this={headerTimelineElement} class="overflow-hidden">
			<div class="flex h-full" style={`width:${timelineWidth}px`}>
				{#each days as day (day.key)}
					<div
						class="flex shrink-0 items-center border-r px-2 text-xs font-medium"
						style={`width:${dayWidth}px`}
					>
						{day.label}
					</div>
				{/each}
			</div>
		</div>
	</div>
{/snippet}

<Cover
	as="div"
	gap="none"
	class={cn('min-h-64 min-w-0 rounded-md border bg-card', className)}
	top={schedulerHeader}
>
	<Scroll
		axis="both"
		name={t('misc.resourceSchedule')}
		class="relative"
		bind:ref={bodyElement}
		onscroll={syncHeaderScroll}
	>
		<div
			class="relative"
			style={`height:${virtualizer.totalSize}px;width:${totalWidth}px;min-width:100%`}
		>
			{#each virtualRows as virtualRow (virtualRow.key)}
				{@const resource = resources[virtualRow.index]}
				{#if resource}
					{@const resourceItems = itemsByResource.get(resource.id) ?? []}
					{@const selectedCount = resourceItems.filter((item) => selected.has(item.id)).length}
					<div
						class="absolute left-0 border-b"
						style={`top:${virtualRow.start}px;height:${rowHeight}px;width:${totalWidth}px`}
						data-resource-id={resource.id}
						role="presentation"
						onpointerdown={(event) => beginCreate(event, resource.id)}
						onpointermove={updateCreate}
						onpointerup={finishCreate}
						onpointercancel={() => (drag = null)}
					>
						<Inline
							gap="sm"
							fill
							class="sticky left-0 z-20 border-r bg-card px-3"
							style={`width:${resourceWidth}px`}
						>
							{#if onSelectionChange}
								<Checkbox
									checked={resourceItems.length > 0 && selectedCount === resourceItems.length}
									indeterminate={selectedCount > 0 && selectedCount < resourceItems.length}
									disabled={resourceItems.length === 0}
									onCheckedChange={(checked) => toggleResource(resource.id, checked)}
								/>
							{/if}
							<div class="min-w-0">
								{#if resourceContent}
									{@render resourceContent(resource)}
								{:else}
									<p class="truncate text-sm font-medium">{resource.label}</p>
									{#if resource.description}<p class="truncate text-meta">
											{resource.description}
										</p>{/if}
								{/if}
							</div>
						</Inline>

						<div
							class="absolute inset-y-0"
							style={`left:${resourceWidth}px;width:${timelineWidth}px`}
						>
							{#if layout === 'matrix'}
								{#each days as day, index (day.key)}
									{@const cell = schedulerCell(resource.id, day.start, day.end)}
									{@const visibleItems = cell.items.slice(0, maxVisibleCellItems)}
									{@const overflow = cell.items.length - visibleItems.length}
									{@const locked = cell.items.some((item) => item.editable === false)}
									<div
										class={cn('absolute inset-y-0 border-r px-2 py-1.5', locked && 'bg-warning/10')}
										style={`left:${index * dayWidth}px;width:${dayWidth}px`}
										data-day-index={index}
										data-locked={locked || undefined}
									>
										<button
											type="button"
											class="flex w-full items-center justify-between rounded-sm text-left text-micro font-medium focus-visible:ring-2 focus-visible:ring-ring"
											disabled={disabled || !onCellActivate}
											aria-label={t('misc.cellAssignments', {
												count: cell.items.length,
												day: day.label,
												resource: resource.label
											})}
											onclick={() => onCellActivate?.(cell)}
										>
											{#if cellContent}
												{@render cellContent(resource, cell)}
											{:else}
												<span>{t('misc.assigned', { count: cell.items.length })}</span>
												{#if locked}
													<Icon icon="lucide:lock-keyhole" class="size-3 text-muted-foreground" />
												{/if}
											{/if}
										</button>
										<div class="min-w-0 overflow-hidden">
											<Inline gap="xs" class="mt-1">
												{#each visibleItems as item (item.id)}
													<button
														type="button"
														class={cn(
															'flex h-7 min-w-0 touch-none items-center gap-1 rounded-sm border bg-background px-1.5 text-micro shadow-xs focus-visible:ring-2 focus-visible:ring-ring',
															item.editable === false
																? 'cursor-default text-muted-foreground'
																: 'cursor-grab active:cursor-grabbing',
															selected.has(item.id) && 'ring-2 ring-ring'
														)}
														data-scheduler-item={item.id}
														aria-pressed={selected.has(item.id)}
														aria-disabled={item.editable === false}
														title={item.lockedReason ?? item.label}
														disabled={disabled || item.disabled}
														onclick={(event) => {
															event.stopPropagation();
															onItemActivate?.(item);
														}}
														onkeydown={(event) => handleItemKeydown(event, item)}
														onpointerdown={(event) => beginItemDrag(event, item, 'move')}
														onpointermove={updateItemDrag}
														onpointerup={() => finishItemDrag(item)}
														onpointercancel={() => (drag = null)}
													>
														{#if item.editable === false}<Icon
																icon="lucide:lock-keyhole"
																class="size-3 shrink-0"
															/>{/if}
														<span class="truncate">
															{#if itemContent}{@render itemContent(item)}{:else}{item.label}{/if}
														</span>
													</button>
												{/each}
												{#if overflow > 0}
													<button
														type="button"
														class="h-7 shrink-0 rounded-sm px-1 text-micro font-medium text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
														onclick={() => onCellActivate?.(cell)}>+{overflow}</button
													>
												{/if}
											</Inline>
										</div>
									</div>
								{/each}
							{:else}
								{#each days as day, index (day.key)}
									<button
										type="button"
										class="absolute inset-y-0 border-r hover:bg-muted/30 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring"
										style={`left:${index * dayWidth}px;width:${dayWidth}px`}
										data-day-index={index}
										aria-label={t('misc.createOn', { day: day.label, resource: resource.label })}
										disabled={disabled || readonly || !onCreate}
										onclick={(event) => {
											if (event.detail === 0) commitCreate(resource.id, day.start, day.end);
										}}
									></button>
								{/each}
								{#each resourceItems.filter(visible) as item (item.id)}
									{@const position = resourceSchedulerIntervalPosition(
										item.start,
										item.end,
										rangeStart,
										dayWidth
									)}
									<button
										type="button"
										class={cn(
											'group absolute top-2 flex h-8 touch-none items-center overflow-hidden rounded-sm border px-2 text-left text-xs shadow-xs focus-visible:ring-2 focus-visible:ring-ring',
											item.tone === 'warning' && 'border-warning/50 bg-warning/15',
											item.tone === 'destructive' && 'border-destructive/50 bg-destructive/10',
											item.tone === 'muted' && 'bg-muted',
											(!item.tone || item.tone === 'default') && 'bg-background',
											selected.has(item.id) && 'ring-2 ring-ring'
										)}
										style={`left:${position.left}px;width:${position.width}px`}
										data-scheduler-item={item.id}
										aria-pressed={selected.has(item.id)}
										aria-disabled={item.editable === false}
										title={item.lockedReason}
										disabled={disabled || item.disabled}
										onclick={(event) => {
											event.stopPropagation();
											toggleItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey);
										}}
										ondblclick={() => onItemActivate?.(item)}
										onkeydown={(event) => handleItemKeydown(event, item)}
										onpointerdown={(event) => beginItemDrag(event, item, 'move')}
										onpointermove={updateItemDrag}
										onpointerup={() => finishItemDrag(item)}
										onpointercancel={() => (drag = null)}
									>
										{#if item.editable !== false}<span
												class="absolute inset-y-0 left-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 group-hover:opacity-100"
												role="separator"
												aria-orientation="vertical"
												aria-label={t('misc.resizeStart')}
												onpointerdown={(event) => {
													event.stopPropagation();
													beginItemDrag(event, item, 'resize-start');
												}}><Icon icon="lucide:grip-vertical" class="size-3" /></span
											>{/if}
										<span class="min-w-0 flex-1 truncate">
											{#if itemContent}{@render itemContent(item)}{:else}{item.label}{/if}
										</span>
										{#if item.editable !== false}<span
												class="absolute inset-y-0 right-0 flex w-2 cursor-ew-resize items-center justify-center opacity-0 group-hover:opacity-100"
												role="separator"
												aria-orientation="vertical"
												aria-label={t('misc.resizeEnd')}
												onpointerdown={(event) => {
													event.stopPropagation();
													beginItemDrag(event, item, 'resize-end');
												}}><Icon icon="lucide:grip-vertical" class="size-3" /></span
											>{/if}
									</button>
								{/each}
							{/if}
						</div>
					</div>
				{/if}
			{/each}
		</div>
	</Scroll>
</Cover>
