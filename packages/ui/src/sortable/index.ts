import type SortablePrimitive from 'sortablejs';
import type { Snippet } from 'svelte';
import SortableItem from './sortable-item.svelte';
import SortableRoot from './sortable-root.svelte';

export const Sortable = {
	Root: SortableRoot,
	Item: SortableItem
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Item                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

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

/* ────────────────────────────────────────────────────────────────────────── */
/* Root                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * SortableJS group option type — extracted from SortableJS definitions.
 * Keep broad for flexibility; narrow in your codebase if needed.
 */
export type SortableGroupOption =
	| string
	| {
			name: string;
			pull?:
				boolean | 'clone' | ((to: SortablePrimitive, from: SortablePrimitive) => boolean | string);
			put?: boolean | string[] | ((to: SortablePrimitive, from: SortablePrimitive) => boolean);
			revertClone?: boolean;
	  };

/**
 * Root props (headless).
 *
 * IMPORTANT:
 * - `items` must be stable string IDs in display order.
 * - `onSort` emits the new order as primitive IDs.
 * - `element` is the caller-owned SortableJS target.
 */
export interface SortableRootProps {
	element: HTMLElement | null;
	items: string[];
	direction?: 'vertical' | 'horizontal';
	ghostClass?: string;
	handle?: string;
	/** SortableJS `group` option (renamed to avoid Svelte `{group}` shorthand collisions). */
	sortableGroup?: string | SortablePrimitive.GroupOptions;
	sort?: boolean;
	onSort?: (orderedIds: string[], evt: SortablePrimitive.SortableEvent) => void;
	onDragStart?: (id: string, evt: SortablePrimitive.SortableEvent) => void;
	onDragEnd?: (evt: SortablePrimitive.SortableEvent) => void;
	disabled?: boolean;
	delay?: number;
	delayOnTouchOnly?: boolean;
	touchStartThreshold?: number;
	fallbackTolerance?: number;
	scroll?: boolean;
	scrollSensitivity?: number;
	scrollSpeed?: number;
	child: Snippet<[{ sortedItems: string[]; draggedItemId: string | null }]>;
}
