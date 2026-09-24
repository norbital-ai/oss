<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy, onMount } from 'svelte';
	import { Cluster } from '@norbital-ai/ui/layout';
	import { getAppHeaderActionsSlot } from './app-header-actions.svelte.js';

	let {
		children,
		label = 'Page actions',
		busy = false,
		compact = false
	}: {
		children: Snippet;
		label?: string;
		busy?: boolean;
		compact?: boolean;
	} = $props();

	// Rendering here would put a second bar between the app banner and the page's own tabs, which is
	// exactly what the slot exists to avoid. With a shell above, the controls travel up into the
	// banner; standalone — a test, a story — they render where they stand.
	const slot = getAppHeaderActionsSlot();
	onMount(() => {
		if (slot !== null) slot.current = toolbar;
	});
	onDestroy(() => {
		if (slot !== null) slot.current = null;
	});
</script>

{#snippet toolbar()}
	<Cluster
		gap={compact ? 'xs' : 'sm'}
		justify="end"
		class="min-h-10"
		role="toolbar"
		aria-label={label}
		aria-busy={busy}
	>
		{@render children()}
		{#if busy}
			<span class="text-sm text-muted-foreground" role="status">Working…</span>
		{/if}
	</Cluster>
{/snippet}

{#if slot === null}
	{@render toolbar()}
{/if}
