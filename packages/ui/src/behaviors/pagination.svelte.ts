// Composable pagination state & range calculation (`next`, `previous`, `first`, `last`, `go`,
// compact page range with `'ellipsis'`) + live agent control registration.
import { register_control } from './controls.svelte.js';

/** One entry in a compact pagination window: a 1-based page number or `'ellipsis'`. */
export type PaginationEntry = number | 'ellipsis';

/** Options for `create_pagination`. */
export type PaginationOptions = {
	/** Current 1-based page number (controlled getter, or omit for internal state). */
	page?: () => number;
	/** Initial 1-based page when uncontrolled (default `1`). */
	default_page?: number;
	/** Total page count (`null` when unknown / keyset-paged). */
	total_pages: () => number | null;
	/** Explicit previous availability override (for cursor/keyset pagination). */
	has_previous?: () => boolean;
	/** Explicit next availability override (for cursor/keyset pagination). */
	has_next?: () => boolean;
	/** Called when the page changes. */
	on_page_change?: (page: number) => void;
	/** Sibling pages shown on each side of the current page in `range` (default `1`). */
	siblings?: number;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	control?: { id: string; label?: string };
};

/** Return value of `create_pagination`. */
export type Pagination = ReturnType<typeof create_pagination>;

/** Computes a compact 1-based page range with `'ellipsis'` gaps. */
export function page_range(current: number, total: number, siblings = 1): PaginationEntry[] {
	if (total <= 0) return [];
	const maxVisible = siblings * 2 + 5;
	if (total <= maxVisible) return Array.from({ length: total }, (_, i) => i + 1);

	const left = Math.max(2, current - siblings);
	const right = Math.min(total - 1, current + siblings);
	const showLeftDots = left > 2;
	const showRightDots = right < total - 1;

	const out: PaginationEntry[] = [1];
	if (showLeftDots) {
		out.push('ellipsis');
	} else {
		for (let p = 2; p < left; p++) out.push(p);
	}
	for (let p = left; p <= right; p++) out.push(p);
	if (showRightDots) {
		out.push('ellipsis');
	} else {
		for (let p = right + 1; p < total; p++) out.push(p);
	}
	out.push(total);
	return out;
}

/**
 * Headless pagination behavior supporting both offset (`total_pages`) and keyset (`has_previous`/`has_next`) views.
 */
export function create_pagination(options: PaginationOptions) {
	let internal = $state(Math.max(1, options.default_page ?? 1));
	const siblings = options.siblings ?? 1;

	const current = $derived(Math.max(1, options.page ? options.page() : internal));
	const total = $derived(options.total_pages());
	const has_previous = $derived(
		options.has_previous ? options.has_previous() : current > 1
	);
	const has_next = $derived(
		options.has_next ? options.has_next() : total !== null ? current < total : false
	);
	const range = $derived(total !== null ? page_range(current, total, siblings) : []);

	function go(target: number): void {
		const upper = total !== null ? Math.max(1, total) : Number.POSITIVE_INFINITY;
		const next = Math.max(1, Math.min(upper, Math.trunc(target)));
		if (next === current) return;
		if (!options.page) internal = next;
		options.on_page_change?.(next);
	}

	function previous(): void {
		if (!has_previous) return;
		go(current - 1);
	}

	function next(): void {
		if (!has_next) return;
		go(current + 1);
	}

	function first(): void {
		if (has_previous) go(1);
	}

	function last(): void {
		if (total !== null && has_next) go(total);
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'pagination',
				...(meta.label !== undefined ? { label: meta.label } : {}),
				state: () => ({
					page: current,
					...(total !== null ? { pages: total } : {}),
					has_previous,
					has_next
				}),
				actions: {
					previous,
					next,
					go: (target) => {
						if (typeof target === 'number') go(target);
					}
				}
			})
		);
	}

	return {
		get page() {
			return current;
		},
		get pages() {
			return total;
		},
		get has_previous() {
			return has_previous;
		},
		get has_next() {
			return has_next;
		},
		get range() {
			return range;
		},
		go,
		previous,
		next,
		first,
		last
	};
}
