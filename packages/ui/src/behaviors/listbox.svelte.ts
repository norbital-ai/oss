// Composable listbox behavior combining selection, DOM roving OR virtual (`aria-activedescendant`)
// focus, incremental typeahead and optional query filtering — powers Select, Combobox, Command and Finder.
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_selection, type SelectionMode } from './selection.svelte.js';
import { create_typeahead } from './typeahead.svelte.js';

let nextListboxId = 0;

/** One selectable option inside `create_listbox`. */
export type ListboxItem = {
	readonly value: string;
	readonly label: string;
	readonly keywords?: string;
	readonly disabled?: boolean;
};

/** Focus strategy: `'dom'` moves real focus across options; `'virtual'` keeps focus in a search input via `aria-activedescendant`. */
export type ListboxFocusMode = 'dom' | 'virtual';

/** Options for `create_listbox`. */
export type ListboxOptions<T extends ListboxItem = ListboxItem> = {
	/** All items in visual order. */
	readonly items: () => readonly T[];
	/** Selection mode (default `'single'`). */
	readonly mode?: SelectionMode | (() => SelectionMode);
	/** Focus strategy: `'dom'` (default) or `'virtual'` (`aria-activedescendant`). */
	readonly focus?: ListboxFocusMode;
	/** Controlled selected values; omit for internal state. */
	readonly selected?: () => readonly string[];
	/** Initial selected values when uncontrolled. */
	readonly default_selected?: readonly string[];
	/** Called when selection changes. */
	readonly on_change?: (values: readonly string[]) => void;
	/** Called when an item is explicitly activated (Enter / click in single mode). */
	readonly on_activate?: (item: T) => void;
	/** Optional custom filter; defaults to case-insensitive substring match on label + keywords. Pass `false` for externally filtered/async lists. */
	readonly filter?: false | ((item: T, query: string) => boolean);
	/** Enable incremental typeahead when not typing in a search input (default `true` in `'dom'` mode, `false` in `'virtual'` mode). */
	readonly typeahead?: boolean;
	/** Wrap arrow navigation at list ends (default `true`). */
	readonly loop?: boolean;
	/** Optional stable id prefix for `aria-controls` / `aria-activedescendant`. */
	readonly id?: string;
};

/** Return value of `create_listbox`. */
export type Listbox<T extends ListboxItem = ListboxItem> = ReturnType<typeof create_listbox<T>>;

function defaultFilter(item: ListboxItem, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle === '') return true;
	const haystack = `${item.label} ${item.keywords ?? ''}`.toLowerCase();
	return haystack.includes(needle);
}

/**
 * Headless composable listbox combining `create_selection`, `create_roving_focus` (or virtual
 * `aria-activedescendant` highlighting), `create_typeahead` and live query filtering.
 * @example
 * const lb = create_listbox({
 *   items: () => items.map((i) => ({ value: i.id, label: i.title })),
 *   on_activate: (item) => openItem(item.value)
 * });
 * // <input bind:value={lb.query} />
 * // <div {...lb.list_attrs()}>
 * //   {#each lb.items as item (item.value)}
 * //     <div {...lb.option_attrs(item.value)}>{item.label}</div>
 * //   {/each}
 * // </div>
 */
export function create_listbox<T extends ListboxItem = ListboxItem>(options: ListboxOptions<T>) {
	const uid = options.id ?? `nb-lb-${++nextListboxId}`;
	const listId = `${uid}-list`;
	const focusMode: ListboxFocusMode = options.focus ?? 'dom';
	let query = $state('');
	let virtualActive = $state<string | undefined>(undefined);

	const filtered = $derived.by(() => {
		const all = options.items();
		if (options.filter === false || query.trim() === '') return all;
		const match = options.filter ?? defaultFilter;
		return all.filter((item) => match(item, query));
	});

	const keys = $derived(filtered.map((item) => item.value));
	const enabledKeys = $derived(filtered.filter((item) => !item.disabled).map((item) => item.value));
	const disabledSet = $derived(
		new Set(filtered.filter((item) => item.disabled).map((item) => item.value))
	);
	const byValue = $derived(new Map(filtered.map((item) => [item.value, item])));
	const indexByValue = $derived(new Map(filtered.map((item, i) => [item.value, i])));

	const selection = create_selection({
		order: () => keys,
		mode: options.mode,
		selected: options.selected,
		default_selected: options.default_selected,
		on_change: options.on_change,
		selectable: (key) => !disabledSet.has(key)
	});

	const mode = $derived(
		typeof options.mode === 'function' ? options.mode() : (options.mode ?? 'single')
	);

	function activate(key: string): void {
		const item = byValue.get(key);
		if (item === undefined || item.disabled) return;
		if (mode === 'multiple') {
			selection.toggle(key);
		} else {
			selection.choose(key);
		}
		options.on_activate?.(item);
	}

	const roving = create_roving_focus({
		items: () => keys,
		orientation: 'vertical',
		loop: options.loop,
		disabled: (key) => disabledSet.has(key),
		on_activate: activate
	});

	const active = $derived.by(() => {
		if (focusMode === 'dom') return roving.active;
		if (virtualActive !== undefined && enabledKeys.includes(virtualActive)) return virtualActive;
		return enabledKeys[0];
	});

	function optionId(value: string): string {
		const idx = indexByValue.get(value);
		return idx !== undefined ? `${uid}-opt-${idx}` : `${uid}-opt`;
	}

	const activeId = $derived(active !== undefined ? optionId(active) : undefined);

	function highlight(key: string): void {
		if (disabledSet.has(key)) return;
		if (focusMode === 'dom') roving.focus(key);
		else virtualActive = key;
	}

	function stepVirtual(delta: number): void {
		if (enabledKeys.length === 0) return;
		const cur = active !== undefined ? enabledKeys.indexOf(active) : -1;
		const base = cur < 0 ? 0 : cur;
		const nextIdx =
			options.loop === false
				? Math.max(0, Math.min(enabledKeys.length - 1, base + delta))
				: (base + delta + enabledKeys.length) % enabledKeys.length;
		virtualActive = enabledKeys[nextIdx];
	}

	const typeahead = create_typeahead({
		items: () =>
			filtered.map((item) => ({ key: item.value, text: item.label, disabled: item.disabled })),
		active: () => active,
		on_match: (key) => highlight(key)
	});

	const allowTypeahead = options.typeahead ?? focusMode === 'dom';

	function handleKeydown(event: KeyboardEvent): void {
		if (focusMode === 'dom') {
			roving.root_attrs().onkeydown(event);
			if (!event.defaultPrevented && allowTypeahead) typeahead.onkeydown(event);
			return;
		}
		if (event.isComposing) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			stepVirtual(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			stepVirtual(-1);
		} else if (event.key === 'Home') {
			event.preventDefault();
			virtualActive = enabledKeys[0];
		} else if (event.key === 'End') {
			event.preventDefault();
			virtualActive = enabledKeys.at(-1);
		} else if (event.key === 'Enter' && active !== undefined) {
			event.preventDefault();
			activate(active);
		}
	}

	return {
		get id() {
			return listId;
		},
		get query() {
			return query;
		},
		set query(value: string) {
			query = value;
			if (focusMode === 'virtual') virtualActive = undefined;
		},
		get items() {
			return filtered;
		},
		get active() {
			return active;
		},
		get active_id() {
			return activeId;
		},
		get selected() {
			return selection.selected;
		},
		get count() {
			return selection.count;
		},
		is_selected: selection.is_selected,
		choose: selection.choose,
		toggle: selection.toggle,
		toggle_all: selection.toggle_all,
		clear: selection.clear,
		focus: highlight,
		highlight,
		activate_active() {
			if (active !== undefined) activate(active);
		},
		item: roving.item,
		/** Spread onto a search/combobox `<input>` in `'virtual'` focus mode (`aria-activedescendant`, `aria-controls`, keyboard nav). */
		input_attrs(open = true) {
			return {
				role: 'combobox' as const,
				'aria-autocomplete': 'list' as const,
				'aria-expanded': open,
				'aria-controls': listId,
				'aria-activedescendant': open ? activeId : undefined,
				onkeydown: handleKeydown
			};
		},
		/** Spread onto the listbox container (`id`, `role="listbox"`, `aria-multiselectable`, keyboard handler). */
		list_attrs() {
			return {
				id: listId,
				role: 'listbox' as const,
				'aria-multiselectable': mode === 'multiple' ? (true as const) : undefined,
				onkeydown: handleKeydown
			};
		},
		/** Spread onto each option element (`id`, `role="option"`, `aria-selected`, `data-highlighted`, click/hover/focus). */
		option_attrs(value: string) {
			const sel = selection.item_attrs(value);
			const rov = roving.item_attrs(value);
			const highlighted = active === value;
			return {
				id: optionId(value),
				role: 'option' as const,
				'aria-selected': sel['aria-selected'],
				'aria-disabled': sel['aria-disabled'],
				'data-selected': sel['data-selected'],
				'data-highlighted': highlighted ? '' : undefined,
				tabindex: focusMode === 'virtual' ? -1 : rov.tabindex,
				onfocus: focusMode === 'virtual' ? undefined : rov.onfocus,
				onpointerdown:
					focusMode === 'virtual'
						? (event: PointerEvent) => {
								event.preventDefault();
							}
						: undefined,
				onpointermove: () => {
					if (!disabledSet.has(value) && active !== value) highlight(value);
				},
				onclick: (event: MouseEvent) => {
					if (disabledSet.has(value)) return;
					if (mode === 'multiple' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
						sel.onclick(event);
					} else {
						activate(value);
					}
				}
			};
		}
	};
}
