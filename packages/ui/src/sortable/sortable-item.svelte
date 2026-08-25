<script lang="ts">
	/**********************************************************************
	 * Sortable.Item (headless)
	 * - Adds required dataset attributes & dragging state
	 * - Absolutely minimal; no DOM structure assumptions
	 *********************************************************************/
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils';

	export interface SortableItemProps {
		id: string;
		isDragging: boolean;
		disabled?: boolean;
		child: Snippet<
			[
				{
					props: {
						/** Required: used by SortableJS to read order on drop */
						'data-sortable-id': string;
						/** Convenience: true when this item is currently being dragged */
						isDragging: boolean;
						/** Suggested classes to style states (optional to use) */
						class: string;
						/** Prevent dragging from this subtree when true */
						'data-sortable-disabled': string | undefined;
					};
				}
			]
		>;
	}

	let { id, isDragging, disabled = false, child }: SortableItemProps = $props();
</script>

{@render child({
	props: {
		'data-sortable-id': id,
		isDragging,
		class: cn({
			'sortable-item': true,
			'sortable-disabled': disabled,
			'sortable-dragging': isDragging
		}),
		'data-sortable-disabled': disabled ? 'true' : undefined
	}
})}
