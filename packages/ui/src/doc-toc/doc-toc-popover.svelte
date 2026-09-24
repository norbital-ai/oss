<script lang="ts">
	import * as Collapsible from '#lib/collapsible';
	import { cn } from '#lib/utils';
	import { Imposter, Inline, Stack } from '#lib/layout';
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { findLastActiveIndex, getActiveDocTocItem } from '#lib/doc-toc/anchor-observer';
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
		(findLastActiveIndex(toc.observedItems) + 1) / Math.max(toc.items.length, 1)
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
	<Imposter placement="fill" layer="overlay" class={cn('pointer-events-none lg:hidden', className)}>
		<!-- The trigger stays pinned to the viewport while the article scrolls. -->
		<Imposter position="sticky" placement="top" class="h-dvh">
			<Stack
				align="end"
				justify="end"
				fill
				class="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pe-[max(1rem,env(safe-area-inset-right))]"
			>
				<!-- Reversed: the trigger stays first in tab order and pinned to the bottom edge while the
				     panel grows upward. -->
				<Collapsible.Root bind:open bind:ref={popoverElement}>
					{#snippet child({ props })}
						<Stack
							{...props}
							reverse
							gap="sm"
							align="end"
							class="pointer-events-auto w-80 max-w-[calc(100%-0.5rem)]"
						>
							<Collapsible.Trigger
								class={cn(
									'h-11 rounded-full border border-border bg-background/95 px-3.5 text-sm font-medium text-foreground shadow-lg backdrop-blur-sm transition-colors hover:bg-muted/60',
									open && 'bg-muted/60'
								)}
								aria-label={open ? `Close ${title}` : `Open ${title}`}
							>
								<Inline as="span">
									<DocTocProgressRing value={progress} class={open ? 'text-primary' : undefined} />
									<span class="max-w-[10rem] truncate">{open ? title : activeLabel}</span>
									<Icon
										icon="lucide:chevron-up"
										class={cn(
											'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
											open && 'rotate-180'
										)}
									/>
								</Inline>
							</Collapsible.Trigger>

							<Collapsible.Content class="w-full">
								<div
									class="w-full overflow-clip rounded-xl border border-border bg-background/95 shadow-lg backdrop-blur-sm"
								>
									<Inline justify="between" gap="sm" class="border-b border-border/60 px-3 py-2.5">
										<p class="text-overline">
											{title}
										</p>
										<span class="truncate text-meta">{activeLabel}</span>
									</Inline>
									<DocTocScrollArea
										bind:scrollElement
										class="max-h-[min(50dvh,20rem)] px-3 pt-2 pb-3"
									>
										<DocTocItems>
											{#each toc.items as item (item.url)}
												<DocTocItem {item} {scrollElement} onclick={() => (open = false)} />
											{/each}
										</DocTocItems>
									</DocTocScrollArea>
								</div>
							</Collapsible.Content>
						</Stack>
					{/snippet}
				</Collapsible.Root>
			</Stack>
		</Imposter>
	</Imposter>
{/if}
