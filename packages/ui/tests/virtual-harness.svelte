<script lang="ts">
	import { virtual_list } from '../src/primitives/virtual/virtual.svelte.js';

	let { items }: { items: readonly string[] } = $props();

	const win = virtual_list({
		count: () => items.length,
		key: (i) => items[i] ?? String(i),
		estimate: 40,
		threshold: 20,
		overscan: 4
	});
</script>

<div data-port style="overflow-y: auto; height: 200px">
	{#if win.on}
		<div data-anchor aria-hidden="true" {@attach win.anchor} style:height="{win.before}px"></div>
	{/if}
	{#each win.slice(items) as id (id)}
		<div data-row={id} {@attach win.measure(id)} style="height: 40px">{id}</div>
	{/each}
	{#if win.on && win.after > 0}
		<div data-after aria-hidden="true" style:height="{win.after}px"></div>
	{/if}
</div>
