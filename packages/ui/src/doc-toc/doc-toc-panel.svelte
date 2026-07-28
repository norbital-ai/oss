<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import DocTocItem from './doc-toc-item.svelte';
	import DocTocItems from './doc-toc-items.svelte';
	import DocTocScrollArea from './doc-toc-scroll-area.svelte';
	import { getDocTocState } from './context.svelte';

	let {
		title = 'On this page',
		widthClass,
		class: className
	}: {
		title?: string;
		widthClass?: string;
		class?: string;
	} = $props();

	const toc = getDocTocState()();
	let scrollElement = $state<HTMLDivElement | null>(null);
</script>

{#if toc.items.length > 0}
	<aside
		class={cn(
			'sticky top-14 z-20 hidden h-[calc(100dvh-3.5rem)] min-w-0 shrink-0 self-start flex-col overflow-hidden pt-12 ps-4 pe-4 pb-2 xl:flex',
			widthClass ?? 'w-[268px]',
			className
		)}
	>
		<h3
			class="inline-flex items-center gap-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground uppercase"
		>
			<Icon icon="lucide:text" class="size-3.5 shrink-0" aria-hidden="true" />
			{title}
		</h3>
		<DocTocScrollArea bind:scrollElement>
			<DocTocItems>
				{#each toc.items as item (item.url)}
					<DocTocItem {item} {scrollElement} />
				{/each}
			</DocTocItems>
		</DocTocScrollArea>
	</aside>
{/if}
