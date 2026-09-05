<script lang="ts">
	import type { Snippet } from 'svelte';
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
	$effect(() => {
		if (slot === null) return;
		slot.current = toolbar;
		return () => {
			slot.current = null;
		};
	});
</script>

{#snippet toolbar()}
	<div class:compact class="bolt-header-actions" role="toolbar" aria-label={label} aria-busy={busy}>
		{@render children()}
		{#if busy}
			<span class="status" role="status">Working…</span>
		{/if}
	</div>
{/snippet}

{#if slot === null}
	{@render toolbar()}
{/if}

<style>
	.bolt-header-actions {
		display: flex; /* repository-health:allow UI24 -- this teleported toolbar swaps gap and wrap in a 40rem media query and a compact variant; the primitives express neither a media query nor these off-scale gaps (0.75rem/0.375rem) */
		align-items: center;
		justify-content: flex-end;
		gap: 0.75rem;
		min-height: 2.5rem;
	}
	.bolt-header-actions.compact {
		gap: 0.375rem;
	}
	.status {
		color: var(--muted-foreground);
		font-size: 0.875rem;
	}
	@media (max-width: 40rem) {
		.bolt-header-actions {
			flex-wrap: wrap;
			justify-content: flex-start;
		}
	}
</style>
