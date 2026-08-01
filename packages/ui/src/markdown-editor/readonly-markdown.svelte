<script lang="ts">
	import { marked } from 'marked';
	import { cn } from '#lib/utils';

	let {
		content,
		scale = 'document',
		class: className
	}: {
		content: string;
		/**
		 * `document` is editor typography — the scale a page of prose is written at.
		 *
		 * `reading` is for markdown that arrives inside the UI rather than as the page: a chat
		 * reply, a tool result, a preview pane. The document scale puts an `h2` at `text-3xl` under
		 * a full-width rule, which inside a chat pane is larger than the page title.
		 */
		scale?: 'document' | 'reading';
		class?: string;
	} = $props();

	const OPTIONS = { async: false, gfm: true, breaks: false } as const;

	/**
	 * Rendered one top-level block at a time, rather than one string for the whole document.
	 *
	 * `{@html}` has no way to patch — it assigns `innerHTML`, so it discards and rebuilds every node
	 * under it whenever its string changes. While a message is streaming that string changes on every
	 * chunk, so a single `{@html}` over the whole document rebuilds the entire transcript entry tens
	 * of times a second, and the browser re-lays-out and repaints all of it. The parse is not what
	 * costs (marked is well under a millisecond even at 14KB) — the DOM churn is.
	 *
	 * Splitting on the block tokens means an unchanged paragraph renders to a byte-identical string,
	 * Svelte's own `!==` check skips it, and only the block currently being written is rebuilt. Cost
	 * per chunk stops growing with the length of the message.
	 *
	 * Lexing the whole document (rather than lexing incrementally) is what keeps this correct:
	 * reference definitions and footnotes are resolved against the full token stream at lex time, so
	 * by the time a block is parsed on its own its links are already inlined.
	 */
	const blocks = $derived.by(() => {
		const trimmed = content.trim();
		if (!trimmed) return [] as string[];
		return marked
			.lexer(trimmed, OPTIONS)
			.map((token) => marked.parser([token], OPTIONS))
			.filter((html): html is string => typeof html === 'string' && html !== '');
	});
</script>

<div
	class={cn(
		'tiptap min-w-0 max-w-full outline-none',
		scale === 'reading' && 'tiptap-reading',
		className
	)}
>
	{#each blocks as html, index (index)}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html html}
	{/each}
</div>
