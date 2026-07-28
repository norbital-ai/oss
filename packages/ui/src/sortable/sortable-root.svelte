<script lang="ts">
	/**********************************************************************
	 * Sortable.Root (headless)
	 * - Emits ordered primitive ids on drop: onSort(orderedIds)
	 * - Binds SortableJS to the caller-owned element
	 * - Passes drag state explicitly because caller snippets retain lexical context
	 * - Never mutates `items` internally → parent remains the source of truth
	 *********************************************************************/
	import { watch } from 'runed';
	import SortablePrimitive from 'sortablejs';
	import { onDestroy } from 'svelte';
	import type { SortableRootProps } from './index.js';

	let {
		element,
		items = $bindable<string[]>([]),
		ghostClass = 'sortable-ghost',
		handle,
		sortableGroup,
		sort = true,
		onSort,
		onDragStart,
		onDragEnd,
		disabled = false,
		delay = 0,
		delayOnTouchOnly = false,
		touchStartThreshold = 1,
		fallbackTolerance = 0,
		scroll = true,
		scrollSensitivity = 30,
		scrollSpeed = 10,
		child,
		direction = 'vertical'
	}: SortableRootProps = $props();

	let draggedItemId = $state<string | null>(null);

	let sortableInstance = $state() as SortablePrimitive | undefined;
	watch(
		() => element,
		(element) => {
			sortableInstance?.destroy();
			sortableInstance = undefined;
			if (!element) return;

			sortableInstance = new SortablePrimitive(element, {
				direction,
				ghostClass,
				handle: handle
					? handle.trim().startsWith('.')
						? handle.trim()
						: `.${handle.trim()}`
					: undefined,
				draggable: '[data-sortable-id]',
				group: sortableGroup,
				sort,
				disabled,
				delay,
				delayOnTouchOnly,
				touchStartThreshold,
				fallbackTolerance,
				scroll,
				scrollSensitivity,
				scrollSpeed,
				swapThreshold: 0.2,
				animation: 0,
				filter: '[data-sortable-disabled="true"]',
				preventOnFilter: true,
				onMove: (evt) => {
					return evt.related?.getAttribute?.('data-sortable-disabled') !== 'true';
				},

				onStart: (evt) => {
					const itemId = evt.item.getAttribute('data-sortable-id');
					if (itemId) {
						draggedItemId = itemId;
						onDragStart?.(itemId, evt);
					}
				},

				onEnd: (evt) => {
					draggedItemId = null;
					onDragEnd?.(evt);

					// SortableJS moves DOM nodes between lists; Svelte owns the tree via {#each}.
					// Cross-column: drop the node Sortable moved — parent state will render it in the target lane.
					// Re-inserting into `from` (old revert) left a stray copy in the source column.
					const { item, from, to } = evt;
					if (item && from && to && from !== to) {
						item.remove();
					}

					if (!element) return;

					const seen = new Set<string>();
					const orderedIds: string[] = [];
					for (const node of element.querySelectorAll<HTMLElement>('[data-sortable-id]')) {
						const id = node.getAttribute('data-sortable-id');
						if (!id || seen.has(id)) continue;
						seen.add(id);
						orderedIds.push(id);
					}

					onSort?.(orderedIds, evt);
				}
			});
		}
	);
	watch(
		() => disabled,
		(disabled) => {
			sortableInstance?.option('disabled', disabled);
		}
	);
	watch(
		() => sort,
		(sort) => {
			sortableInstance?.option('sort', sort);
		}
	);
	onDestroy(() => {
		sortableInstance?.destroy();
		sortableInstance = undefined;
	});
</script>

{@render child({ sortedItems: items, draggedItemId })}
