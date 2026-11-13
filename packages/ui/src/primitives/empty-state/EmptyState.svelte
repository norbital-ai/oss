<!--
@component
A view's empty, no-access or failed state: an icon, a title, a hint and the way forward. `size="fill"` centres it in the
space left in its parent.
-->
<script lang="ts">
	// Variants share compact content sizing; inset uses the surrounding view's card.
	import type { Snippet } from 'svelte';
	import { SIZE_CLASSES, type LayoutSize } from '../../layout/layout.shared.js';
	import Glyph, { type GlyphName } from '../icon/Glyph.svelte';

	let {
		title,
		hint,
		icon = 'inbox',
		tone = 'muted',
		variant = 'page',
		size = 'content',
		children,
		read = 'empty'
	}: {
		/** The heading: what is empty or what went wrong. */
		title: string;
		/** A line below the title: why, or what to do. */
		hint?: string;
		/** The glyph above the title; default `inbox`. */
		icon?: GlyphName;
		/** `danger` colours it destructive and announces it as an alert (else a status). */
		tone?: 'muted' | 'danger';
		/** `card` draws its own bordered card; `page` and `inset` sit on the surrounding surface. */
		variant?: 'page' | 'inset' | 'card';
		/** `fill` centres it in the space left in its parent; default `content` (at least 12rem tall). */
		size?: LayoutSize;
		/** The way forward: actions centred below the hint. */
		children?: Snippet;
		/** The `data-read` state it reports to readers and tests; default `empty`. */
		read?: string;
	} = $props();
	const danger = $derived(tone === 'danger');
</script>

<div
	role={danger ? 'alert' : 'status'}
	data-read={read}
	data-empty={variant}
	class={[
		'flex min-w-0 flex-col items-center justify-center gap-1.5 p-4 text-center',
		size === 'fill' ? SIZE_CLASSES.fill : 'min-h-48',
		variant === 'card' && 'bg-card rounded-md border'
	]}
>
	<Glyph name={icon} class={danger ? 'text-destructive size-6' : 'text-muted-foreground size-6'} />
	<h3 class={['max-w-md text-sm font-medium break-words', danger && 'text-destructive']}>
		{title}
	</h3>
	{#if hint}<p class="text-meta max-w-md break-words">{hint}</p>{/if}
	{#if children}<div class="mt-2 flex flex-wrap items-center justify-center gap-2">
			{@render children()}
		</div>{/if}
</div>
