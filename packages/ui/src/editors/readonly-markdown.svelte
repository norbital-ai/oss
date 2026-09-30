<!--
@component
Renders Markdown text for reading.
-->
<script lang="ts">
	// Markdown for reading (`MarkdownEditor readonly`, a preview, a stored document): the kit's typography, no raw HTML.
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../primitives/utils.js';
	import { markdownHtml } from './markdown.js';

	// other attributes (`id`, `data-*`, `aria-*`) reach the rendered block
	let { value, class: className, ...rest }: { value: string; class?: string } & Omit<HTMLAttributes<HTMLDivElement>, 'class'> = $props();
</script>

<!-- markdownHtml escapes raw HTML and neuters script-capable hrefs -->
<div {...rest} class={cn('prose prose-sm max-w-none min-w-0 dark:prose-invert [overflow-wrap:anywhere]', className)} data-markdown>{@html markdownHtml(value)}</div>
