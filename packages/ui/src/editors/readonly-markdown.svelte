<!--
@component
Renders Markdown text for reading. The Markdown parser loads with the first text shown, never with a page's startup:
until it arrives the text is plain and the block is `aria-busy`.
-->
<script lang="ts">
	// Markdown for reading (`MarkdownEditor readonly`, a preview, a stored document): the kit's typography, no raw HTML.
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../primitives/utils.js';
	import { markdown_html } from './markdown.js';

	// other attributes (`id`, `data-*`, `aria-*`) reach the rendered block
	let {
		value,
		breaks = false,
		class: className,
		...rest
	}: {
		/** The Markdown text; raw HTML is escaped and script-capable links neutered. */
		value: string;
		/** Each newline is a line break, as a person typed it (a chat message), not a soft wrap. */
		breaks?: boolean;
		/** Classes for the rendered block. */
		class?: string;
	} & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();
	const html = $derived(markdown_html(value, breaks));
</script>

<!-- markdown_html escapes raw HTML and neuters script-capable hrefs; busy until it can, so a print waits for the Markdown -->
<div
	{...rest}
	class={cn(
		// a wide table scrolls across inside itself; the page keeps the one vertical scroll
		'prose prose-sm max-w-none min-w-0 dark:prose-invert [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:[overflow-wrap:normal]',
		html === undefined && 'whitespace-pre-wrap',
		className
	)}
	aria-busy={html === undefined || undefined}
	data-markdown
>
	{#if html === undefined}{value}{:else}{@html html}{/if}
</div>
