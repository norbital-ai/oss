import type { Snippet } from 'svelte';

export interface ResourceSchedulerResource {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface ResourceSchedulerItem {
	readonly id: string;
	readonly resourceId: string;
	readonly label: string;
	readonly start: string;
	readonly end: string;
	readonly disabled?: boolean;
	readonly editable?: boolean;
	readonly lockedReason?: string;
	readonly tone?: 'default' | 'muted' | 'warning' | 'destructive';
}

export interface ResourceSchedulerCell<TItem extends ResourceSchedulerItem> {
	readonly resourceId: string;
	readonly start: string;
	readonly end: string;
	readonly items: readonly TItem[];
}

export interface ResourceSchedulerChange {
	readonly itemId: string;
	readonly resourceId: string;
	readonly start: string;
	readonly end: string;
}

export interface ResourceSchedulerCreate {
	readonly resourceId: string;
	readonly start: string;
	readonly end: string;
}

export interface ResourceSchedulerCollision {
	readonly kind: 'create' | 'move' | 'resize';
	readonly itemId?: string;
	readonly resourceId: string;
	readonly start: string;
	readonly end: string;
	readonly collidingItemIds: readonly string[];
}

export interface ResourceSchedulerProps<
	TResource extends ResourceSchedulerResource,
	TItem extends ResourceSchedulerItem
> {
	resources: readonly TResource[];
	items: readonly TItem[];
	view: 'week' | 'month';
	anchorDate: string;
	layout?: 'timeline' | 'matrix';
	selectedItemIds?: readonly string[];
	rowHeight?: number;
	resourceWidth?: number;
	dayWidth?: number;
	resourceLabel?: string;
	maxVisibleCellItems?: number;
	disabled?: boolean;
	readonly?: boolean;
	class?: string;
	resourceContent?: Snippet<[TResource]>;
	itemContent?: Snippet<[TItem]>;
	cellContent?: Snippet<[TResource, ResourceSchedulerCell<TItem>]>;
	onSelectionChange?: (itemIds: string[]) => void;
	onCreate?: (change: ResourceSchedulerCreate) => void;
	onMove?: (change: ResourceSchedulerChange) => void;
	onResize?: (change: ResourceSchedulerChange) => void;
	onCollision?: (collision: ResourceSchedulerCollision) => boolean | void;
	onItemActivate?: (item: TItem) => void;
	onCellActivate?: (cell: ResourceSchedulerCell<TItem>) => void;
}
