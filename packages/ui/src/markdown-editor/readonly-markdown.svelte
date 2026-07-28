<script lang="ts">
	import { marked } from 'marked';
	import { cn } from '#lib/utils';

	let {
		content,
		class: className
	}: {
		content: string;
		class?: string;
	} = $props();

	const renderedHtml = $derived.by(() => {
		const trimmed = content.trim();
		if (!trimmed) return '';
		const parsed = marked.parse(trimmed, { async: false, gfm: true, breaks: false });
		return typeof parsed === 'string' ? parsed : '';
	});
</script>

<div class={cn('tiptap min-w-0 max-w-full outline-none', className)}>{@html renderedHtml}</div>
