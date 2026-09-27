<script lang="ts">
	// A view's empty, no-access or failed state, staging's two shapes: `page` (staging's `Empty`: a round icon well, a
	// section title, a hint, the way forward) and the grid's compact one — `inset` fills the view's own card (a table, a
	// list), `card` brings a card of its own (a read gate, a board).
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from './Glyph.svelte';

	let { title, hint, icon = 'inbox', tone = 'muted', variant = 'page', children, read = 'empty' }: {
		title: string; hint?: string; icon?: GlyphName; tone?: 'muted' | 'danger'; variant?: 'page' | 'inset' | 'card'; children?: Snippet; read?: string;
	} = $props();
	const danger = $derived(tone === 'danger');
</script>

<div role={danger ? 'alert' : 'status'} data-read={read} data-empty={variant}
	class={['flex min-w-0 flex-col items-center justify-center text-center', variant === 'page' ? 'gap-4 p-8' : 'min-h-48 flex-1 gap-1.5 p-4',
		variant === 'card' && 'bg-card rounded-md border']}>
	{#if variant === 'page'}
		<div class="bg-muted grid size-20 shrink-0 place-items-center rounded-full">
			<Glyph name={icon} class={danger ? 'text-destructive size-12' : 'text-muted-foreground size-12'} />
		</div>
		<div class="flex flex-col gap-2">
			<h3 class={['text-section', danger && 'text-destructive']}>{title}</h3>
			{#if hint}<p class="text-muted-foreground max-w-md text-sm break-words">{hint}</p>{/if}
		</div>
		{#if children}<div class="flex flex-wrap items-center justify-center gap-2">{@render children()}</div>{/if}
	{:else}
		<Glyph name={icon} class={danger ? 'text-destructive size-6' : 'text-muted-foreground size-6'} />
		<p class={['text-sm font-medium', danger && 'text-destructive']}>{title}</p>
		{#if hint}<p class="text-meta max-w-md break-words">{hint}</p>{/if}
		{#if children}<div class="mt-2 flex flex-wrap items-center justify-center gap-2">{@render children()}</div>{/if}
	{/if}
</div>
