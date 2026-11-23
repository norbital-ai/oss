// Composable listbox behavior combining selection, roving keyboard navigation, incremental
// typeahead and optional query filtering — the single engine for Select, Combobox, Command and Menu.
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_selection, type SelectionMode } from './selection.svelte.js';
import { create_typeahead } from './typeahead.svelte.js';

/** One selectable option inside `create_listbox`. */
export type ListboxItem = {
	readonly value: string;
	readonly label: string;
	readonly keywords?: string;
	readonly disabled?: boolean;
};

/** Options for `create_listbox`. */
export type ListboxOptions<T extends ListboxItem = ListboxItem> = {
	/** All items in visual order. */
	items: () => readonly T[];
	/** Selection mode (default `'single'`). */
	mode?: SelectionMode | (() => SelectionMode);
	/** Controlled selected values; omit for internal state. */
	selected?: () => readonly string[];
	/** Initial selected values when uncontrolled. */
	default_selected?: readonly string[];
	/** Called when selection changes. */
	on_change?: (values: readonly string[]) => void;
	/** Called when an item is explicitly activated (Enter / click in single mode). */
	on_activate?: (item: T) => void;
	/** Optional custom filter; defaults to case-insensitive substring match on label + keywords. */
	filter?: (item: T, query: string) => boolean;
	/** Enable incremental typeahead when not typing in a search input (default `true`). */
	typeahead?: boolean;
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
 * Headless composable listbox combining `create_selection`, `create_roving_focus`,
 * `create_typeahead` and live query filtering.
 * @example
 * const lb = create_listbox({
 *   items: () => items.map((i) => ({ key: i.id, label: i.title })),
 *   on_activate: (item) => openItem(item.key)
 * });
 * // <input bind:value={lb.query} />
 * // <div {...lb.list_attrs()}>
 * //   {#each lb.filtered as item (item.key)}
 * //     <div {...lb.option_attrs(item)}>{item.label}</div>
 * //   {/each}
 * // </div>
 */
export function create_listbox<T extends ListboxItem = ListboxItem>(options: ListboxOptions<T>) {
	let query = $state('');

	const filtered = $derived.by(() => {
		const all = options.items();
		if (query.trim() === '') return all;
		const match = options.filter ?? defaultFilter;
		return all.filter((item) => match(item, query));
	});

	const keys = $derived(filtered.map((item) => item.value));
	const disabledSet = $derived(
		new Set(filtered.filter((item) => item.disabled).map((item) => item.value))
	);
	const byValue = $derived(new Map(filtered.map((item) => [item.value, item])));

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
		disabled: (key) => disabledSet.has(key),
		on_activate: activate
	});

	const typeahead = create_typeahead({
		items: () =>
			filtered.map((item) => ({ key: item.value, text: item.label, disabled: item.disabled })),
		active: () => roving.active,
		on_match: (key) => roving.focus(key)
	});

	function handleKeydown(event: KeyboardEvent): void {
		roving.root_attrs().onkeydown(event);
		if (!event.defaultPrevented && options.typeahead !== false) {
			typeahead.onkeydown(event);
		}
	}

	return {
		get query() {
			return query;
		},
		set query(value: string) {
			query = value;
		},
		get items() {
			return filtered;
		},
		get active() {
			return roving.active;
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
		focus: roving.focus,
		item: roving.item,
		/** Spread onto the listbox container (`role="listbox"`, `aria-multiselectable`, keyboard handler). */
		list_attrs() {
			return {
				role: 'listbox' as const,
				'aria-multiselectable': mode === 'multiple' ? (true as const) : undefined,
				onkeydown: handleKeydown
			};
		},
		/** Spread onto each option element (`role="option"`, `aria-selected`, `data-highlighted`, click/focus). */
		option_attrs(value: string) {
			const sel = selection.item_attrs(value);
			const rov = roving.item_attrs(value);
			const highlighted = roving.active === value;
			return {
				role: 'option' as const,
				'aria-selected': sel['aria-selected'],
				'aria-disabled': sel['aria-disabled'],
				'data-selected': sel['data-selected'],
				'data-highlighted': highlighted ? '' : undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onpointermove: () => {
					if (!disabledSet.has(value) && roving.active !== value) roving.focus(value);
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
