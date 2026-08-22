<!-- fallow-ignore-file unrendered-component -- exported package TOC root rendered by website docs layouts -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { onMount, tick, type Snippet } from 'svelte';
	import DocTocPanel from './doc-toc-panel.svelte';
	import DocTocPopover from './doc-toc-popover.svelte';
	import { DocTocState, setDocTocState } from './context.svelte';
	import { buildDocTocRootMargin } from '#lib/doc-toc/anchor-observer';
	import { DEFAULT_DOC_TOC_HEADINGS, syncDocTocHeadings } from '#lib/doc-toc/sync-headings';

	let {
		children,
		before,
		after,
		headingSelector = DEFAULT_DOC_TOC_HEADINGS,
		title = 'On this page',
		class: frameClass,
		mainClass,
		articleClass = 'doc-content prose prose-lg max-w-none dark:prose-invert',
		asideWidthClass,
		asideClass,
		popoverClass,
		onSync
	}: {
		children: Snippet;
		before?: Snippet;
		after?: Snippet;
		headingSelector?: string;
		title?: string;
		class?: string;
		mainClass?: string;
		articleClass?: string;
		asideWidthClass?: string;
		asideClass?: string;
		popoverClass?: string;
		onSync?: () => void | Effect.Effect<void, unknown>;
	} = $props();

	const tocState = setDocTocState(new DocTocState());

	let articleElement = $state<HTMLElement | null>(null);
	let popoverOpen = $state(false);

	function syncArticle(article: HTMLElement, selector: string): void {
		tocState.setItems(syncDocTocHeadings(article, selector));
	}

	watch(
		() => [articleElement, headingSelector] as const,
		([article, selector]) => {
			if (!article) return;

			const sync = () => syncArticle(article, selector);
			sync();

			const observer = new MutationObserver(sync);
			observer.observe(article, { childList: true, subtree: true });
			return () => observer.disconnect();
		}
	);

	onMount(() => {
		tocState.observer.watch({
			rootMargin: buildDocTocRootMargin(),
			threshold: [0, 1]
		});
		return () => tocState.observer.unwatch();
	});

	export function refresh(): Effect.Effect<void, unknown> {
		return Effect.gen(function* () {
			popoverOpen = false;
			yield* Effect.promise(() => tick());
			if (articleElement) syncArticle(articleElement, headingSelector);
			const sync = onSync?.();
			if (sync) yield* sync;
		});
	}
</script>

<div class={cn('flex min-w-0 items-start overflow-x-clip', frameClass)}>
	<div class={cn('relative min-w-0 flex-1', mainClass)}>
		<DocTocPopover {title} class={popoverClass} bind:open={popoverOpen} />

		{#if before}
			{@render before()}
		{/if}

		<div bind:this={articleElement} class={articleClass}>
			{@render children()}
		</div>

		{#if after}
			{@render after()}
		{/if}
	</div>

	<DocTocPanel {title} widthClass={asideWidthClass} class={asideClass} />
</div>
