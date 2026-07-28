<script lang="ts" module>
	export type {
		FileTreeEntry,
		FileTreeEntryBadge,
		FileTreePresencePeer,
		FileTreeProps
	} from './file-tree.types';
</script>

<script lang="ts">
	import {
		bindSlidingIndicatorMeasure,
		observeSlidingIndicatorResize,
		SLIDING_INDICATOR_TRANSITION_CLASS
	} from '#lib/sliding-indicator';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import FileTreeNode from './file-tree-node.svelte';
	import type { FileTreeProps } from './file-tree.types';
	import { findVisibleFileTreeIndicatorTarget } from './selection-target';

	let {
		entries,
		onToggle,
		onSelect,
		canDelete,
		onDelete,
		deleteDisabled = false,
		selectedPath = null,
		presenceByPath = {},
		getEntryIcon,
		getEntryBadge,
		isMutedEntry,
		variant = 'default',
		class: className
	}: FileTreeProps = $props();

	let rootEl = $state<HTMLDivElement | null>(null);
	let selectionIndicatorStyle = $state('opacity: 0;');
	const selectionIndicatorPositioned = { current: false };

	const scheduleSelectionIndicatorMeasure = bindSlidingIndicatorMeasure({
		whenHidden: () => !rootEl || !selectedPath,
		getTarget: () => (rootEl ? findVisibleFileTreeIndicatorTarget(rootEl) : null),
		onStyle: (style) => {
			selectionIndicatorStyle = style;
		},
		positioned: selectionIndicatorPositioned
	});

	watch(
		() => [rootEl, entries] as const,
		([element], previous) => {
			if (!element) return;

			const disconnectResize = observeSlidingIndicatorResize(
				element,
				scheduleSelectionIndicatorMeasure,
				'[role="treeitem"]'
			);

			const mutationObserver = new MutationObserver((mutations) => {
				if (mutations.some((mutation) => mutation.attributeName === 'aria-expanded')) {
					scheduleSelectionIndicatorMeasure(true);
				}
			});
			mutationObserver.observe(element, {
				subtree: true,
				attributes: true,
				attributeFilter: ['aria-expanded']
			});

			if (previous?.[0] === undefined || previous[0] !== element) {
				scheduleSelectionIndicatorMeasure(false);
			}

			return () => {
				disconnectResize();
				mutationObserver.disconnect();
			};
		}
	);

	watch(
		() => selectedPath,
		() => scheduleSelectionIndicatorMeasure(true)
	);
</script>

<div bind:this={rootEl} class={cn('relative w-full min-w-0', className)}>
	<div
		class={cn(
			SLIDING_INDICATOR_TRANSITION_CLASS,
			variant === 'dark' ? 'bg-[#37373d]' : 'bg-accent'
		)}
		style={selectionIndicatorStyle}
		aria-hidden="true"
	></div>
	{#each entries as entry (entry.path)}
		<FileTreeNode
			{entry}
			{onToggle}
			{onSelect}
			{canDelete}
			{onDelete}
			{deleteDisabled}
			{selectedPath}
			{presenceByPath}
			{getEntryIcon}
			{getEntryBadge}
			{isMutedEntry}
			{variant}
		/>
	{/each}
</div>
