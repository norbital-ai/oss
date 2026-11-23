// Composable single/multi/range selection model over ordered string keys.
// Supports Shift+click contiguous range selection from an anchor, Cmd/Ctrl toggling and select-all.

/** Single or multiple item selection mode. */
export type SelectionMode = 'single' | 'multiple';

/** Options for `create_selection`. */
export type SelectionOptions = {
	/** Keys in visual order (used for Shift ranges and select-all). */
	order: () => readonly string[];
	/** Single or multiple selection (default `'single'`). */
	mode?: SelectionMode | (() => SelectionMode);
	/** Controlled selected keys; omit for internal state. */
	selected?: () => readonly string[];
	/** Initial selected keys when uncontrolled. */
	default_selected?: readonly string[];
	/** Called with the next selection whenever it changes. */
	on_change?: (keys: readonly string[]) => void;
	/** Whether a key may be selected (default every key). */
	selectable?: (key: string) => boolean;
};

/** Return value of `create_selection`. */
export type Selection = ReturnType<typeof create_selection>;

type Anchor = { key: string; base: readonly string[] };

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const set = new Set(b);
	return a.every((k) => set.has(k));
}

function rangeBetween(
	order: readonly string[],
	anchor: Anchor,
	to: string,
	additive: boolean,
	selectable: (key: string) => boolean
): string[] {
	const fromIndex = order.indexOf(anchor.key);
	const toIndex = order.indexOf(to);
	if (fromIndex < 0 || toIndex < 0) return selectable(to) ? [to] : [...anchor.base];
	const lo = Math.min(fromIndex, toIndex);
	const hi = Math.max(fromIndex, toIndex);
	const span = order.slice(lo, hi + 1).filter(selectable);
	if (!additive) return span;
	const merged = new Set(anchor.base);
	for (const key of span) merged.add(key);
	return [...merged];
}

/**
 * Headless single/multi/range selection behavior for lists, tables, boards, timelines and pickers.
 * Spread `item_attrs(key)` onto each item to get `aria-selected`, `data-selected` and native
 * click / Shift+click / Cmd+click handling automatically.
 */
export function create_selection(options: SelectionOptions) {
	let internal = $state<readonly string[]>(options.default_selected ?? []);
	let anchor: Anchor | null = null;

	const mode = $derived(typeof options.mode === 'function' ? options.mode() : (options.mode ?? 'single'));
	const selected = $derived(options.selected ? options.selected() : internal);
	const selectedSet = $derived(new Set(selected));
	const selectable = (key: string) => options.selectable?.(key) ?? true;

	function commit(next: readonly string[]): boolean {
		if (sameKeys(selected, next)) return false;
		if (!options.selected) internal = next;
		options.on_change?.(next);
		return true;
	}

	function choose(key: string): void {
		if (!selectable(key)) return;
		commit([key]);
		anchor = { key, base: [key] };
	}

	function toggle(key: string): void {
		if (!selectable(key)) return;
		if (mode === 'single') {
			const next = selectedSet.has(key) ? [] : [key];
			commit(next);
			anchor = next.length > 0 ? { key, base: next } : null;
			return;
		}
		const next = selectedSet.has(key)
			? selected.filter((k) => k !== key)
			: [...selected, key];
		commit(next);
		anchor = { key, base: next };
	}

	function extend(to: string, opts: { from?: string | null; additive?: boolean } = {}): void {
		if (mode === 'single') {
			choose(to);
			return;
		}
		const list = options.order();
		if (anchor === null || !list.includes(anchor.key)) {
			anchor = { key: opts.from ?? to, base: selected };
		}
		commit(rangeBetween(list, anchor, to, opts.additive ?? false, selectable));
	}

	function toggle_all(): void {
		const eligible = options.order().filter(selectable);
		if (mode === 'single') {
			if (eligible[0] !== undefined) choose(eligible[0]);
			return;
		}
		const allSelected = eligible.length > 0 && eligible.every((k) => selectedSet.has(k));
		commit(allSelected ? [] : eligible);
	}

	function clear(): void {
		anchor = null;
		commit([]);
	}

	function handle_click(key: string, event: MouseEvent): void {
		if (!selectable(key)) return;
		if (mode === 'multiple' && event.shiftKey) {
			extend(key, { additive: event.metaKey || event.ctrlKey });
			return;
		}
		if (mode === 'multiple' && (event.metaKey || event.ctrlKey)) {
			toggle(key);
			return;
		}
		choose(key);
	}

	return {
		get selected() {
			return selected;
		},
		get count() {
			return selected.length;
		},
		get all_selected() {
			const eligible = options.order().filter(selectable);
			return eligible.length > 0 && eligible.every((k) => selectedSet.has(k));
		},
		get some_selected() {
			const eligible = options.order().filter(selectable);
			const n = eligible.filter((k) => selectedSet.has(k)).length;
			return n > 0 && n < eligible.length;
		},
		is_selected(key: string): boolean {
			return selectedSet.has(key);
		},
		choose,
		toggle,
		extend,
		toggle_all,
		clear,
		/** Spread onto each selectable item for `aria-selected`, `data-selected` and click/Shift/Cmd handling. */
		item_attrs(key: string) {
			const isSelected = selectedSet.has(key);
			const isDisabled = !selectable(key);
			return {
				'aria-selected': isSelected,
				'data-selected': isSelected ? '' : undefined,
				'aria-disabled': isDisabled ? (true as const) : undefined,
				onclick: (event: MouseEvent) => handle_click(key, event)
			};
		}
	};
}
