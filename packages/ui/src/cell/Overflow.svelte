<!--
@component
A dense cell's text on one line; when it is wider than the cell, the cell becomes a bounded, scrollable popover
holding the full text.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';

	let {
		text,
		class: className,
		children
	}: {
		text: string;
		class?: string;
		children: Snippet;
	} = $props();
	const t = uiText();
	let probe = $state<HTMLElement | null>(null);
	let overflow = $state(false);
	$effect(() => {
		void text;
		const el = probe;
		if (el === null) return;
		const check = () => (overflow = el.scrollWidth > el.clientWidth + 1);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

{#if overflow}
	<Popover.Root>
		<Popover.Trigger
			class={cn('flex max-w-full min-w-0 items-center gap-1 text-left text-inherit', className)}
			aria-label={t('expand')}
			onclick={(event: MouseEvent) => event.stopPropagation()}
		>
			<span bind:this={probe} class="min-w-0 truncate">{@render children()}</span>
			<Glyph name="expand" class="text-muted-foreground size-3 shrink-0" />
		</Popover.Trigger>
		<Popover.Content
			align="start"
			class="max-h-[min(24rem,70vh)] w-[min(40rem,calc(100vw-2rem))] overflow-auto p-3 text-xs break-words whitespace-pre-wrap"
		>
			{text}
		</Popover.Content>
	</Popover.Root>
{:else}
	<span bind:this={probe} class={cn('block min-w-0 truncate', className)}>{@render children()}</span
	>
{/if}
