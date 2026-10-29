<!--
@component
A dense cell's value on one line of fixed height; when it is wider or taller than the cell, an expand button opens a
bounded, scrollable popover holding it whole: `full` when given, else `text` as plain text, else the value again.
`expand="row"` shows that button only while its table row (`group/row`) is hovered or holds focus; `"never"` drops it
(a row's title cell, whose row opens the record).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';

	let {
		text,
		class: className,
		children,
		full,
		expand = 'always'
	}: {
		text?: string;
		class?: string;
		children: Snippet;
		/** The whole value for the popover, when the cell shows a shorter preview of it. */
		full?: Snippet;
		expand?: 'always' | 'row' | 'never';
	} = $props();
	const t = uiText();
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

<span class={cn('flex max-w-full min-w-0 items-center gap-1', className)}>
	<span bind:this={probe} class="block max-h-7 min-w-0 flex-1 truncate [&_*]:whitespace-nowrap!"
		>{@render children()}</span
	>
	{#if overflow && expand !== 'never'}
		<Popover.Root>
			<Popover.Trigger
				class={cn(
					'text-muted-foreground hover:text-foreground grid size-5 shrink-0 place-items-center rounded-sm',
					expand === 'row' &&
						'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100'
				)}
				aria-label={t('expand')}
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
