<!--
@component
Renders Markdown text for reading.
-->
<script lang="ts">
	// Markdown for reading (`MarkdownEditor readonly`, a preview, a stored document): the kit's typography, no raw HTML.
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../primitives/utils.js';
	import { markdown_html } from './markdown.js';

	// other attributes (`id`, `data-*`, `aria-*`) reach the rendered block
	let {
		value,
		class: className,
		...rest
	}: {
		/** The Markdown text; raw HTML is escaped and script-capable links neutered. */
		value: string;
		/** Classes for the rendered block. */
		class?: string;
	} & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();
</script>

<!-- markdown_html escapes raw HTML and neuters script-capable hrefs -->
<div
	{...rest}
	class={cn(
		'prose prose-sm max-w-none min-w-0 dark:prose-invert [overflow-wrap:anywhere] [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere]',
		className
	)}
	data-markdown
>
	{@html markdown_html(value)}
</div>
