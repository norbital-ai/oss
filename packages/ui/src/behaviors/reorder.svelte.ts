// Pointer + HTML5 drag + keyboard list reordering over ordered string keys.
// Supports pointer-capture drag (`item(key)` attachment) with edge auto-scroll, HTML5 `draggable`
// fallback (`item_attrs(key)`), `Alt+Arrow` keyboard reordering and screen-reader announcements.
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';
import { bind_drag, create_auto_scroll } from './drag.svelte.js';

/** Axis for keyboard and pointer reordering (`'vertical'` or `'horizontal'`). */
export type ReorderOrientation = 'vertical' | 'horizontal';

/** Options for `create_reorder`. */
export type ReorderOptions = {
	/** Ordered item keys. */
	readonly items: () => readonly string[];
	/** Invoked with `(fromIndex, toIndex, nextOrder)` when an item moves. */
	readonly on_reorder: (from: number, to: number, next: readonly string[]) => void;
	/** Axis for movement (default `'vertical'`). */
	readonly orientation?: ReorderOrientation;
	/** Disable reordering globally or for a specific key. */
	readonly disabled?: boolean | ((key: string) => boolean);
	/** Optional human-readable label per key for live announcements. */
	readonly label?: (key: string) => string;
};

/** Return value of `create_reorder`. */
export type Reorder = ReturnType<typeof create_reorder>;

/** Returns a new array with the item at `from` moved to `to`. */
export function move_item<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
		return [...list];
	}
	const next = [...list];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/**
 * Headless pointer + keyboard reordering behavior for queues, lanes, checklists and columns.
 */
export function create_reorder(options: ReorderOptions) {
	let dragging = $state<string | null>(null);
	let over = $state<string | null>(null);
	const itemEls = new Map<string, HTMLElement>();
	const scroller = create_auto_scroll();

	const horizontal = options.orientation === 'horizontal';
	const isDisabled = (key: string) =>
		typeof options.disabled === 'function' ? options.disabled(key) : (options.disabled ?? false);
	const labelOf = (key: string) => options.label?.(key) ?? key;

	function commit(fromIndex: number, toIndex: number): void {
		const list = options.items();
		if (fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) return;
		if (fromIndex === toIndex) return;
		const movedKey = list[fromIndex];
		options.on_reorder(fromIndex, toIndex, move_item(list, fromIndex, toIndex));
		if (movedKey !== undefined) {
			announce(`Moved ${labelOf(movedKey)} to position ${toIndex + 1} of ${list.length}`);
		}
	}

	function move_by(key: string, delta: number): void {
		if (isDisabled(key)) return;
		const list = options.items();
		const from = list.indexOf(key);
		if (from < 0) return;
		const to = Math.max(0, Math.min(list.length - 1, from + delta));
		commit(from, to);
	}

	function hitKey(x: number, y: number, selfKey: string): string | null {
		for (const key of options.items()) {
			if (key === selfKey || isDisabled(key)) continue;
			const el = itemEls.get(key);
			if (el === undefined) continue;
			const rect = el.getBoundingClientRect();
			const inside = horizontal
				? x >= rect.left && x <= rect.right
				: y >= rect.top && y <= rect.bottom;
			if (inside) return key;
		}
		return null;
	}

	return {
		get dragging() {
			return dragging;
		},
		get over() {
			return over;
		},
		move(fromIndex: number, toIndex: number) {
			commit(fromIndex, toIndex);
		},
		move_by,
		/** Optional pointer-capture drag attachment (works cleanly on touch & supports edge auto-scroll + Escape cancel). */
		item(key: string): Attachment<HTMLElement> {
			const drag = bind_drag({
				disabled: () => isDisabled(key),
				on_start: () => {
					dragging = key;
					over = null;
					announce(`Picked up ${labelOf(key)}`);
					return true;
				},
				on_move: (sample) => {
					scroller.update(sample.x, sample.y);
					over = hitKey(sample.x, sample.y, key);
				},
				on_end: (_event, canceled) => {
					scroller.stop();
					const target = over;
					dragging = null;
					over = null;
					if (canceled) {
						announce(`Canceled moving ${labelOf(key)}`);
						return;
					}
					if (target !== null) {
						const list = options.items();
						commit(list.indexOf(key), list.indexOf(target));
					}
				}
			});
			return (el) => {
				itemEls.set(key, el);
				const stop = drag(el);
				return () => {
					stop?.();
					if (itemEls.get(key) === el) itemEls.delete(key);
				};
			};
		},
		item_attrs(key: string) {
			const off = isDisabled(key);
			const prevKey = horizontal ? 'ArrowLeft' : 'ArrowUp';
			const nextKey = horizontal ? 'ArrowRight' : 'ArrowDown';
			return {
				draggable: !off,
				'data-dragging': dragging === key ? '' : undefined,
				'data-drop-target': over === key && dragging !== key ? '' : undefined,
				ondragstart: (event: DragEvent) => {
					if (off) {
						event.preventDefault();
						return;
					}
					dragging = key;
					if (event.dataTransfer) {
						event.dataTransfer.effectAllowed = 'move';
						event.dataTransfer.setData('text/plain', key);
					}
				},
				ondragover: (event: DragEvent) => {
					if (dragging === null || off) return;
					event.preventDefault();
					if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
					if (over !== key) over = key;
				},
				ondragleave: () => {
					if (over === key) over = null;
				},
				ondrop: (event: DragEvent) => {
					if (dragging === null || off) return;
					event.preventDefault();
					const list = options.items();
					const from = list.indexOf(dragging);
					const to = list.indexOf(key);
					dragging = null;
					over = null;
					commit(from, to);
				},
				ondragend: () => {
					dragging = null;
					over = null;
				},
				onkeydown: (event: KeyboardEvent) => {
					if (off || !event.altKey) return;
					if (event.key === prevKey) {
						event.preventDefault();
						move_by(key, -1);
					} else if (event.key === nextKey) {
						event.preventDefault();
						move_by(key, 1);
					}
				}
			};
		}
	};
}
