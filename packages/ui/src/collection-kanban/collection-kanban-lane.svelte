<script lang="ts">
	import Icon from '@iconify/svelte';
	import type SortablePrimitive from 'sortablejs';
	import type { Snippet } from 'svelte';
	import * as CardPrimitive from '#lib/card';
	import { Checkbox } from '#lib/checkbox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Cover, Imposter, Inline, Scroll, Stack } from '#lib/layout';
	import { VirtualList } from '#lib/virtual-list';
	import type { CollectionRecordLeadingAccent } from '#lib/collection-record-metadata';
	import { Sortable } from '#lib/sortable';
	import { badgeColorClass } from '#lib/collection-table/collection-card-colors';
	import { cn } from '#lib/utils';
	import { humanize } from '@norbital-ai/std/string';

	const { t } = useI18n<UiKeys>();

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
		selectable: boolean;
		selectedRecordIds: ReadonlySet<string>;
		mutationPending: boolean;
		/** Records whose lane field the viewer may not update, with the reason. */
		updateRestrictionReasonById: ReadonlyMap<string, string>;
		renderCard: Snippet<[string]>;
		renderMetadata: Snippet<[string]>;
		getLeadingAccent: (recordId: string) => CollectionRecordLeadingAccent | null;
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
		selectable,
		selectedRecordIds,
		mutationPending,
		updateRestrictionReasonById,
		renderCard,
		renderMetadata,
		getLeadingAccent,
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
		// A real cross-lane sort is committed by handleSort after this callback. The coordinate
		// fallback is only for drops where Sortable left the card in its original list.
		if (event.from === event.to && destination && recordId && destination !== lane) {
			onMove({ recordId, fromLane: lane, toLane: destination });
		}
		onDragEnd();
	}

	function moveWithKeyboard(recordId: string, toLane: string | undefined): void {
		if (!toLane) {
			announcement = t('kanban.noLaneDirection', { lane: humanize(lane) });
			return;
		}
		keyboardPickedId = null;
		announcement = t('kanban.cardMoved', { lane: humanize(toLane) });
		onMove({ recordId, fromLane: lane, toLane });
	}

	function handleCardKeydown(event: KeyboardEvent, recordId: string): void {
		if (mutationPending) return;
		const picked = keyboardPickedId === recordId;
		if (event.key === 'Enter') {
			event.preventDefault();
			onOpen(recordId);
			return;
		}
		if (event.key === 'Escape' && picked) {
			event.preventDefault();
			keyboardPickedId = null;
			announcement = t('kanban.moveCancelled');
			return;
		}
		const direction =
			event.key === ' '
				? 'pick'
				: picked && event.key === 'ArrowLeft'
					? previousLane
					: picked && event.key === 'ArrowRight'
						? nextLane
						: null;
		if (direction === null) return;
		event.preventDefault();
		const restriction = updateRestrictionReasonById.get(recordId);
		if (restriction) {
			keyboardPickedId = null;
			announcement = t('recordMetadata.readOnlyMove', { reason: restriction });
			return;
		}
		if (direction === 'pick') {
			keyboardPickedId = picked ? null : recordId;
			announcement = picked ? t('kanban.moveCancelled') : t('kanban.cardPickedUp');
			return;
		}
		moveWithKeyboard(recordId, direction);
	}
</script>

{#snippet laneHeader()}
	<Inline justify="between" gap="xs" class="text-sm font-medium">
		<Inline gap="xs" class="min-w-0">
			{#if color}
				<span class={cn('inline-block size-2 shrink-0 rounded-full', badgeColorClass(color))}
				></span>
			{/if}
			<span class="truncate">{laneLabel}</span>
		</Inline>
		<span class="text-muted-foreground">{recordIds.length}</span>
	</Inline>
{/snippet}

<Cover
	as="section"
	gap="sm"
	class="kanban-lane bg-muted/40 snap-start rounded-sm p-3"
	data-kanban-lane-section={lane}
	data-kanban-destination={lane}
	top={laneHeader}
>
	<p id={instructionId} class="sr-only">
		{t('kanban.keyboardInstructions')}
	</p>
	<p class="sr-only" aria-live="polite">{announcement}</p>
	<Sortable.Root
		items={recordIds}
		sortableGroup="collection-kanban"
		sort={false}
		handle="kanban-drag-handle"
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
			<Scroll axis="y" name={laneLabel} class="relative pr-1 pb-1">
				<!-- The list is the drop target: empty, it keeps the empty card's height so a card can land in it. -->
				<VirtualList
					items={recordIds}
					key={(recordId) => recordId}
					estimateSize={88}
					gap={8}
					bind:ref={sortableElement}
					data-kanban-lane={lane}
					class={cn(recordIds.length === 0 && 'min-h-28')}
					itemProps={(recordId) => {
						const locked = mutationPending || updateRestrictionReasonById.has(recordId);
						return {
							'data-sortable-id': recordId,
							'data-sortable-disabled': locked ? 'true' : undefined,
							class: cn(
								'sortable-item min-w-0',
								locked && 'sortable-disabled',
								draggedItemId === recordId && 'sortable-dragging'
							)
						};
					}}
				>
					{#snippet item(recordId)}
						{@render card(recordId, draggedItemId)}
					{/snippet}
				</VirtualList>
				{#if recordIds.length === 0}
					<Imposter placement="top" class="pointer-events-none">
						<Stack
							gap="xs"
							align="center"
							justify="center"
							class="min-h-28 rounded-sm border border-dashed border-border bg-background/50 p-4 text-center"
						>
							<Icon icon="lucide:inbox" class="size-5 text-muted-foreground" />
							<p class="text-sm font-medium">
								{t('kanban.noLaneJobs', { lane: laneLabel.toLowerCase() })}
							</p>
							<p class="text-meta">{t('kanban.laneClear')}</p>
						</Stack>
					</Imposter>
				{/if}
			</Scroll>
		{/snippet}
	</Sortable.Root>
</Cover>

{#snippet card(recordId: string, draggedItemId: string | null)}
	{@const leadingAccent = getLeadingAccent(recordId)}
	{@const selected = selectedRecordIds.has(recordId)}
	{@const restricted = updateRestrictionReasonById.has(recordId)}
	<!--
		A floor, not a fixed height: a fixed height with `overflow-hidden` clipped two-line titles
		against the card edge. Cards grow to what they hold; the floor keeps one-line lanes regular.
	-->
	<CardPrimitive.Root
		class={cn(
			'group relative min-h-20 w-full min-w-0 overflow-clip rounded-sm transition-colors',
			selected && 'bg-accent/60 ring-1 ring-ring'
		)}
		role="button"
		tabindex={0}
		aria-describedby={instructionId}
		aria-pressed={keyboardPickedId === recordId}
		data-selected={selected ? 'true' : undefined}
		data-readonly={restricted ? 'true' : undefined}
		aria-busy={mutationPending}
		onclick={() => onOpen(recordId)}
		onkeydown={(event) => handleCardKeydown(event, recordId)}
	>
		{#if leadingAccent !== null}
			<Imposter
				as="span"
				placement="start"
				class={cn('inset-y-1 w-1 rounded-r-full', leadingAccent.markerClass)}
				title={leadingAccent.tooltip}
				aria-hidden="true"
			/>
		{/if}
		<CardPrimitive.Content class="h-full min-w-0 p-2.5 text-sm">
			<Stack gap="xs">
				{@render renderCard(recordId)}
				{@render renderMetadata(recordId)}
			</Stack>
		</CardPrimitive.Content>
		{#if selectable}
			<Imposter placement="top-end" class="pointer-events-none">
				<Checkbox
					class={cn(
						// repository-health:allow UI19 -- the ::before pseudo-element widens the hit area; even a childless Imposter is an element, and the bits-ui Checkbox owns its children, so no layer can sit inside it
						"pointer-events-none relative block size-3.5 cursor-pointer bg-background/95 opacity-0 shadow-xs transition-opacity duration-150 before:absolute before:-inset-2 before:content-[''] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none [&>div]:size-3.5 [&_svg]:size-3",
						selected && 'pointer-events-auto opacity-100'
					)}
					onclick={(event) => event.stopPropagation()}
					aria-label={t('kanban.selectCard')}
					checked={selected}
					disabled={mutationPending}
					onCheckedChange={() => onToggleSelection(recordId)}
				/>
			</Imposter>
		{/if}
		{#if !restricted}
			<Imposter placement="top-start" class="pointer-events-none">
				<button
					type="button"
					class={cn(
						'kanban-drag-handle pointer-events-none block size-6 cursor-grab touch-none rounded-sm border border-border bg-background/95 text-muted-foreground opacity-0 shadow-xs transition-opacity duration-150 hover:bg-muted group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing motion-reduce:transition-none',
						(keyboardPickedId === recordId || draggedItemId === recordId) &&
							'pointer-events-auto opacity-100'
					)}
					aria-label={t('kanban.dragCard')}
					onclick={(event) => event.stopPropagation()}
				>
					<Inline as="span" justify="center" class="size-full">
						<Icon icon="lucide:grip-vertical" class="size-3.5" />
					</Inline>
				</button>
			</Imposter>
		{/if}
	</CardPrimitive.Root>
{/snippet}
