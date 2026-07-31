<script lang="ts">
	import { scrollDocTocLinkIntoView } from './anchor-observer';
	import { getDocTocState } from './context.svelte';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import type { DocTocItem } from './types';

	let {
		item,
		scrollElement = null,
		onclick,
		class: className
	}: {
		item: DocTocItem;
		scrollElement?: HTMLDivElement | null;
		onclick?: () => void;
		class?: string;
	} = $props();

	const toc = getDocTocState()();
	const itemId = $derived(item.url.startsWith('#') ? item.url.slice(1) : null);

	let linkElement = $state<HTMLAnchorElement | null>(null);

	const active = $derived(
		itemId ? (toc.observedItems.find((entry) => entry.id === itemId)?.active ?? false) : false
	);

	// Watch raw deps — reading a local $derived from runed watch after unmount triggers derived_inert.
	watch(
		() => [itemId, toc.observedItems, linkElement, scrollElement] as const,
		([id, observed, link, container]) => {
			const isActive = id ? (observed.find((entry) => entry.id === id)?.active ?? false) : false;
			if (isActive && link && container) {
				scrollDocTocLinkIntoView(link, container);
			}
		}
	);
</script>

<a
	bind:this={linkElement}
	href={item.url}
	data-active={active}
	{onclick}
	class={cn(
		'doc-toc-link block scroll-m-4 py-1.5 text-sm wrap-anywhere text-muted-foreground transition-colors first:pt-0 last:pb-0 hover:text-foreground data-[active=true]:font-medium data-[active=true]:text-foreground',
		item.depth <= 2 && 'ps-3',
		item.depth === 3 && 'ps-6',
		item.depth >= 4 && 'ps-8',
		className
	)}
>
	{item.title}
</a>
