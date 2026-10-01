<!--
@component
A view's empty, no-access or failed state: an icon, a title, a hint and the way forward.
-->
<script lang="ts">
	// Variants share compact content sizing; inset uses the surrounding view's card.
	import type { Snippet } from 'svelte';
	import Glyph, { type GlyphName } from './Glyph.svelte';

	let { title, hint, icon = 'inbox', tone = 'muted', variant = 'page', children, read = 'empty' }: {
		title: string; hint?: string; icon?: GlyphName; tone?: 'muted' | 'danger'; variant?: 'page' | 'inset' | 'card'; children?: Snippet; read?: string;
	} = $props();
	const danger = $derived(tone === 'danger');
</script>

<div role={danger ? 'alert' : 'status'} data-read={read} data-empty={variant}
	class={['flex min-h-48 min-w-0 flex-col items-center justify-center gap-1.5 p-4 text-center',
		variant === 'card' && 'bg-card rounded-md border']}>
	<Glyph name={icon} class={danger ? 'text-destructive size-6' : 'text-muted-foreground size-6'} />
	<h3 class={['max-w-md text-sm font-medium break-words', danger && 'text-destructive']}>{title}</h3>
	{#if hint}<p class="text-meta max-w-md break-words">{hint}</p>{/if}
	{#if children}<div class="mt-2 flex flex-wrap items-center justify-center gap-2">{@render children()}</div>{/if}
</div>
