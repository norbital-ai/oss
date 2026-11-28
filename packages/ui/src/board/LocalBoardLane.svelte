<script lang="ts" generics="R extends Values = Row">
	import type { Snippet } from 'svelte';
	import type { UiContext } from '../client/contract.js';
	import type { Row, Values } from '../model/types.js';
	import { virtual_list } from '../primitives/virtual/virtual.svelte.js';
	import BoardEmptyLane from './BoardEmptyLane.svelte';
	import type { LocalLane } from './LocalBoard.svelte';

	let {
		ctx,
		lane,
		cards,
		card,
		grid = false,
		interactive,
		on_open
	}: {
		ctx: UiContext;
		lane: LocalLane;
		cards: readonly R[];
		card: Snippet<[{ row: R; lane: LocalLane }]>;
		grid?: boolean;
		interactive: (row: R) => boolean;
		on_open: (row: R) => void;
	} = $props();

	const idOf = (row: R, fallback: number): string =>
		typeof row['id'] === 'string' && row['id'] !== '' ? row['id'] : String(fallback);

	let gridWidth = $state(0);

	const laneWin = virtual_list({
		count: () => (grid ? 0 : cards.length),
		key: (i) => {
			const row = cards[i];
			return row === undefined ? String(i) : idOf(row, i);
		},
		estimate: 76,
		gap: 8,
		threshold: 25,
		overscan: 6
	});

	const GRID_VIRTUAL_THRESHOLD = 36;
	const GRID_MIN_CARD_PX = 256;
	const GRID_GAP_PX = 12;
	const virtualGridOn = $derived(grid && cards.length > GRID_VIRTUAL_THRESHOLD && gridWidth > 0);
	const gridCols = $derived(
		virtualGridOn
			? Math.max(1, Math.floor((gridWidth + GRID_GAP_PX) / (GRID_MIN_CARD_PX + GRID_GAP_PX)))
			: 1
	);
	const gridRows = $derived.by<readonly (readonly { row: R; index: number }[])[]>(() => {
		if (!virtualGridOn) return [];
		const out: { row: R; index: number }[][] = [];
		for (let i = 0; i < cards.length; i += gridCols) {
			const group: { row: R; index: number }[] = [];
			for (let j = i; j < Math.min(cards.length, i + gridCols); j++) {
				const row = cards[j];
				if (row !== undefined) group.push({ row, index: j });
			}
			out.push(group);
		}
		return out;
	});
	const gridWin = virtual_list({
		count: () => gridRows.length,
		key: (r) => {
			const first = gridRows[r]?.[0];
			return first === undefined ? String(r) : idOf(first.row, first.index);
		},
		estimate: 108,
		gap: GRID_GAP_PX,
		threshold: 0,
		overscan: 5
	});

	const measureGridParent = (el: HTMLElement) => {
		if (!grid || typeof ResizeObserver === 'undefined') return;
		const parent = el.parentElement;
		if (parent === null) return;
		const syncWidth = () => {
			const w = parent.clientWidth;
			if (w > 0 && w !== gridWidth) gridWidth = w;
		};
		syncWidth();
		const ro = new ResizeObserver(syncWidth);
		ro.observe(parent);
		return () => ro.disconnect();
	};
</script>

{#snippet renderCard(row: R, index: number, attachMeasure: boolean)}
	{@const rowId = idOf(row, index)}
	{@const clickable = interactive(row)}
	{#if clickable}
		<div
			role="listitem"
			class={grid ? 'contents' : 'mb-2'}
			{@attach attachMeasure ? laneWin.measure(rowId) : () => {}}
		>
			<button
				type="button"
				class={[
					'group bg-surface-raised text-card-foreground hover:border-border-control relative flex w-full cursor-pointer flex-col gap-1 overflow-clip rounded-control border text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none',
					grid ? 'min-h-24 p-3' : 'p-2.5'
				]}
				data-board-card={rowId}
				onclick={() => on_open(row)}
			>
				{@render card({ row, lane })}
			</button>
		</div>
	{:else}
		<div
			role="listitem"
			class={[
				'group bg-surface-raised text-card-foreground relative flex w-full flex-col gap-1 overflow-clip rounded-control border text-left text-sm',
				grid ? 'min-h-24 p-3' : 'mb-2 p-2.5'
			]}
			data-board-card={rowId}
			{@attach attachMeasure ? laneWin.measure(rowId) : () => {}}
		>
			{@render card({ row, lane })}
		</div>
	{/if}
{/snippet}

<span hidden {@attach measureGridParent}></span>
{#if cards.length === 0}
	<BoardEmptyLane {ctx} {grid} />
{:else if virtualGridOn}
	<div class="col-span-full -mb-3 flex flex-col">
		<div aria-hidden="true" style:height="{gridWin.before}px" {@attach gridWin.anchor}></div>
		{#each gridWin.slice(gridRows) as rowGroup (rowGroup[0] === undefined ? '' : idOf(rowGroup[0].row, rowGroup[0].index))}
			{@const rowKey = rowGroup[0] === undefined ? '' : idOf(rowGroup[0].row, rowGroup[0].index)}
			<div
				class="mb-3 grid gap-3"
				style:grid-template-columns="repeat({gridCols}, minmax(0, 1fr))"
				{@attach gridWin.measure(rowKey)}
			>
				{#each rowGroup as item (idOf(item.row, item.index))}
					{@render renderCard(item.row, item.index, false)}
				{/each}
			</div>
		{/each}
		{#if gridWin.after > 0}
			<div aria-hidden="true" style:height="{gridWin.after}px"></div>
		{/if}
	</div>
{:else if grid}
	{#each cards as row, index (idOf(row, index))}
		{@render renderCard(row, index, false)}
	{/each}
{:else}
	<div class="-mb-2 flex flex-col">
		{#if laneWin.on}<div
				aria-hidden="true"
				style:height="{laneWin.before}px"
				{@attach laneWin.anchor}
			></div>{/if}
		{#each laneWin.slice(cards) as row, j (idOf(row, laneWin.start + j))}
			{@render renderCard(row, laneWin.start + j, laneWin.on)}
		{/each}
		{#if laneWin.on && laneWin.after > 0}<div
				aria-hidden="true"
				style:height="{laneWin.after}px"
			></div>{/if}
	</div>
{/if}
