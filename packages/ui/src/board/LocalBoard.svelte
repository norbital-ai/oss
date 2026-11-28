<!--
@component
A kanban board over a caller-supplied local row array, sharing the exact lane, empty-state, card, toolbar and expanded-lane dialog chrome of `Board`.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Value } from '@norbital-ai/store/kind';
	import type { UiContext } from '../client/contract.js';
	import type { Row, Values } from '../model/types.js';
	import type { CustomField } from '../model/CustomView.svelte';
	import type { Toolbar } from '../model/ViewToolbar.svelte';

	/** One lane column in a `LocalBoard`. */
	export type LocalLane = {
		/** The field value matched against `by` to place a row in this lane. */
		readonly value: Value;
		/** The lane heading shown in the header and expanded-lane dialog. */
		readonly label: string;
		/** Optional Tailwind background class for the status dot beside `label`. */
		readonly dot?: string | null;
	};

	/** Props for `LocalBoard`. */
	export type LocalBoardProps<R extends Values = Row> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The local rows shown as cards across lanes. */
		of: readonly R[];
		/** The row property that assigns a card to its lane. */
		by: keyof R & string;
		/** The lanes in display order. */
		lanes: readonly LocalLane[];
		/** Card content snippet. */
		card: Snippet<[{ row: R; lane: LocalLane }]>;
		/** The fields the toolbar searches, filters and sorts on. */
		fields: readonly CustomField<R>[];
		/** Lanes per row; unset is a horizontal scrolling reel. */
		columns?: number;
		/** Toolbar configuration (`ViewToolbar`). */
		toolbar?: Toolbar<R>;
		/** URL prefix for filter/sort state. */
		key: string;
		/** Opening a card; omitted renders non-interactive cards. */
		on_open?: (row: R) => void;
		/** Per-row gate for interactivity when `on_open` is given. */
		can_open?: (row: R) => boolean;
	};
</script>

<script lang="ts" generics="R extends Values = Row">
	import { Effect } from 'effect';
	import { Button } from '../primitives/button/index.js';
	import * as Dialog from '../primitives/dialog/index.js';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { words_of } from '../client/context.js';
	import { localExposure, matches, sortRows } from '../filter/local.js';
	import { sortable } from '../filter/order.js';
	import { viewState } from '../filter/view-state.svelte.js';
	import { tone } from '../kinds/kind.js';
	import { searchRows } from '../table/model.js';
	import { humanize, msg } from '../text/messages.js';
	import ViewToolbar from '../model/ViewToolbar.svelte';
	import ToolbarSearch from '../model/toolbar/ToolbarSearch.svelte';
	import LocalBoardLane from './LocalBoardLane.svelte';

	let {
		ctx,
		of,
		by,
		lanes,
		card,
		fields,
		columns,
		toolbar = {},
		key,
		on_open,
		can_open
	}: LocalBoardProps<R> = $props();

	const words = $derived(words_of(ctx));
	const LOCAL = '$local';
	const names = $derived(fields.map((f) => (typeof f === 'string' ? f : f.field)));
	const labelOf = (f: string) =>
		fields.flatMap((c) => (typeof c !== 'string' && c.field === f ? [c.label] : []))[0] ??
		humanize(f);
	const catalog = $derived({ [LOCAL]: localExposure(of, names, labelOf) });
	const view = viewState(() => ctx, {
		key: () => key,
		model: () => LOCAL,
		catalog: () => catalog,
		initial_filter: () => undefined
	});
	let q = $state('');
	const shown = $derived(
		sortRows(
			view.rows.length === 0
				? searchRows(of, q, names)
				: searchRows(of, q, names).filter((r) =>
						matches(r, { t: 'group', join: 'and', of: view.rows }, view.clock)
					),
			view.order
		)
	);
	const exporter = $derived(
		toolbar !== false && toolbar.export === true
			? { fields: names, labels: names.map(labelOf), read: () => Effect.succeed(shown) }
			: undefined
	);

	const DOT = {
		neutral: 'bg-muted-foreground/60',
		info: 'bg-info',
		success: 'bg-success',
		warning: 'bg-warning',
		danger: 'bg-destructive'
	} as const;
	const dotOf = (lane: LocalLane) =>
		lane.dot !== undefined ? lane.dot : typeof lane.value === 'string' ? DOT[tone(lane.value)] : null;
	const interactive = (row: R) => on_open !== undefined && (can_open === undefined || can_open(row));
	const openCard = (row: R) => {
		if (expanded !== null) expanded = null;
		on_open?.(row);
	};

	let expanded = $state<string | null>(null);
	let laneSearch = $state('');
	let laneDialog = $state<HTMLDivElement | null>(null);
	let opener: HTMLElement | null = null;
	const expandedLane = $derived(
		lanes.find((lane) => JSON.stringify(lane.value) === expanded)
	);
	const expandedRows = $derived.by(() => {
		if (expandedLane === undefined) return [];
		const inLane = shown.filter((row) => row[by] === expandedLane.value);
		return laneSearch.trim() === '' ? inLane : searchRows(inLane, laneSearch, names);
	});
</script>

<!-- mirrors Board.svelte: fills a bounded parent; each lane scrolls inside itself -->
<section class="@container flex h-full min-h-72 min-w-0 flex-1 flex-col gap-2" data-view="board">
	<ViewToolbar
		{ctx}
		config={toolbar}
		model=""
		{view}
		{catalog}
		source={LOCAL}
		sortable={sortable(catalog[LOCAL], false, catalog)}
		bind:q
		searchable
		{exporter}
	/>
	{#if lanes.length === 0}
		<EmptyState variant="card" title={msg(words, 'view.empty')} />
	{:else}
		<div
			class={columns === undefined
				? 'flex min-h-0 flex-1 snap-x gap-3 overflow-x-auto pb-2'
				: 'grid min-h-0 flex-1 auto-rows-fr gap-3 overflow-auto pb-2'}
			style={columns === undefined
				? undefined
				: `grid-template-columns: repeat(${columns}, minmax(min(100%, 14rem), 1fr))`}
		>
			{#each lanes as lane (JSON.stringify(lane.value))}
				{@const laneKey = JSON.stringify(lane.value)}
				{@const dot = dotOf(lane)}
				{@const cards = shown.filter((row) => row[by] === lane.value)}
				<section
					aria-label={lane.label}
					class={[
						'group/lane flex min-h-0 flex-col gap-2 rounded-control border border-border-lane bg-surface-lane p-3 transition-colors motion-reduce:transition-none',
						columns === undefined ? 'w-72 shrink-0 snap-start' : 'min-w-0'
					]}
					data-lane={laneKey}
				>
					<header
						class="flex items-center justify-between gap-2 border-b pb-2 text-sm font-medium dark:border-b-0 dark:pb-0"
					>
						<span class="flex min-w-0 items-center gap-1.5">
							{#if dot}<span class={['size-2 shrink-0 rounded-full', dot]} aria-hidden="true"></span>{/if}
							<span class="truncate">{lane.label}</span>
							<span class="text-muted-foreground shrink-0 text-xs tabular-nums" data-lane-count
								>{cards.length}</span
							>
						</span>
						<span class="flex shrink-0 items-center gap-2">
							<Button
								size="icon"
								variant="ghost"
								class="-my-1.5 -mr-1.5 opacity-0 transition-opacity group-hover/lane:opacity-100 group-focus-within/lane:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
								hint={msg(words, 'board.expand', { lane: lane.label })}
								aria-label={msg(words, 'board.expand', { lane: lane.label })}
								onclick={(e) => {
									opener = e.currentTarget;
									laneSearch = '';
									expanded = laneKey;
								}}
								data-lane-expand={laneKey}><Glyph name="expand" class="size-3.5" /></Button
							>
						</span>
					</header>
					<div
						role="list"
						class="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1 [overflow-anchor:none]"
						data-lane-scroll
					>
						<LocalBoardLane {ctx} {lane} {cards} {card} {interactive} on_open={openCard} />
					</div>
				</section>
			{/each}
		</div>
	{/if}

	<Dialog.Root
		open={expandedLane !== undefined}
		on_open_change={(open) => {
			if (!open) expanded = null;
		}}
	>
		<Dialog.Content
			bind:ref={laneDialog}
			class="flex h-[min(90dvh,56rem)] max-w-[min(72rem,calc(100vw-2rem))] flex-col gap-0 overflow-hidden bg-background p-0 outline-none [--dialog-pad:0px]"
			on_open_auto_focus={(e) => {
				e.preventDefault();
				laneDialog?.focus({ preventScroll: true });
			}}
			on_close_auto_focus={(e) => {
				e.preventDefault();
				opener?.focus();
			}}
			data-lane-dialog={expanded}
		>
			{#if expandedLane !== undefined}
				{@const dot = dotOf(expandedLane)}
				<div class="flex min-h-0 flex-1 flex-col bg-surface-lane">
					<Dialog.Header class="flex-row items-center gap-3 border-b px-4 py-2 pr-12">
						<Dialog.Title class="flex min-w-0 items-center gap-1.5">
							{#if dot}<span class={['size-2 shrink-0 rounded-full', dot]} aria-hidden="true"></span>{/if}
							<span class="truncate">{expandedLane.label}</span>
							<span class="text-muted-foreground text-sm tabular-nums">{expandedRows.length}</span>
						</Dialog.Title>
						<div class="flex shrink-0 items-center gap-1" data-lane-toolbar>
							<ToolbarSearch bind:value={laneSearch} label={msg(words, 'table.search')} />
						</div>
					</Dialog.Header>
					<div class="min-h-0 flex-1 overflow-y-auto p-4 [overflow-anchor:none]" data-lane-scroll>
						<div
							role="list"
							class="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] content-start gap-3"
							data-lane-grid
						>
							<LocalBoardLane
								{ctx}
								lane={expandedLane}
								cards={expandedRows}
								{card}
								grid
								{interactive}
								on_open={openCard}
							/>
						</div>
					</div>
				</div>
			{/if}
		</Dialog.Content>
	</Dialog.Root>
</section>
