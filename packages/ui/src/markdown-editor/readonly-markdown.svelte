<script lang="ts">
	import { Marked, type Tokens } from 'marked';
	import { onMount } from 'svelte';
	import { cn } from '#lib/utils';

	type MarkdownHrefKind = 'link' | 'image';

	const OPTIONS = { async: false, gfm: true, breaks: false } as const;

	const escapeHtml = (value: string): string =>
		value.replace(
			/[&<>"']/g,
			(character) =>
				({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
				character
		);

	const headingSlug = (value: string): string =>
		value
			.trim()
			.toLowerCase()
			.replace(/[`*_~]/g, '')
			.replace(/[^\p{L}\p{N}\s-]/gu, '')
			.replace(/\s+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '');

	let {
		content,
		scale = 'document',
		anchorHeadings = false,
		allowHtml = true,
		externalLinksNewTab = false,
		resolveHref,
		onlink,
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
		scale?: 'document' | 'documentation' | 'reading';
		/** Add stable ids and self-links to headings for long-form documentation. */
		anchorHeadings?: boolean;
		/** Raw HTML remains enabled for existing editor/chat consumers; documentation can refuse it. */
		allowHtml?: boolean;
		externalLinksNewTab?: boolean;
		resolveHref?: (href: string, kind: MarkdownHrefKind) => string | null;
		onlink?: (href: string, event: MouseEvent) => void;
		class?: string;
	} = $props();

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

		const usedHeadingIds = new Map<string, number>();
		const markdown = new Marked({
			renderer: {
				html(token) {
					return allowHtml ? token.text : escapeHtml(token.text);
				},
				heading(token: Tokens.Heading) {
					const text = this.parser.parseInline(token.tokens);
					if (!anchorHeadings) return `<h${token.depth}>${text}</h${token.depth}>\n`;
					const base = headingSlug(token.text) || `heading-${token.depth}`;
					const occurrence = usedHeadingIds.get(base) ?? 0;
					usedHeadingIds.set(base, occurrence + 1);
					const id = occurrence === 0 ? base : `${base}-${occurrence}`;
					return `<h${token.depth} id="${id}"><a href="#${id}">${text}</a></h${token.depth}>\n`;
				},
				link(token: Tokens.Link) {
					const href = resolveHref ? resolveHref(token.href, 'link') : token.href;
					if (href === null) return this.parser.parseInline(token.tokens);
					const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
					const external = externalLinksNewTab && /^https?:\/\//i.test(href);
					const target = external ? ' target="_blank" rel="noreferrer"' : '';
					return `<a href="${escapeHtml(href)}"${title}${target}>${this.parser.parseInline(token.tokens)}</a>`;
				},
				image(token: Tokens.Image) {
					const src = resolveHref ? resolveHref(token.href, 'image') : token.href;
					if (src === null) return '';
					const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
					return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title} loading="lazy" />`;
				}
			}
		});
		return markdown
			.lexer(trimmed, OPTIONS)
			.map((token) => markdown.parser([token], OPTIONS))
			.filter((html) => html !== '');
	});
	let rootElement = $state<HTMLDivElement | null>(null);

	function handleClick(event: MouseEvent): void {
		if (!(event.target instanceof Element)) return;
		const link = event.target.closest<HTMLAnchorElement>('a[href]');
		const href = link?.getAttribute('href');
		if (href != null) onlink?.(href, event);
	}

	onMount(() => {
		const root = rootElement;
		if (root === null) return;
		root.addEventListener('click', handleClick);
		return () => root.removeEventListener('click', handleClick);
	});
</script>

<div
	bind:this={rootElement}
	class={cn(
		'tiptap min-w-0 max-w-full outline-none',
		scale === 'documentation' && 'tiptap-documentation',
		scale === 'reading' && 'tiptap-reading',
		className
	)}
>
	{#each blocks as html, index (index)}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html html}
	{/each}
</div>
