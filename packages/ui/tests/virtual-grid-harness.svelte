<script lang="ts">
	import { virtual_grid, type VirtualRange } from '../src/primitives/virtual/virtual.svelte.js';

	let {
		rowCount,
		colCount,
		onRowRange
	}: {
		rowCount: number;
		colCount: number;
		onRowRange?: (range: VirtualRange) => void;
	} = $props();

	const rows = $derived(Array.from({ length: rowCount }, (_, i) => `r-${i}`));
	const cols = $derived(Array.from({ length: colCount }, (_, i) => `c-${i}`));

	const grid = virtual_grid({
		rows: {
			count: () => rows.length,
			key: (i) => rows[i] ?? String(i),
			size: 40,
			threshold: 10,
			overscan: 3,
			on_range: (range) => onRowRange?.(range)
		},
		cols: {
			count: () => cols.length,
			key: (i) => cols[i] ?? String(i),
			size: 80,
			threshold: 6,
			overscan: 2
		}
	});
</script>

<div data-grid-port style="overflow: auto; width: 320px; height: 200px">
	<div style="display: flex">
		{#if grid.cols.on}
			<div
				data-col-anchor
				aria-hidden="true"
				{@attach grid.cols.anchor}
				style:width="{grid.cols.before}px"
			></div>
		{/if}
		{#each grid.cols.slice(cols) as col (col)}
			<div data-col={col} style="width: 80px">{col}</div>
		{/each}
		{#if grid.cols.on && grid.cols.after > 0}
			<div data-col-after aria-hidden="true" style:width="{grid.cols.after}px"></div>
		{/if}
	</div>
	{#if grid.rows.on}
		<div
			data-row-anchor
			aria-hidden="true"
			{@attach grid.rows.anchor}
			style:height="{grid.rows.before}px"
		></div>
	{/if}
	{#each grid.rows.slice(rows) as row (row)}
		<div data-row={row} style="height: 40px">{row}</div>
	{/each}
	{#if grid.rows.on && grid.rows.after > 0}
		<div data-row-after aria-hidden="true" style:height="{grid.rows.after}px"></div>
	{/if}
</div>
