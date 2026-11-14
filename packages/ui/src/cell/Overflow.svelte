<!--
@component
A dense cell's value on one line of fixed height; when it is wider or taller than the cell, an expand button opens a
bounded, scrollable popover holding it whole: `full` when given, else `text` as plain text, else the value again.
`expand="never"` drops it: a table row's cells, since the row opens its record.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn, ui_text } from '../primitives/utils.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';

	let {
		text,
		children,
		full,
		expand = 'always'
	}: {
		/** The value as plain text, for the popover when `full` is absent. */
		text?: string;
		/** The value as the cell shows it. */
		children: Snippet;
		/** The whole value for the popover, when the cell shows a shorter preview of it. */
		full?: Snippet;
		/** `never` drops the expand button (default `always`). */
		expand?: 'always' | 'never';
	} = $props();
	const t = ui_text();
	let probe = $state<HTMLElement | null>(null);
	let overflow = $state(false);
	$effect(() => {
		void text;
		const el = probe;
		if (el === null) return;
		const check = () =>
			(overflow = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
		check();
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	});
</script>

<span class="flex max-w-full min-w-0 items-center gap-1">
	<span bind:this={probe} class="block max-h-7 min-w-0 flex-1 truncate [&_*]:whitespace-nowrap!"
		>{@render children()}</span
	>
	{#if overflow && expand !== 'never'}
		<Popover.Root>
			<Popover.Trigger
				class="text-muted-foreground hover:text-foreground grid size-5 shrink-0 place-items-center rounded-sm"
				aria-label={t('expand')}
				data-cell-expand
				onclick={(event: MouseEvent) => event.stopPropagation()}
			>
				<Glyph name="expand" class="size-3" />
			</Popover.Trigger>
			<Popover.Content
				align="start"
				class={cn(
					'max-h-[min(24rem,70vh)] w-[min(40rem,calc(100vw-2rem))] overflow-auto p-3',
					full === undefined && text !== undefined && 'text-xs break-words whitespace-pre-wrap'
				)}
			>
				{#if full}{@render full()}{:else if text !== undefined}{text}{:else}{@render children()}{/if}
			</Popover.Content>
		</Popover.Root>
	{/if}
</span>
