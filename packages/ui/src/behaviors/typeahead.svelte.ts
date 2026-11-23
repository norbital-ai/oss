// Incremental typeahead search over labeled items: typing printable keys jumps to the next
// matching item with wrap-around, and repeating the same first letter cycles through matches.

/** One searchable item supplied to `create_typeahead`. */
export type TypeaheadItem = { key: string; text: string; disabled?: boolean };

/** Options for `create_typeahead`. */
export type TypeaheadOptions = {
	/** Candidate items in visual order. */
	items: () => readonly TypeaheadItem[];
	/** Currently active key (search wraps starting after this item). */
	active?: () => string | undefined;
	/** Invoked with the matched item's key. */
	on_match: (key: string) => void;
	/** Buffer reset delay in ms (default `500`). */
	timeout_ms?: number;
};

/** Return value of `create_typeahead`. */
export type Typeahead = ReturnType<typeof create_typeahead>;

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * Headless incremental typeahead behavior. Pass `onkeydown` to any listbox, menu, rail or tab strip
 * (composes directly alongside `create_roving_focus`).
 */
export function create_typeahead(options: TypeaheadOptions) {
	let buffer = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = options.timeout_ms ?? 500;

	function reset(): void {
		buffer = '';
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	function match(query: string): string | undefined {
		const items = options.items().filter((item) => !item.disabled);
		if (items.length === 0) return undefined;
		const needle = normalize(query);
		if (needle === '') return undefined;

		const current = options.active?.();
		const currentIndex = current !== undefined ? items.findIndex((i) => i.key === current) : -1;
		const firstChar = needle[0];
		if (firstChar === undefined) return undefined;
		const repeatedSingle = needle.length > 1 && [...needle].every((ch) => ch === firstChar);
		const target = repeatedSingle ? firstChar : needle;
		const start = repeatedSingle || needle.length === 1 ? currentIndex + 1 : Math.max(0, currentIndex);

		for (let offset = 0; offset < items.length; offset++) {
			const item = items[(start + offset) % items.length];
			if (item !== undefined && normalize(item.text).startsWith(target)) return item.key;
		}
		return undefined;
	}

	function onkeydown(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key.length !== 1) return;
		if (event.key === ' ' && buffer === '') return;

		buffer += event.key;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(reset, timeout);

		const found = match(buffer);
		if (found !== undefined) {
			event.preventDefault();
			options.on_match(found);
		}
	}

	return {
		onkeydown,
		reset,
		get query() {
			return buffer;
		}
	};
}
