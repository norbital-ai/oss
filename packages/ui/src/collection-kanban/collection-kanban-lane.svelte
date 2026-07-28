<script lang="ts">
	import Icon from '@iconify/svelte';
	import type SortablePrimitive from 'sortablejs';
	import type { Snippet } from 'svelte';
	import * as CardPrimitive from '#lib/card';
	import { Checkbox } from '#lib/checkbox';
	import { Sortable } from '#lib/sortable';
	import { badgeColorClass } from '../collection-table/collection-card-colors.js';
	import { cn } from '#lib/utils';
	import { humanize } from '@norbital-ai/std/string';

	interface LaneMove {
		recordId: string;
		fromLane: string;
		toLane: string;
	}

	interface Props {
		lane: string;
		/** Display label for the lane header (RFC V.3) — enum label, else humanized value. */
		label?: string;
		/** Optional enum colour token for the lane header chip. */
		color?: string;
		recordIds: string[];
		previousLane?: string;
		nextLane?: string;
		movable: boolean;
		selectable: boolean;
		selectedRecordIds: ReadonlySet<string>;
		pendingRecordIds: ReadonlySet<string>;
		renderCard: Snippet<[string]>;
		onOpen: (recordId: string) => void;
		onToggleSelection: (recordId: string) => void;
		onMove: (move: LaneMove) => void;
		onDragStart: (recordId: string, lane: string) => void;
		onDragEnd: () => void;
	}

	let {
		lane,
		label,
		color,
		recordIds,
		previousLane,
		nextLane,
		movable,
		selectable,
		selectedRecordIds,
		pendingRecordIds,
		renderCard,
		onOpen,
		onToggleSelection,
		onMove,
		onDragStart,
		onDragEnd
	}: Props = $props();
	const laneLabel = $derived(label ?? humanize(lane));

	let sortableElement: HTMLElement | null = $state(null);
	let keyboardPickedId: string | null = $state(null);
	let announcement = $state('');
	const instructionId = $props.id();

	function emitPointerMove(event: SortablePrimitive.SortableEvent): void {
		const recordId = event.item.getAttribute('data-sortable-id');
		const fromLane = event.from?.getAttribute('data-kanban-lane');
		const toLane = event.to?.getAttribute('data-kanban-lane');
		if (!recordId || !fromLane || !toLane || fromLane === toLane) return;
		onMove({ recordId, fromLane, toLane });
	}

	function handleSort(_orderedIds: string[], event: SortablePrimitive.SortableEvent): void {
		emitPointerMove(event);
	}

	function pointerCoordinates(
		event: SortablePrimitive.SortableEvent
	): { x: number; y: number } | null {
		// SortableJS supplies the initiating browser event at runtime but omits it from SortableEvent.
		const originalEvent = (
			event as SortablePrimitive.SortableEvent & { originalEvent?: Event }
		) // stupidity: boundary-cast — completes the upstream SortableJS event declaration.
		.originalEvent;
		if (originalEvent instanceof MouseEvent || originalEvent instanceof PointerEvent) {
			return { x: originalEvent.clientX, y: originalEvent.clientY };
		}
		if (originalEvent instanceof TouchEvent) {
			const touch = originalEvent.changedTouches[0] ?? originalEvent.touches[0];
			return touch ? { x: touch.clientX, y: touch.clientY } : null;
		}
		return null;
	}

	function handleDragEnd(event: SortablePrimitive.SortableEvent): void {
		const point = pointerCoordinates(event);
		const destination = point
			? document
					.elementFromPoint(point.x, point.y)
					?.closest<HTMLElement>('[data-kanban-destination]')
					?.getAttribute('data-kanban-destination')
			: null;
		const recordId = event.item.getAttribute('data-sortable-id');
		if (destination && recordId && destination !== lane) {
			onMove({ recordId, fromLane: lane, toLane: destination });
		}
		onDragEnd();
	}

	function moveWithKeyboard(recordId: string, toLane: string | undefined): void {
		if (!toLane) {
			announcement = `No lane in that direction. ${humanize(lane)} is the board edge.`;
			return;
		}
		keyboardPickedId = null;
		announcement = `Moved card to ${humanize(toLane)}.`;
		onMove({ recordId, fromLane: lane, toLane });
	}

	function handleCardKeydown(event: KeyboardEvent, recordId: string): void {
		if (pendingRecordIds.has(recordId)) return;
		if (event.key === 'Escape' && keyboardPickedId === recordId) {
			event.preventDefault();
			keyboardPickedId = null;
			announcement = 'Card move cancelled.';
			return;
		}
		if (event.key === ' ') {
			event.preventDefault();
			keyboardPickedId = keyboardPickedId === recordId ? null : recordId;
			announcement =
				keyboardPickedId === recordId
					? 'Card picked up. Use Left or Right Arrow to move it, or Escape to cancel.'
					: 'Card move cancelled.';
			return;
		}
		if (keyboardPickedId === recordId && event.key === 'ArrowLeft') {
			event.preventDefault();
			moveWithKeyboard(recordId, previousLane);
			return;
		}
		if (keyboardPickedId === recordId && event.key === 'ArrowRight') {
			event.preventDefault();
			moveWithKeyboard(recordId, nextLane);
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			onOpen(recordId);
		}
	}
</script>

<section
	class="kanban-lane bg-muted/40 flex h-full min-h-0 w-full snap-start flex-col rounded-sm p-3"
	data-kanban-lane-section={lane}
	data-kanban-destination={lane}
>
	<header class="mb-3 flex shrink-0 items-center justify-between text-sm font-medium">
		<span class="flex min-w-0 items-center gap-1.5">
			{#if color}
				<span class={cn('inline-block size-2 shrink-0 rounded-full', badgeColorClass(color))}
				></span>
			{/if}
			<span class="truncate">{laneLabel}</span>
		</span>
		<span class="text-muted-foreground">{recordIds.length}</span>
	</header>
	<p id={instructionId} class="sr-only">
		Press Enter to open a card. Press Space to pick it up, then Left or Right Arrow to move it
		between lanes. Press Escape to cancel.
	</p>
	<p class="sr-only" aria-live="polite">{announcement}</p>
	<Sortable.Root
		items={recordIds}
		sortableGroup="collection-kanban"
		sort={false}
		handle="kanban-drag-handle"
		disabled={!movable}
		delay={200}
		delayOnTouchOnly={true}
		touchStartThreshold={5}
		fallbackTolerance={4}
		scroll={true}
		scrollSensitivity={80}
		scrollSpeed={14}
		onSort={handleSort}
		onDragStart={(recordId) => onDragStart(recordId, lane)}
		onDragEnd={handleDragEnd}
		element={sortableElement}
	>
		{#snippet child({ draggedItemId })}
			<div
				bind:this={sortableElement}
				data-kanban-lane={lane}
				class="grid min-h-0 min-w-0 flex-1 auto-rows-max content-start gap-2 overflow-x-hidden overflow-y-auto"
			>
				{#each recordIds as recordId (recordId)}
					<div
						data-sortable-id={recordId}
						data-sortable-disabled={!movable || pendingRecordIds.has(recordId) ? 'true' : undefined}
						class={cn(
							'sortable-item min-w-0 overflow-hidden',
							(!movable || pendingRecordIds.has(recordId)) && 'sortable-disabled',
							draggedItemId === recordId && 'sortable-dragging'
						)}
					>
						<CardPrimitive.Root
							class={cn(
								'group relative h-32 w-full min-w-0 overflow-hidden rounded-sm transition-colors',
								selectedRecordIds.has(recordId) && 'bg-accent/60 ring-1 ring-ring'
							)}
							role="button"
							tabindex={0}
							aria-describedby={instructionId}
							aria-pressed={keyboardPickedId === recordId}
							data-selected={selectedRecordIds.has(recordId) ? 'true' : undefined}
							aria-busy={pendingRecordIds.has(recordId)}
							onclick={() => onOpen(recordId)}
							onkeydown={(event) => handleCardKeydown(event, recordId)}
						>
							<CardPrimitive.Content
								class="h-full min-w-0 overflow-x-hidden overflow-y-auto p-3 text-sm"
							>
								{@render renderCard(recordId)}
							</CardPrimitive.Content>
							{#if selectable}
								<Checkbox
									class={cn(
										"pointer-events-none absolute top-2 right-2 z-10 size-3.5 cursor-pointer bg-background/95 opacity-0 shadow-xs transition-opacity duration-150 before:absolute before:-inset-2 before:content-[''] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none [&>div]:size-3.5 [&_svg]:size-3",
										selectedRecordIds.has(recordId) && 'pointer-events-auto opacity-100'
									)}
									onclick={(event) => event.stopPropagation()}
									aria-label="Select card"
									checked={selectedRecordIds.has(recordId)}
									disabled={pendingRecordIds.has(recordId)}
									onCheckedChange={() => onToggleSelection(recordId)}
								/>
							{/if}
							{#if movable}
								<button
									type="button"
									class={cn(
										'kanban-drag-handle pointer-events-none absolute top-2 left-2 z-10 flex size-7 cursor-grab touch-none items-center justify-center rounded-sm border border-border bg-background/95 text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 hover:bg-muted group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing motion-reduce:transition-none',
										(keyboardPickedId === recordId || draggedItemId === recordId) &&
											'pointer-events-auto opacity-100'
									)}
									aria-label="Drag card"
									onclick={(event) => event.stopPropagation()}
								>
									<Icon icon="lucide:grip-vertical" class="size-3.5" />
								</button>
							{/if}
						</CardPrimitive.Root>
					</div>
				{:else}
					<div
						class="flex min-h-32 flex-col items-center justify-center rounded-sm border border-dashed border-border bg-background/50 p-5 text-center"
					>
						<Icon icon="lucide:inbox" class="mb-2 size-5 text-muted-foreground" />
						<p class="text-sm font-medium">No {humanize(lane).toLowerCase()} jobs</p>
						<p class="mt-1 text-xs text-muted-foreground">
							This lane is clear for the selected view.
						</p>
					</div>
				{/each}
			</div>
		{/snippet}
	</Sortable.Root>
</section>
