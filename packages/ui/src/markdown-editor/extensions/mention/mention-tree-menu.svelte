<script lang="ts">
	/**
	 * @file mention-tree-menu.svelte
	 * @description Tree-based dropdown menu for selecting metadata items to mention
	 */
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Scroll } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';
	import { onMount } from 'svelte';
	import type { MentionItem } from './mention-configured.svelte';

	// =================================================================================
	// PROPS
	// =================================================================================

	let {
		items = [],
		onSelect,
		query = '',
		mentionCommand = null,
		isVisible = false,
		onKeyHandlerReady
	}: {
		items: MentionItem[];
		onSelect: (item: MentionItem) => void;
		query?: string;
		mentionCommand?: ((item: MentionItem) => void) | null;
		/** Whether the menu is currently visible/active. When false, keyboard handlers are disabled. */
		isVisible?: boolean;
		/** Callback to receive the key handler function for the mention extension to call */
		onKeyHandlerReady?: (handler: (key: string) => boolean) => void;
	} = $props();

	const { t } = useI18n<UiKeys>();

	// =================================================================================
	// STATE
	// =================================================================================

	let expandedIds = $state<Set<string>>(new Set());
	let consideredIndex = $state(0); // Keyboard navigation/hover
	let scrollContainerRef: HTMLDivElement | null = $state(null);
	let inputMode: 'keyboard' | 'mouse' = $state('keyboard'); // Track last input method used

	// =================================================================================
	// DERIVED STATE
	// =================================================================================

	// Group items by parent to create tree structure
	const itemsByParent = $derived.by(() => {
		const map = new Map<string | undefined, MentionItem[]>();
		items.forEach((item) => {
			const parentId = item.parentId;
			if (!map.has(parentId)) {
				map.set(parentId, []);
			}
			map.get(parentId)!.push(item);
		});
		return map;
	});

	// Filter items based on query from parent
	const filteredItems = $derived.by(() => {
		if (!query.trim()) return items;
		const q = query.toLowerCase();
		return items.filter(
			(item) => item.label.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
		);
	});

	// Get flat list of visible items for keyboard navigation
	const visibleItems = $derived.by(() => {
		if (query.trim()) return filteredItems.map((item) => ({ item, depth: 0 }));
		const result: Array<{ item: MentionItem; depth: number }> = [];

		const addItemsRecursively = (parentId: string | undefined, depth: number = 0) => {
			const children = itemsByParent.get(parentId) || [];
			children.forEach((item) => {
				result.push({ item, depth });
				if (expandedIds.has(item.id) && itemsByParent.has(item.id)) {
					addItemsRecursively(item.id, depth + 1);
				}
			});
		};

		addItemsRecursively(undefined);
		return result;
	});

	// =================================================================================
	// FUNCTIONS
	// =================================================================================

	function toggleExpanded(itemId: string) {
		const newSet = new Set(expandedIds);
		if (newSet.has(itemId)) {
			newSet.delete(itemId);
		} else {
			newSet.add(itemId);
		}
		expandedIds = newSet;
	}

	function handleSelect(item: MentionItem) {
		// Switch to mouse mode when clicking
		inputMode = 'mouse';

		if (mentionCommand) {
			// Call the Suggestion plugin's command (which will insert the tag and call callbacks)
			mentionCommand(item);
		} else {
			// Fallback to the onSelect callback
			onSelect(item);
		}
	}

	function handleChevronClick(event: MouseEvent, itemId: string) {
		event.stopPropagation();
		// Switch to mouse mode when clicking
		inputMode = 'mouse';
		toggleExpanded(itemId);
	}

	function scrollToIndex(index: number) {
		if (!scrollContainerRef) return;
		const button = scrollContainerRef.querySelector(`[data-index="${index}"]`) as HTMLElement;
		if (button) {
			button.scrollIntoView({ block: 'nearest' });
		}
	}

	/**
	 * Handle a key press from the mention extension.
	 * Returns true if the key was handled, false otherwise.
	 * This is called directly by the mention extension, not via window events.
	 */
	function handleKey(key: string): boolean {
		// Only handle keyboard events when the menu is visible
		if (!isVisible) return false;
		if (visibleItems.length === 0) return false;

		// Switch to keyboard mode for any keyboard interaction
		inputMode = 'keyboard';

		switch (key) {
			case 'ArrowDown':
				consideredIndex = Math.min(consideredIndex + 1, visibleItems.length - 1);
				scrollToIndex(consideredIndex);
				return true;
			case 'ArrowUp':
				consideredIndex = Math.max(consideredIndex - 1, 0);
				scrollToIndex(consideredIndex);
				return true;
			case 'Enter':
				if (visibleItems[consideredIndex]) {
					handleSelect(visibleItems[consideredIndex].item);
					return true;
				}
				return false;
			case 'ArrowRight': {
				const { item } = visibleItems[consideredIndex] || {};
				if (item) {
					const hasChildren = itemsByParent.has(item.id);
					if (hasChildren && !expandedIds.has(item.id)) {
						toggleExpanded(item.id);
						return true;
					}
				}
				return false;
			}
			case 'ArrowLeft': {
				const { item } = visibleItems[consideredIndex] || {};
				if (item) {
					const hasChildren = itemsByParent.has(item.id);
					if (hasChildren && expandedIds.has(item.id)) {
						toggleExpanded(item.id);
						return true;
					}
				}
				return false;
			}
			default:
				return false;
		}
	}

	function handleMouseMove() {
		// Switch to mouse mode when mouse actually moves
		inputMode = 'mouse';
	}

	onMount(() => onKeyHandlerReady?.(handleKey));

	// Highlight matching text
	function getHighlightedText(text: string, query: string): { text: string; highlight: boolean }[] {
		if (!query.trim()) return [{ text, highlight: false }];

		const q = query.toLowerCase();
		const textLower = text.toLowerCase();
		const index = textLower.indexOf(q);

		if (index === -1) return [{ text, highlight: false }];

		return [
			{ text: text.slice(0, index), highlight: false },
			{ text: text.slice(index, index + query.length), highlight: true },
			{ text: text.slice(index + query.length), highlight: false }
		].filter((part) => part.text.length > 0);
	}

	// Ensure there's always a considered item
	watch(
		() => visibleItems.length,
		(length) => {
			if (length > 0 && consideredIndex >= length) {
				consideredIndex = length - 1;
			} else if (length > 0 && consideredIndex < 0) {
				consideredIndex = 0;
			}
		}
	);

	watch(
		() => isVisible,
		(visible) => {
			if (!visible) return;
			consideredIndex = 0;
			inputMode = 'keyboard';
		}
	);
</script>

<!-- stupidity:allow UI5 -- popover content boundary -->
<div
	class="flex max-h-[min(28rem,70vh)] w-[min(34rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover p-1 shadow-deep"
	role="menu"
	aria-label={t('misc.mentionMenu')}
	tabindex="-1"
	onmousemove={handleMouseMove}
>
	<div class="flex items-center justify-between px-2.5 py-2">
		<span class="text-xs font-medium text-muted-foreground">{t('misc.reference')}</span>
		<span class="text-tiny text-muted-foreground/70">{t('misc.mentionKeyboardHint')}</span>
	</div>
	<Scroll axis="y" name={t('misc.mentionTree')} bind:ref={scrollContainerRef}>
		<!-- Tree Content with scrolling -->
		{#if visibleItems.length === 0}
			<div class="p-4 text-center text-meta">{t('misc.noItemsFound')}</div>
		{:else}
			{#each visibleItems as { item, depth }, index (item.id)}
				{@const isConsidered = index === consideredIndex}
				{@const isExpanded = expandedIds.has(item.id)}
				{@const hasChildren = itemsByParent.has(item.id)}

				<div
					role="none"
					data-index={index}
					onmouseenter={() => {
						// Only update consideredIndex in mouse mode
						if (inputMode === 'mouse') {
							consideredIndex = index;
						}
					}}
					class={cn(
						'flex w-full items-center rounded-lg py-1 text-left text-xs transition-colors',
						isConsidered && 'bg-muted'
					)}
					style="padding-left: {depth * 16}px"
				>
					<!-- Chevron for parent nodes - separate clickable area -->
					<button
						type="button"
						onclick={(e) => handleChevronClick(e, item.id)}
						class={cn(
							'flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-secondary dark:hover:bg-secondary',
							!hasChildren && 'invisible'
						)}
						disabled={!hasChildren}
					>
						{#if hasChildren}
							<Icon
								icon={isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
								class="h-3 w-3 text-muted-foreground"
							/>
						{/if}
					</button>

					<!-- Main content area - clickable for selection -->
					<button
						type="button"
						onclick={() => handleSelect(item)}
						class="flex min-w-0 flex-1 items-center gap-2 py-0.5 pr-2 pl-1"
					>
						<!-- Icon -->
						<Icon icon={item.icon} class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />

						<!-- Label & Description with highlighting -->
						<div class="flex min-w-0 flex-1 flex-col">
							<span class="truncate text-start font-medium text-foreground">
								{#each getHighlightedText(item.label, query) as part}
									{#if part.highlight}
										<mark class="bg-yellow-200 dark:bg-yellow-800">{part.text}</mark>
									{:else}
										{part.text}
									{/if}
								{/each}
							</span>
							{#if item.description}
								<span class="truncate text-start text-muted-foreground">
									{#each getHighlightedText(item.description, query) as part}
										{#if part.highlight}
											<mark class="bg-yellow-200 dark:bg-yellow-800">{part.text}</mark>
										{:else}
											{part.text}
										{/if}
									{/each}
								</span>
							{/if}
						</div>
					</button>
				</div>
			{/each}
		{/if}
	</Scroll>
</div>
