<script lang="ts">
	import type { FinderRow } from '../../src/client/ui/finder/finder-entity.js';
	let {
		query = $bindable(''),
		items,
		onQueryInput
	}: {
		query?: string;
		items: readonly FinderRow[];
		onQueryInput?: (query: string) => void;
	} = $props();
</script>

<input
	data-command-input
	bind:value={query}
	oninput={(event) => onQueryInput?.(event.currentTarget.value)}
/>
{#each items as item (item.value)}
	<div data-value={item.value}>{item.label ?? ''}</div>
{/each}
