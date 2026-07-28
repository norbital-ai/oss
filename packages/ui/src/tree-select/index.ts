import type { RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
import type { Component } from 'svelte';
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

export type TreeNodes<TMetadata> =
	TreeChildNode<TMetadata> | TreeParentNode<TMetadata> | RequiredTreeChildNode<TMetadata>;

/**
 * Selection state interface defining which nodes are selected or disabled
 */
export interface SelectionState {
	/** Array of selected node IDs */
	selected: string[];
	/** Array of disabled node IDs */
	disabled: string[];
}

/**
 * Callback type for node actions
 */
export type NodeActionCallback<TMetadata> = (
	node: TreeNodes<TMetadata>
) =>
	RenderComponentConfig<Component<Record<string, unknown>>> | RenderSnippetConfig<unknown> | string;

/**
 * Base item structure used for initializing the tree
 */
export interface BaseTreeItem<TMetadata> {
	/** Unique identifier for the node */
	id: string;
	/** Display text for the node */
	title: string;
	/** Additional aliases and metadata included when filtering the tree */
	searchText?: string;
	/** Icon identifier for the node */
	icon: string;
	/** Child items under this node */
	children?: BaseTreeItem<TMetadata>[];
	/** Whether this item is required (when in multiple selection mode) */
	required?: boolean;
	/** Custom metadata associated with this item */
	metadata: TMetadata;
	/** Optional action to render next to the node */
	action?: NodeActionCallback<TMetadata>;
}

/**
 * Props interface for the TreeSelect component
 */
export interface TreeSelectProps<TMetadata> {
	/** Root items to display in the tree */
	rootItems: readonly BaseTreeItem<TMetadata>[];
	/** Selection state (bindable) */
	value?: SelectionState;
	/** Callback when selection changes */
	onChange?: (state: SelectionState) => void;
	/** Disable all interactions and focus */
	disabled?: boolean;
	/** Prevent selection changes but allow navigation/expand */
	readonly?: boolean;
	/** Whether to show the search input */
	showSearch?: boolean;
	/** Placeholder shown in the search input */
	searchPlaceholder?: string;
	/** Additional CSS class for the container */
	containerClass?: string;
	/** Whether to allow multiple selection */
	multiple?: boolean;
}

/**
 * Props interface for TreeState initialization
 */
export type TreeSelectStateProps<TMetadata> = TreeSelectProps<TMetadata>;

// Re-export node classes for external use
export { RequiredTreeChildNode, TreeChildNode, TreeParentNode };
