// Composable hierarchical tree behavior: expand/collapse nodes, flattened visible rows with
// depth metadata, WAI-ARIA TreeView keyboard navigation (ArrowUp/Down/Left/Right, Home/End) and selection.
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_selection, type SelectionMode } from './selection.svelte.js';

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

/** Options for `create_tree`. */
export type TreeOptions<T = unknown> = {
	/** Root tree nodes. */
	nodes: () => readonly TreeNode<T>[];
	/** Initial expanded node ids. */
	default_expanded?: readonly string[];
	/** Controlled expanded node ids. */
	expanded?: () => readonly string[];
	/** Called when expanded node ids change. */
	on_expanded_change?: (ids: readonly string[]) => void;
	/** Selection mode (default `'single'`). */
	mode?: SelectionMode;
	/** Controlled selected ids. */
	selected?: () => readonly string[];
	/** Called when selection changes. */
	on_select?: (ids: readonly string[]) => void;
};

/** Return value of `create_tree`. */
export type Tree<T = unknown> = ReturnType<typeof create_tree<T>>;

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
 * roving tabindex and selection.
 * @example
 * const tree = create_tree({
 *   nodes: () => folders,
 *   default_expanded: ['root'],
 *   on_select: (ids) => (selectedFolder = ids[0] ?? null)
 * });
 * // <div {...tree.root_attrs()}>
 * //   {#each tree.rows as row (row.id)}
 * //     <div {...tree.item_attrs(row.id)}>{row.label}</div>
 * //   {/each}
 * // </div>
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
