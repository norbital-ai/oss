import { treeFind, treeFlatten } from '@norbital-ai/std/tree';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type {
	BaseTreeItem,
	NodeActionCallback,
	SelectionState,
	TreeNodes,
	TreeSelectStateProps
} from '#lib/tree-select';

// ============================================================================
// Type Guards
// ============================================================================

export function isParentNode<TMetadata>(
	node: TreeNodes<TMetadata> // stupidity:allow R5b -- canonical instanceof guard for this exported class union
): node is TreeParentNode<TMetadata> {
	return node instanceof TreeParentNode;
}

export function isRequiredChildNode<TMetadata>(
	node: TreeNodes<TMetadata> // stupidity:allow R5b -- canonical instanceof guard for this exported class union
): node is RequiredTreeChildNode<TMetadata> {
	return node instanceof RequiredTreeChildNode;
}

// ============================================================================
// Node Classes (Data Only - No Methods)
// ============================================================================

/** Constructor payload for a tree node: the immutable fields that build one node. */
type TreeNodeParams<TMetadata> = {
	id: string;
	title: string;
	searchText?: string;
	icon: string;
	depth: number;
	displayDepth: number;
	metadata: TMetadata;
	parentNode: TreeParentNode<TMetadata> | undefined;
	treeState: TreeState<TMetadata>;
	action?: NodeActionCallback<TMetadata>;
};

/**
 * Regular child node (leaf node)
 */
export class TreeChildNode<TMetadata> {
	readonly id: string;
	readonly title: string;
	readonly searchText?: string;
	readonly icon: string;
	readonly depth: number;
	readonly displayDepth: number;
	readonly metadata: TMetadata;
	readonly parentNode: TreeParentNode<TMetadata> | undefined;
	readonly action?: NodeActionCallback<TMetadata>;
	readonly treeState: TreeState<TMetadata>;

	constructor(params: TreeNodeParams<TMetadata>) {
		this.id = params.id;
		this.title = params.title;
		this.searchText = params.searchText;
		this.icon = params.icon;
		this.depth = params.depth;
		this.displayDepth = params.displayDepth;
		this.metadata = params.metadata;
		this.parentNode = params.parentNode;
		this.treeState = params.treeState;
		this.action = params.action;
	}

	// Derived properties based on TreeState
	get isSelected(): boolean {
		return this.treeState.selectedNodeIds.has(this.id);
	}

	get disabled(): boolean {
		return this.treeState.disabledNodeIds.has(this.id);
	}
}

/**
 * Required child node (selecting it requires all siblings to be selected).
 *
 * Same field surface as `TreeChildNode`; the type carries the requirement so selection rules can
 * distinguish the two node kinds while sharing one implementation.
 */
export class RequiredTreeChildNode<TMetadata> extends TreeChildNode<TMetadata> {}

/**
 * Parent node (has children)
 */
export class TreeParentNode<TMetadata> {
	readonly id: string;
	readonly title: string;
	readonly searchText?: string;
	readonly icon: string;
	readonly depth: number;
	readonly displayDepth: number;
	readonly metadata: TMetadata;
	readonly parentNode: TreeParentNode<TMetadata> | undefined;
	readonly action?: NodeActionCallback<TMetadata>;
	readonly treeState: TreeState<TMetadata>;
	readonly children: TreeNodes<TMetadata>[] = [];

	constructor(params: TreeNodeParams<TMetadata> & { children?: TreeNodes<TMetadata>[] }) {
		this.id = params.id;
		this.title = params.title;
		this.searchText = params.searchText;
		this.icon = params.icon;
		this.depth = params.depth;
		this.displayDepth = params.displayDepth;
		this.metadata = params.metadata;
		this.parentNode = params.parentNode;
		this.treeState = params.treeState;
		this.action = params.action;
		if (params.children) {
			this.children = params.children;
		}
	}

	get isExpanded(): boolean {
		return this.treeState.expandedNodeIds.has(this.id);
	}

	get disabled(): boolean {
		return this.treeState.disabledNodeIds.has(this.id);
	}

	// Derived: is this parent in an indeterminate state?
	get isIndeterminate(): boolean {
		if (this.children.length === 0 || this.disabled) return false;

		const selectableLeaves = this.#getLeafNodes().filter((node) => !node.disabled);
		if (selectableLeaves.length === 0) return false;

		const hasSelected = selectableLeaves.some((node) => node.isSelected);
		const allSelected = selectableLeaves.every((node) => node.isSelected);

		return hasSelected && !allSelected;
	}

	// Derived: is this parent selected (all children selected)?
	get isSelected(): boolean {
		if (this.children.length === 0 || this.disabled) return false;

		const selectableLeaves = this.#getLeafNodes().filter((node) => !node.disabled);
		return selectableLeaves.length > 0 && selectableLeaves.every((node) => node.isSelected);
	}

	#getLeafNodes(): TreeNodes<TMetadata>[] {
		return treeFlatten([this], 'children' as keyof TreeParentNode<TMetadata>).filter(
			(node) => !isParentNode(node)
		);
	}
}

// ============================================================================
// Tree State Manager
// ============================================================================

export class TreeState<TMetadata> {
	// Core tree data
	readonly rootNodes: TreeParentNode<TMetadata>[] = [];
	readonly multiple: boolean;
	readonly onChange?: (state: SelectionState) => void;

	// State 1: Tree structure (expand/collapse)
	expandedNodeIds = new SvelteSet<string>();
	filterValue = $state('');
	activeRootIndex = $state(0);

	// State 2: Selection state
	selectedNodeIds = new SvelteSet<string>();
	disabledNodeIds = new SvelteSet<string>();

	// State 3: Active node (for indicator)
	activeNodeId = $state<string | null>(null);

	// Per-tab active state persistence
	private activeNodeByTab = $state(new SvelteMap<number, string | null>());

	// Derived: active root node
	activeRootNode = $derived(this.rootNodes[this.activeRootIndex] || null);

	// Derived: visible nodes (respecting expand state and filter)
	visibleNodes = $derived.by(() => {
		if (this.filterValue) {
			return this.#computeFilteredNodes();
		}
		return this.#computeVisibleNodes();
	});

	// Derived: match info for highlighting
	matchInfo = $derived.by(() => this.#computeMatchInfo());

	constructor(params: TreeSelectStateProps<TMetadata>) {
		this.multiple = params.multiple ?? false;
		this.onChange = params.onChange;

		// Initialize tree structure
		this.rootNodes = this.#initializeRootNodes(params.rootItems);

		// Initialize selection state
		if (params.value) {
			this.selectedNodeIds = new SvelteSet(params.value.selected);
			this.disabledNodeIds = new SvelteSet(params.value.disabled);

			// Auto-expand nodes that have selected descendants
			this.#expandToSelected();
		}
	}

	// ============================================================================
	// Public Methods
	// ============================================================================

	findNode(nodeId: string): TreeNodes<TMetadata> | null {
		return treeFind(
			this.rootNodes,
			'children' as keyof TreeParentNode<TMetadata>,
			(node) => node.id === nodeId
		);
	}

	toggleExpand(nodeId: string) {
		const node = this.findNode(nodeId);
		if (!node || !isParentNode(node) || node.disabled) return;

		if (this.expandedNodeIds.has(nodeId)) {
			this.expandedNodeIds.delete(nodeId);
		} else {
			this.expandedNodeIds.add(nodeId);
		}
	}

	toggleDisable(nodeId: string) {
		const node = this.findNode(nodeId);
		if (!node || !isParentNode(node)) return;

		if (this.disabledNodeIds.has(nodeId)) {
			this.disabledNodeIds.delete(nodeId);
		} else {
			this.disabledNodeIds.add(nodeId);
			this.expandedNodeIds.delete(nodeId); // Collapse when disabling
		}

		this.notifyChange();
	}

	toggleSelection(nodeId: string) {
		const node = this.findNode(nodeId);
		if (!node || node.disabled) return;

		if (isParentNode(node)) {
			this.#toggleParentSelection(node);
		} else if (isRequiredChildNode(node)) {
			this.#toggleRequiredChildSelection(node);
		} else {
			this.#toggleRegularChildSelection(node);
		}

		this.notifyChange();
	}

	setActiveNode(nodeId: string | null) {
		this.activeNodeId = nodeId;

		// Persist active node per tab
		if (nodeId !== null) {
			this.activeNodeByTab.set(this.activeRootIndex, nodeId);
		}
	}

	setActiveRootIndex(index: number) {
		if (index >= 0 && index < this.rootNodes.length) {
			this.activeRootIndex = index;

			// Restore active node for this tab
			const savedActiveNode = this.activeNodeByTab.get(index);
			this.activeNodeId = savedActiveNode ?? null;
		}
	}

	clearAllSelections() {
		this.selectedNodeIds.clear();
		this.notifyChange();
	}

	notifyChange() {
		this.onChange?.({
			selected: Array.from(this.selectedNodeIds),
			disabled: Array.from(this.disabledNodeIds)
		});
	}

	// ============================================================================
	// Private Methods - Selection Logic
	// ============================================================================

	#toggleParentSelection(node: TreeParentNode<TMetadata>) {
		if (!this.multiple) return;

		const directChildren = this.#getDirectChildren(node);
		const hasSelectedDirectChild = directChildren.some((child) =>
			this.selectedNodeIds.has(child.id)
		);

		if (!hasSelectedDirectChild) {
			this.#selectDirectChildren(node);
		} else {
			const hadSelectedRequiredDirectChild = directChildren.some(
				(child) => isRequiredChildNode(child) && this.selectedNodeIds.has(child.id)
			);
			this.#clearDirectChildren(node);

			// Required explicit-unselect semantics: clear sibling group and downstream.
			if (hadSelectedRequiredDirectChild) {
				this.#clearSiblingBranches(node);
			}
		}

		this.#enforceRequiredClosureUpward(node);
	}

	#toggleRequiredChildSelection(node: RequiredTreeChildNode<TMetadata>) {
		const newState = !node.isSelected;

		if (newState) {
			this.selectedNodeIds.add(node.id);
			this.#enforceRequiredClosureUpward(node.parentNode);
		} else {
			if (this.multiple && node.parentNode) {
				this.#clearSiblingBranches(node.parentNode);
				this.#enforceRequiredClosureUpward(node.parentNode.parentNode);
			} else {
				this.selectedNodeIds.delete(node.id);
			}
		}
	}

	#toggleRegularChildSelection(node: TreeChildNode<TMetadata>) {
		const newState = !node.isSelected;

		if (newState) {
			this.selectedNodeIds.add(node.id);
			this.#enforceRequiredClosureUpward(node.parentNode);
		} else {
			this.selectedNodeIds.delete(node.id);
			this.#enforceRequiredClosureUpward(node.parentNode);
		}
	}

	#getDirectChildren(parentNode: TreeParentNode<TMetadata>): TreeNodes<TMetadata>[] {
		return parentNode.children;
	}

	#selectDirectChildren(parentNode: TreeParentNode<TMetadata>): void {
		this.#getDirectChildren(parentNode).forEach((directChild) => {
			if (directChild.disabled) return;
			this.selectedNodeIds.add(directChild.id);
		});
	}

	#clearDirectChildren(parentNode: TreeParentNode<TMetadata>): void {
		this.#getDirectChildren(parentNode).forEach((directChild) => {
			this.selectedNodeIds.delete(directChild.id);
		});
	}

	#clearSiblingBranches(parentNode: TreeParentNode<TMetadata>): void {
		this.#getDirectChildren(parentNode).forEach((sibling) => this.#clearBranch(sibling));
	}

	#clearBranch(node: TreeNodes<TMetadata>): void {
		if (!isParentNode(node)) {
			this.selectedNodeIds.delete(node.id);
			return;
		}

		const branchNodes = treeFlatten(
			[node],
			'children' as keyof TreeParentNode<TMetadata>
		) as TreeNodes<TMetadata>[];
		branchNodes.forEach((branchNode) => this.selectedNodeIds.delete(branchNode.id));
	}

	#branchHasSelection(node: TreeNodes<TMetadata>): boolean {
		if (this.selectedNodeIds.has(node.id)) return true;
		if (!isParentNode(node)) return false;

		const branchNodes = treeFlatten(
			[node],
			'children' as keyof TreeParentNode<TMetadata>
		) as TreeNodes<TMetadata>[];
		return branchNodes.some((branchNode) => this.selectedNodeIds.has(branchNode.id));
	}

	#enforceRequiredClosure(parentNode: TreeParentNode<TMetadata>): void {
		const hasSelectedSiblingBranch = this.#getDirectChildren(parentNode).some((sibling) =>
			this.#branchHasSelection(sibling)
		);
		if (!hasSelectedSiblingBranch) return;

		this.#getDirectRequiredChildSiblings(parentNode).forEach((requiredSibling) => {
			this.selectedNodeIds.add(requiredSibling.id);
		});
	}

	#enforceRequiredClosureUpward(startAt: TreeParentNode<TMetadata> | undefined): void {
		let current: TreeParentNode<TMetadata> | undefined = startAt;
		while (current) {
			this.#enforceRequiredClosure(current);
			current = current.parentNode;
		}
	}

	#getDirectRequiredChildSiblings(
		parentNode: TreeParentNode<TMetadata>
	): RequiredTreeChildNode<TMetadata>[] {
		return this.#getDirectChildren(parentNode).filter(
			(node): node is RequiredTreeChildNode<TMetadata> =>
				isRequiredChildNode(node) && !node.disabled
		);
	}

	// ============================================================================
	// Private Methods - Visibility & Filtering
	// ============================================================================

	#computeVisibleNodes(): TreeNodes<TMetadata>[] {
		if (!this.activeRootNode) return [];

		const visible: TreeNodes<TMetadata>[] = [];

		const walk = (nodes: readonly TreeNodes<TMetadata>[]) => {
			for (const node of nodes) {
				// Skip root nodes themselves (depth 0)
				if (node.depth > 0) {
					visible.push(node);
				}

				if (isParentNode(node) && this.expandedNodeIds.has(node.id)) {
					walk(node.children);
				}
			}
		};

		// For single root, show its children
		if (this.activeRootNode) {
			walk(this.activeRootNode.children);
		}

		return visible;
	}

	#computeFilteredNodes(): TreeNodes<TMetadata>[] {
		if (!this.filterValue || !this.activeRootNode) return [];

		const filterLower = this.filterValue.toLowerCase();
		const matchedIds = new Set<string>();
		const allNodes = treeFlatten(
			[this.activeRootNode],
			'children' as keyof TreeParentNode<TMetadata>
		);

		// Find all matching nodes
		allNodes.forEach((node) => {
			if (node.depth === 0) return; // Skip root

			const searchableText = `${node.title} ${node.searchText ?? ''}`.toLowerCase();
			if (searchableText.includes(filterLower)) {
				matchedIds.add(node.id);

				// Add parent chain
				let parent = node.parentNode;
				while (parent && parent.depth > 0) {
					matchedIds.add(parent.id);
					parent = parent.parentNode;
				}
			}
		});

		// Return matched nodes in tree order, preserving hierarchy
		const result: TreeNodes<TMetadata>[] = [];
		const walk = (nodes: readonly TreeNodes<TMetadata>[]) => {
			for (const node of nodes) {
				if (node.depth > 0 && matchedIds.has(node.id)) {
					result.push(node);
					if (isParentNode(node)) {
						walk(node.children);
					}
				}
			}
		};

		walk(this.activeRootNode.children);
		return result;
	}

	#computeMatchInfo(): Map<string, { start: number; end: number }> {
		const info = new Map<string, { start: number; end: number }>();
		if (!this.filterValue) return info;

		const filterLower = this.filterValue.toLowerCase();
		const filterLen = this.filterValue.length;

		this.visibleNodes.forEach((node) => {
			const idx = node.title.toLowerCase().indexOf(filterLower);
			if (idx !== -1) {
				info.set(node.id, { start: idx, end: idx + filterLen });
			}
		});

		return info;
	}

	#expandToSelected() {
		// Auto-expand parent nodes that have selected descendants
		this.selectedNodeIds.forEach((selectedId) => {
			const node = this.findNode(selectedId);
			if (node) {
				let parent = node.parentNode;
				while (parent) {
					this.expandedNodeIds.add(parent.id);
					parent = parent.parentNode;
				}
			}
		});
	}

	// ============================================================================
	// Private Methods - Initialization
	// ============================================================================

	#initializeRootNodes(rootItems: readonly BaseTreeItem<TMetadata>[]): TreeParentNode<TMetadata>[] {
		const rootNodes = rootItems.map((item) => {
			const rootNode = new TreeParentNode({
				id: item.id,
				title: item.title,
				searchText: item.searchText,
				icon: item.icon,
				depth: 0,
				displayDepth: 0,
				metadata: item.metadata,
				treeState: this,
				parentNode: undefined,
				action: item.action
			});

			// Initialize children recursively
			if (item.children && item.children.length > 0) {
				(rootNode.children as TreeNodes<TMetadata>[]) = this.#initializeChildren(
					item.children,
					1,
					1,
					rootNode
				);
			}

			return rootNode;
		});

		// Root nodes are expanded by default in single selection mode
		if (!this.multiple) {
			rootNodes.forEach((node) => this.expandedNodeIds.add(node.id));
		}

		return rootNodes;
	}

	#initializeChildren(
		items: readonly BaseTreeItem<TMetadata>[],
		depth: number,
		displayDepth: number,
		parentNode: TreeParentNode<TMetadata>
	): TreeNodes<TMetadata>[] {
		return items.map((item) => {
			if (item.children && item.children.length > 0) {
				// Create parent node
				const node = new TreeParentNode({
					id: item.id,
					title: item.title,
					searchText: item.searchText,
					icon: item.icon,
					depth,
					displayDepth,
					metadata: item.metadata,
					treeState: this,
					parentNode,
					action: item.action
				});

				// Recursively initialize children
				(node.children as TreeNodes<TMetadata>[]) = this.#initializeChildren(
					item.children,
					depth + 1,
					displayDepth + 1,
					node
				);

				return node;
			} else if (item.required) {
				// Create required child node
				return new RequiredTreeChildNode({
					id: item.id,
					title: item.title,
					searchText: item.searchText,
					icon: item.icon,
					depth,
					displayDepth,
					metadata: item.metadata,
					parentNode,
					treeState: this,
					action: item.action
				});
			} else {
				// Create regular child node
				return new TreeChildNode({
					id: item.id,
					title: item.title,
					searchText: item.searchText,
					icon: item.icon,
					depth,
					displayDepth,
					metadata: item.metadata,
					parentNode,
					treeState: this,
					action: item.action
				});
			}
		});
	}
}
