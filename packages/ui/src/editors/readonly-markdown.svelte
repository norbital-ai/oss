<!--
@component
Renders Markdown text for reading.
-->
<script lang="ts">
	// Markdown for reading (`MarkdownEditor readonly`, a preview, a stored document): the kit's typography, no raw HTML.
	import { cn } from '../primitives/utils.js';
	import { markdownHtml } from './markdown.js';

	let { value, class: className }: { value: string; class?: string } = $props();
</script>

<!-- markdownHtml escapes raw HTML and neuters script-capable hrefs -->
<div class={cn('prose prose-sm max-w-none min-w-0 dark:prose-invert [overflow-wrap:anywhere]', className)} data-markdown>{@html markdownHtml(value)}</div>
