<script lang="ts">
	import { cn } from '#lib/utils';
	import { createVirtualizer } from '#lib/utils/virtualizer.svelte';
	import { watch } from 'runed';
	import { getCommandState } from './command-state.svelte.js';
	import type { CommandItemData, CommandListProps } from '#lib/command/types';

	let {
		ref = $bindable(null),
		class: className,
		children,
		itemHeight = 52,
		overscan = 5,
		gap = 4,
		itemSnippet,
		placeholderSnippet,
		loadMoreThreshold = 5,
		// Data fetching configs
		clientConfig,
		serverConfig,
		infiniteLoading,
		...restProps
	}: CommandListProps = $props();

	// Get command state from context
	const commandState = getCommandState()();

	// Infinite loading: effective count and hasMore.
	// `total` is an estimate and may undershoot (or be stale); never render fewer
	// rows than are actually loaded.
	const effectiveCount = $derived(
		infiniteLoading
			? Math.max(infiniteLoading.total, commandState.visibleItems.length)
			: commandState.visibleItems.length
	);
	const hasMore = $derived(infiniteLoading?.hasMore ?? false);

	// Virtualizer for data-driven mode (itemHeight + gap for spacing)
	const virtualizer = createVirtualizer({
		count: () => effectiveCount,
		scrollElement: () => ref,
		estimateSize: () => itemHeight + gap,
		overscan: () => overscan,
		getItemKey: (index) => commandState.visibleItems[index]?.value ?? `placeholder-${index}`,
		onChange: (instance) => {
			// Infinite loading: trigger when scrolling near the end
			if (!infiniteLoading?.onLoadMore || !hasMore) return;

			const virtualItems = instance.virtualItems;
			if (virtualItems.length === 0) return;

			const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index ?? 0;
			const currentLoadedCount = commandState.visibleItems.length;

			// Check if we need to load more
			if (lastVisibleIndex >= currentLoadedCount - 1 - loadMoreThreshold) {
				infiniteLoading.onLoadMore({ loadedCount: currentLoadedCount, lastVisibleIndex });
			}
		}
	});

	const virtualRows = $derived(virtualizer.virtualItems);
	const totalSize = $derived(virtualizer.totalSize);

	// Watch for list element changes
	watch(
		() => ref,
		(element) => {
			if (element) {
				commandState.setListRef(element);
			}
		}
	);

	// Scroll the indicator into view after the DOM flush that follows a
	// keyboard selection change. $effect runs post-flush, so no tick() promise
	// chain is needed.
	$effect(() => {
		if (commandState.inputMode !== 'keyboard') return;
		const target = commandState.resolvedIndicatorValue;
		if (!target) return;

		const indicatorIndex = commandState.visibleItems.findIndex((item) => item.value === target);
		if (indicatorIndex === -1) return;

		virtualizer.scrollToIndex(indicatorIndex, { align: 'auto' });
	});

	function handleMouseEnter() {
		commandState.mouseInsideList = true;
	}

	function handleMouseLeave() {
		commandState.mouseInsideList = false;
	}

	function handleMouseMove() {
		if (commandState.inputMode !== 'mouse') {
			commandState.inputMode = 'mouse';
		}
	}

	// Handle item click for virtualized items
	function handleItemClick(item: CommandItemData) {
		if (item.disabled) return;
		commandState.inputMode = 'mouse';
		commandState.setIndicator(item.value);
		commandState.selectCurrent();
	}

	function handleItemMouseEnter(item: CommandItemData) {
		if (item.disabled) return;
		if (commandState.inputMode === 'mouse') {
			commandState.setIndicator(item.value);
		}
	}
</script>

<div
	bind:this={ref}
	class={cn('relative overflow-y-auto', className)}
	onmouseenter={handleMouseEnter}
	onmouseleave={handleMouseLeave}
	onmousemove={handleMouseMove}
	{...restProps}
>
	<!-- Virtualized rendering (only when itemSnippet is provided) -->
	{#if itemSnippet}
		<div style="height: {totalSize}px; position: relative;">
			{#each virtualRows as row (row.key)}
				{@const item = commandState.visibleItems[row.index]}
				{#if item}
					{@const isIndicator =
						!item.disabled && commandState.resolvedIndicatorValue === item.value}
					{@const isSelected = commandState.activeValues.includes(item.value)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						style="position: absolute; top: {row.start}px; left: 0; width: 100%; height: {itemHeight}px;"
						data-command-item={item.disabled ? undefined : 'true'}
						data-value={item.value}
						data-indicator={isIndicator ? 'true' : undefined}
						data-selected={isSelected ? 'true' : undefined}
						data-disabled={item.disabled ? 'true' : undefined}
						role={item.disabled ? 'presentation' : 'option'}
						tabindex={item.disabled ? undefined : -1}
						aria-selected={item.disabled ? undefined : isSelected}
						onclick={() => handleItemClick(item)}
						onkeydown={(e) => e.key === 'Enter' && handleItemClick(item)}
						onmouseenter={() => handleItemMouseEnter(item)}
					>
						<span
							class="pointer-events-none absolute inset-0 z-0 rounded-md ring-2 ring-primary/60 transition-all duration-150 ring-inset"
							class:opacity-0={!(isIndicator && commandState.shouldShowIndicator)}
						></span>
						{@render itemSnippet({ item, index: row.index, isIndicator, isSelected })}
					</div>
				{:else}
					<!-- Placeholder for unloaded items (infinite loading) -->
					<div
						style="position: absolute; top: {row.start}px; left: 0; width: 100%; height: {itemHeight}px;"
						role="presentation"
						aria-hidden="true"
					>
						{#if placeholderSnippet}
							{@render placeholderSnippet({ index: row.index })}
						{:else}
							<div class="flex w-full items-center px-3 opacity-50" style="height: {itemHeight}px;">
								<div class="h-3 w-24 animate-pulse rounded bg-muted/40"></div>
							</div>
						{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- Render children (for external content mode or Command.Empty, Command.Loading, etc.) -->
	{#if children}
		{@render children()}
	{/if}
</div>
