// Responsive horizontal overflow splitting: keeps what fits in the strip and routes the rest
// to a `More` menu. Vertical flex columns never clip. Used directly by `Tabs` and `TabStrip` and
// exported for custom toolbars, chip strips and action bars.
import type { Attachment } from 'svelte/attachments';
import { observeTabOverflow } from '../primitives/tabs/overflow.js';

/** Options for `create_overflow`. */
export type OverflowOptions<T> = {
	/** All items in display order. */
	items: () => readonly T[];
	/** Key extractor for checking whether the active item is currently inside the overflow menu. */
	key?: (item: T) => string;
	/** Currently active key (optional). */
	active?: () => string | undefined;
};

/** Return value of `create_overflow`. */
export type Overflow<T> = ReturnType<typeof create_overflow<T>>;

/**
 * Headless ResizeObserver-backed overflow behavior. Attach `list` to the visible strip and
 * `measure` to an off-screen mirror containing every item plus the trailing overflow trigger;
 * read `visible`, `hidden` and `active_in_hidden` reactively.
 */
export function create_overflow<T>(options: OverflowOptions<T>) {
	let listEl: HTMLElement | null = null;
	let measureEl: HTMLElement | null = null;
	let stop: (() => void) | null = null;
	let fit = $state(Infinity);
	let more_open = $state(false);

	function reconnect(): void {
		stop?.();
		stop = null;
		if (listEl !== null && measureEl !== null) {
			stop = observeTabOverflow(listEl, measureEl, (count) => {
				fit = count;
			});
		}
	}

	const visible = $derived.by(() => {
		const all = options.items();
		return fit >= all.length ? all : all.slice(0, fit);
	});
	const empty: readonly T[] = [];
	const hidden = $derived.by(() => {
		const all = options.items();
		return fit >= all.length ? empty : all.slice(fit);
	});
	const active_in_hidden = $derived.by(() => {
		const activeKey = options.active?.();
		const keyOf = options.key;
		if (activeKey === undefined || keyOf === undefined) return false;
		return hidden.some((item) => keyOf(item) === activeKey);
	});

	const list: Attachment<HTMLElement> = (el) => {
		listEl = el;
		reconnect();
		return () => {
			if (listEl === el) {
				listEl = null;
				reconnect();
			}
		};
	};

	const measure: Attachment<HTMLElement> = (el) => {
		measureEl = el;
		reconnect();
		return () => {
			if (measureEl === el) {
				measureEl = null;
				reconnect();
			}
		};
	};

	return {
		get fit() {
			return fit;
		},
		get visible() {
			return visible;
		},
		get hidden() {
			return hidden;
		},
		get has_overflow() {
			return hidden.length > 0;
		},
		get active_in_hidden() {
			return active_in_hidden;
		},
		get more_open() {
			return more_open;
		},
		set more_open(value: boolean) {
			more_open = value;
		},
		list,
		measure
	};
}
