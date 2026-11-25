// Composable hierarchical tree behavior: expand/collapse nodes, flattened visible rows with
// depth metadata, WAI-ARIA TreeView keyboard navigation (ArrowUp/Down/Left/Right, Home/End,
// typeahead), path-to-tree builder, cascading tri-state checkboxes and automatic focus recovery.
import { register_control } from './controls.svelte.js';
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_selection, type SelectionMode } from './selection.svelte.js';
import { create_typeahead } from './typeahead.svelte.js';

/** One hierarchical node supplied to `create_tree`. */
export type TreeNode<T = unknown> = {
	readonly id: string;
	readonly label: string;
	readonly children?: readonly TreeNode<T>[];
	readonly disabled?: boolean;
	readonly data?: T;
};

/** Flattened visible row produced by `create_tree` with depth and expansion state. */
export type FlatTreeRow<T = unknown> = {
	readonly id: string;
	readonly label: string;
	readonly depth: number;
	readonly parent: string | null;
	readonly expandable: boolean;
	readonly expanded: boolean;
	readonly disabled: boolean;
	readonly node: TreeNode<T>;
};

/** Tri-state checkbox cascade strategy for hierarchical trees. */
export type TreeCheckStrategy = 'leaf' | 'trunk' | 'branch' | 'independent';

/** Tri-state checkbox value for one tree node. */
export type TreeCheckedState = boolean | 'indeterminate';

/** Options for `create_tree`. */
export type TreeOptions<T = unknown> = {
	/** Root tree nodes. */
	readonly nodes: () => readonly TreeNode<T>[];
	/** Initial expanded node ids. */
	readonly default_expanded?: readonly string[];
	/** Controlled expanded node ids. */
	readonly expanded?: () => readonly string[];
	/** Called when expanded node ids change. */
	readonly on_expanded_change?: (ids: readonly string[]) => void;
	/** Selection mode (default `'single'`). */
	readonly mode?: SelectionMode;
	/** Controlled selected ids. */
	readonly selected?: () => readonly string[];
	/** Called when selection changes. */
	readonly on_select?: (ids: readonly string[]) => void;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_tree`. */
export type Tree<T = unknown> = ReturnType<typeof create_tree<T>>;

/** Builds a sorted directory-first `TreeNode[]` from slash-delimited file paths (e.g. Studio files). */
export function tree_from_paths(paths: readonly string[]): TreeNode<{ readonly dir: boolean; readonly path: string }>[] {
	type MutableNode = {
		readonly id: string;
		readonly label: string;
		readonly dir: boolean;
		readonly children: Map<string, MutableNode>;
	};
	const root = new Map<string, MutableNode>();

	for (const raw of paths) {
		const parts = raw.split('/').filter((p) => p !== '');
		let level = root;
		let acc = '';
		for (let i = 0; i < parts.length; i++) {
			const name = parts[i];
			if (name === undefined) continue;
			acc = acc === '' ? name : `${acc}/${name}`;
			const dir = i < parts.length - 1;
			let existing = level.get(name);
			if (existing === undefined) {
				existing = { id: acc, label: name, dir, children: new Map() };
				level.set(name, existing);
			}
			level = existing.children;
		}
	}

	const toNodes = (map: Map<string, MutableNode>): TreeNode<{ readonly dir: boolean; readonly path: string }>[] =>
		[...map.values()]
			.sort((a, b) => (a.dir === b.dir ? a.label.localeCompare(b.label) : a.dir ? -1 : 1))
			.map((n) => ({
				id: n.id,
				label: n.label,
				data: { dir: n.dir, path: n.id },
				...(n.children.size > 0 ? { children: toNodes(n.children) } : {})
			}));

	return toNodes(root);
}

function collectLeaves<T>(node: TreeNode<T>, out: string[]): void {
	const children = node.children ?? [];
	if (children.length === 0) {
		out.push(node.id);
		return;
	}
	for (const child of children) collectLeaves(child, out);
}

function indexTree<T>(nodes: readonly TreeNode<T>[]): {
	readonly byId: Map<string, TreeNode<T>>;
	readonly leavesOf: Map<string, readonly string[]>;
} {
	const byId = new Map<string, TreeNode<T>>();
	const leavesOf = new Map<string, readonly string[]>();
	const walk = (list: readonly TreeNode<T>[]) => {
		for (const node of list) {
			byId.set(node.id, node);
			const leaves: string[] = [];
			collectLeaves(node, leaves);
			leavesOf.set(node.id, leaves);
			if (node.children !== undefined) walk(node.children);
		}
	};
	walk(nodes);
	return { byId, leavesOf };
}

/** Computes checked / unchecked / `'indeterminate'` state for every node in `nodes`. */
export function tree_checked_states<T>(
	nodes: readonly TreeNode<T>[],
	checked: readonly string[],
	strategy: TreeCheckStrategy = 'leaf'
): ReadonlyMap<string, TreeCheckedState> {
	const result = new Map<string, TreeCheckedState>();
	const checkedSet = new Set(checked);
	if (strategy === 'independent') {
		const walk = (list: readonly TreeNode<T>[]) => {
			for (const n of list) {
				result.set(n.id, checkedSet.has(n.id));
				if (n.children !== undefined) walk(n.children);
			}
		};
		walk(nodes);
		return result;
	}

	const { leavesOf } = indexTree(nodes);
	const checkedLeaves = new Set<string>();
	for (const id of checked) {
		const leaves = leavesOf.get(id);
		if (leaves === undefined) continue;
		for (const leaf of leaves) checkedLeaves.add(leaf);
	}

	for (const [id, leaves] of leavesOf.entries()) {
		if (leaves.length === 0) {
			result.set(id, checkedSet.has(id));
			continue;
		}
		let count = 0;
		for (const leaf of leaves) if (checkedLeaves.has(leaf)) count++;
		result.set(id, count === 0 ? false : count === leaves.length ? true : 'indeterminate');
	}
	return result;
}

/** Toggles `id` in a hierarchical tree checkbox model and returns the normalized checked id array for `strategy`. */
export function toggle_tree_checked<T>(
	nodes: readonly TreeNode<T>[],
	checked: readonly string[],
	id: string,
	strategy: TreeCheckStrategy = 'leaf'
): string[] {
	if (strategy === 'independent') {
		return checked.includes(id) ? checked.filter((k) => k !== id) : [...checked, id];
	}

	const { leavesOf } = indexTree(nodes);
	const targetLeaves = leavesOf.get(id);
	if (targetLeaves === undefined) return [...checked];

	const checkedLeaves = new Set<string>();
	for (const k of checked) {
		for (const leaf of leavesOf.get(k) ?? []) checkedLeaves.add(leaf);
	}

	const allCurrentlyChecked = targetLeaves.every((leaf) => checkedLeaves.has(leaf));
	for (const leaf of targetLeaves) {
		if (allCurrentlyChecked) checkedLeaves.delete(leaf);
		else checkedLeaves.add(leaf);
	}

	if (strategy === 'leaf') return [...checkedLeaves];

	const out: string[] = [];
	const collect = (list: readonly TreeNode<T>[]) => {
		for (const node of list) {
			const leaves = leavesOf.get(node.id) ?? [];
			const full = leaves.length > 0 && leaves.every((leaf) => checkedLeaves.has(leaf));
			if (full) {
				out.push(node.id);
				if (strategy === 'trunk') continue;
			}
			if (node.children !== undefined) collect(node.children);
		}
	};
	collect(nodes);
	return out;
}

function flatten<T>(
	nodes: readonly TreeNode<T>[],
	expanded: ReadonlySet<string>,
	depth: number,
	parent: string | null,
	out: FlatTreeRow<T>[]
): void {
	for (const node of nodes) {
		const children = node.children ?? [];
		const expandable = children.length > 0;
		const isExpanded = expandable && expanded.has(node.id);
		out.push({
			id: node.id,
			label: node.label,
			depth,
			parent,
			expandable,
			expanded: isExpanded,
			disabled: node.disabled === true,
			node
		});
		if (isExpanded) flatten(children, expanded, depth + 1, node.id, out);
	}
}

/**
 * Headless WAI-ARIA tree behavior with ArrowRight expand/descend, ArrowLeft collapse/ascend,
 * typeahead, roving tabindex, focus recovery on collapse, selection and optional agent control registration.
 */
export function create_tree<T = unknown>(options: TreeOptions<T>) {
	let internalExpanded = $state<readonly string[]>(options.default_expanded ?? []);
	const expandedIds = $derived(options.expanded ? options.expanded() : internalExpanded);
	const expandedSet = $derived(new Set(expandedIds));

	const rows = $derived.by(() => {
		const out: FlatTreeRow<T>[] = [];
		flatten(options.nodes(), expandedSet, 0, null, out);
		return out;
	});

	const rowMap = $derived(new Map(rows.map((row) => [row.id, row])));
	const visibleIds = $derived(rows.map((row) => row.id));

	const selection = create_selection({
		order: () => visibleIds,
		mode: options.mode ?? 'single',
		selected: options.selected,
		on_change: options.on_select,
		selectable: (id) => !(rowMap.get(id)?.disabled ?? false)
	});

	const roving = create_roving_focus({
		items: () => visibleIds,
		orientation: 'vertical',
		disabled: (id) => rowMap.get(id)?.disabled ?? false,
		on_activate: (id) => selection.choose(id)
	});

	const typeahead = create_typeahead({
		items: () => rows.map((row) => ({ key: row.id, text: row.label, disabled: row.disabled })),
		active: () => roving.active,
		on_match: (id) => roving.focus(id)
	});

	function setExpanded(next: readonly string[]): void {
		if (!options.expanded) internalExpanded = next;
		options.on_expanded_change?.(next);
	}

	function expand(id: string): void {
		const row = rowMap.get(id);
		if (row === undefined || !row.expandable || expandedSet.has(id)) return;
		setExpanded([...expandedIds, id]);
	}

	function collapse(id: string): void {
		if (!expandedSet.has(id)) return;
		setExpanded(expandedIds.filter((item) => item !== id));
	}

	function toggle_expand(id: string): void {
		if (expandedSet.has(id)) collapse(id);
		else expand(id);
	}

	function handleKeydown(event: KeyboardEvent): void {
		const currentId = roving.active;
		const row = currentId !== undefined ? rowMap.get(currentId) : undefined;
		if (row !== undefined && event.key === 'ArrowRight') {
			event.preventDefault();
			if (row.expandable && !row.expanded) {
				expand(row.id);
			} else if (row.expandable && row.expanded) {
				const firstChild = row.node.children?.[0];
				if (firstChild !== undefined) roving.focus(firstChild.id);
			}
			return;
		}
		if (row !== undefined && event.key === 'ArrowLeft') {
			event.preventDefault();
			if (row.expandable && row.expanded) {
				collapse(row.id);
			} else if (row.parent !== null) {
				roving.focus(row.parent);
			}
			return;
		}
		roving.root_attrs().onkeydown(event);
		if (!event.defaultPrevented) typeahead.onkeydown(event);
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'tree',
				...(meta.label !== undefined ? { label: meta.label } : {}),
				state: () => ({ selected: selection.selected, expanded: expandedIds, visible: visibleIds.length }),
				items: () => rows.filter((r) => !r.disabled).map((r) => ({ value: r.id, label: r.label })),
				actions: {
					select: (id) => {
						if (typeof id === 'string') selection.choose(id);
					},
					expand: (id) => {
						if (typeof id === 'string') expand(id);
					},
					collapse: (id) => {
						if (typeof id === 'string') collapse(id);
					},
					toggle_expand: (id) => {
						if (typeof id === 'string') toggle_expand(id);
					}
				}
			})
		);
	}

	return {
		get rows() {
			return rows;
		},
		get expanded() {
			return expandedIds;
		},
		get selected() {
			return selection.selected;
		},
		get active() {
			return roving.active;
		},
		expand,
		collapse,
		toggle_expand,
		is_expanded(id: string): boolean {
			return expandedSet.has(id);
		},
		is_selected: selection.is_selected,
		item: roving.item,
		root_attrs() {
			return {
				role: 'tree' as const,
				onkeydown: handleKeydown
			};
		},
		item_attrs(id: string) {
			const row = rowMap.get(id);
			const sel = selection.item_attrs(id);
			const rov = roving.item_attrs(id);
			return {
				role: 'treeitem' as const,
				'aria-level': (row?.depth ?? 0) + 1,
				'aria-expanded': row?.expandable ? row.expanded : undefined,
				'aria-selected': sel['aria-selected'],
				'aria-disabled': sel['aria-disabled'],
				'data-selected': sel['data-selected'],
				'data-expanded': row?.expanded ? '' : undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onclick: sel.onclick
			};
		}
	};
}
