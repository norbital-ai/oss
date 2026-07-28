<script lang="ts">
	/**********************************************************************
	 * Sortable.Item (headless)
	 * - Adds required dataset attributes & dragging state
	 * - Absolutely minimal; no DOM structure assumptions
	 *********************************************************************/
	import { cn } from '#lib/utils';
	import type { SortableItemProps } from './index.js';

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
