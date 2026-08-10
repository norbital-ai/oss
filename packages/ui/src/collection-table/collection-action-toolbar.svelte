<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Cluster, Inline, Scroll } from '#lib/layout';

	let {
		view,
		actions
	}: {
		/** The view-owned controls: title, search, filters, dates, or grouping. */
		view?: Snippet;
		/** Mutating or refresh actions kept at the trailing edge. */
		actions?: Snippet;
	} = $props();
</script>

<Cluster gap="sm" align="center" justify={view ? 'between' : 'end'} data-collection-action-toolbar>
	{#if view}
		<Scroll axis="x" name="Collection view controls" grow class="min-w-0">
			<Inline gap="sm" fill class="min-w-0">{@render view()}</Inline>
		</Scroll>
	{/if}
	{#if actions}
		<Inline gap="xs" shrink={false}>{@render actions()}</Inline>
	{/if}
</Cluster>
