import {
	RequiredTreeChildNode,
	TreeChildNode,
	TreeParentNode,
	TreeState,
	isParentNode as isParentNodeFn,
	isRequiredChildNode as isRequiredChildNodeFn
} from './tree-select-state.svelte';
import TreeSelect from './tree-select.svelte';

export { TreeSelect, TreeState };

export const ROOT_NODE_ID = 'ROOT';

/**
 * Threshold percentage (0-1) from viewport edge that triggers auto-scroll
 * 0.2 means scrolling starts when element is within 20% of the viewport edge
 */
export const AUTO_SCROLL_THRESHOLD = 0.2;

export const isRequiredChildNode = isRequiredChildNodeFn;
export const isParentNode = isParentNodeFn;

export type {
	BaseTreeItem,
	NodeActionCallback,
	SelectionState,
	SelectionStateSchema,
	TreeNodes,
	TreeSelectProps,
	TreeSelectStateProps
} from './tree-select-state.svelte';

// Re-export node classes for external use
export { RequiredTreeChildNode, TreeChildNode, TreeParentNode };
