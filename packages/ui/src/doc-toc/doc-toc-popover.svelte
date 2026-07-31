<script lang="ts">
	import * as Collapsible from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import { Inline } from '#lib/layout';
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { findLastActiveDocTocIndex, getActiveDocTocItem } from './anchor-observer';
	import DocTocItem from './doc-toc-item.svelte';
	import DocTocItems from './doc-toc-items.svelte';
	import DocTocProgressRing from './doc-toc-progress-ring.svelte';
	import DocTocScrollArea from './doc-toc-scroll-area.svelte';
	import { getDocTocState } from './context.svelte';

	let {
		title = 'On this page',
		open = $bindable(false),
		class: className
	}: {
		title?: string;
		open?: boolean;
		class?: string;
	} = $props();

	const toc = getDocTocState()();

	let popoverElement = $state<HTMLElement | null>(null);
	let scrollElement = $state<HTMLDivElement | null>(null);

	const activeItem = $derived(getActiveDocTocItem(toc.observedItems));
	const activeLabel = $derived(activeItem?.original.title ?? toc.items[0]?.title ?? title);
	const progress = $derived(
		(findLastActiveDocTocIndex(toc.observedItems) + 1) / Math.max(toc.items.length, 1)
	);

	onMount(() => {
		const onClick = (event: MouseEvent) => {
			if (!open || !(event.target instanceof Node) || popoverElement?.contains(event.target))
				return;
			open = false;
		};

		document.addEventListener('click', onClick);
		return () => document.removeEventListener('click', onClick);
	});
</script>

{#if toc.items.length > 0}
	<div
		bind:this={popoverElement}
		class={cn('pointer-events-none absolute inset-0 z-40 xl:hidden', className)}
	>
		<div
			class="sticky top-0 flex h-dvh items-end justify-end p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pe-[max(1rem,env(safe-area-inset-right))]"
		>
			<Collapsible.Root
				bind:open
				class="pointer-events-auto flex w-[min(20rem,calc(100%-0.5rem))] flex-col-reverse items-end gap-2"
			>
				<Collapsible.Trigger
					class={cn(
						'inline-flex h-11 items-center gap-2 rounded-full border border-border bg-background/95 px-3.5 text-sm font-medium text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted/60',
						open && 'bg-muted/60'
					)}
					aria-label={open ? `Close ${title}` : `Open ${title}`}
				>
					<DocTocProgressRing value={progress} class={open ? 'text-primary' : undefined} />
					<span class="max-w-[10rem] truncate">{open ? title : activeLabel}</span>
					<Icon
						icon="lucide:chevron-up"
						class={cn(
							'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
							open && 'rotate-180'
						)}
					/>
				</Collapsible.Trigger>

				<Collapsible.Content class="w-full">
					<!-- stupidity:allow UI5 -- popover content boundary -->
					<div
						class="w-full overflow-hidden rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur-sm"
					>
						<Inline justify="between" gap="sm" class="border-b border-border/60 px-3 py-2.5">
							<p class="text-micro font-semibold tracking-[0.08em] text-muted-foreground uppercase">
								{title}
							</p>
							<span class="truncate text-xs text-muted-foreground">{activeLabel}</span>
						</Inline>
						<!-- stupidity:allow UI5 -- popover content boundary -->
						<div class="max-h-[min(50dvh,20rem)] overflow-hidden">
							<DocTocScrollArea bind:scrollElement class="max-h-[min(50dvh,20rem)] px-3 pt-2 pb-3">
								<DocTocItems>
									{#each toc.items as item (item.url)}
										<DocTocItem {item} {scrollElement} onclick={() => (open = false)} />
									{/each}
								</DocTocItems>
							</DocTocScrollArea>
						</div>
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
		</div>
	</div>
{/if}
