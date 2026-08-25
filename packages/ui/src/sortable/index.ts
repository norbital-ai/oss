import SortableItem from './sortable-item.svelte';
import SortableRoot from './sortable-root.svelte';

export const Sortable = {
	Root: SortableRoot,
	Item: SortableItem
};

export type { SortableItemProps } from './sortable-item.svelte';
export type { SortableRootProps, SortableGroupOption } from './sortable-root.svelte';
