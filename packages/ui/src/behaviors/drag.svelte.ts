// Pointer-capture drag foundation, edge auto-scrolling, cross-container transfer (e.g. Kanban lanes)
// and hierarchical tree reordering — pointer + keyboard accessible with screen-reader announcements.
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';

/** Default movement threshold in CSS px before a press becomes a drag. */
export const DRAG_THRESHOLD = 4;

/** Live pointer position and delta reported by `bind_drag`. */
export type PointerSample = {
	readonly x: number;
	readonly y: number;
	readonly start_x: number;
	readonly start_y: number;
	readonly dx: number;
	readonly dy: number;
	readonly event: PointerEvent;
};

/** Options for `bind_drag`. */
export type BindDragOptions = {
	/** Movement in CSS px before `on_start`/`on_move` fire (default `DRAG_THRESHOLD`). */
	readonly threshold?: number;
	/** Return `false` to reject starting the drag. */
	readonly on_start?: (event: PointerEvent) => boolean | void;
	/** Called at most once per animation frame with latest pointer coordinates. */
	readonly on_move: (sample: PointerSample) => void;
	/** Called when the pointer lifts, cancels, or Escape aborts. */
	readonly on_end?: (event: PointerEvent | KeyboardEvent, canceled: boolean) => void;
	/** Cancel active drag on Escape (default `true`). */
	readonly cancel_on_escape?: boolean;
	/** Stop `pointerdown` propagation so nested drag surfaces do not both capture the gesture. */
	readonly stop_propagation?: boolean;
	/** Disable dragging reactively. */
	readonly disabled?: () => boolean;
};

/**
 * Pointer-capture drag attachment (`{@attach bind_drag(...)}`) with movement threshold,
 * animation-frame batching and optional Escape cancellation.
 */
export function bind_drag(options: BindDragOptions): Attachment<HTMLElement> {
	return (el) => {
		let abortActive: (() => void) | null = null;
		const onPointerDown = (down: PointerEvent) => {
			if (down.button !== 0 || options.disabled?.()) return;
			if (options.stop_propagation) {
				down.stopPropagation();
			}
			abortActive?.();
			const threshold = options.threshold ?? DRAG_THRESHOLD;
			const startX = down.clientX;
			const startY = down.clientY;
			let started = false;
			let raf = 0;
			let latest: PointerEvent = down;

			const flush = () => {
				raf = 0;
				options.on_move({
					x: latest.clientX,
					y: latest.clientY,
					start_x: startX,
					start_y: startY,
					dx: latest.clientX - startX,
					dy: latest.clientY - startY,
					event: latest
				});
			};

			const cleanup = () => {
				if (abortActive === cleanup) abortActive = null;
				if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
				raf = 0;
				window.removeEventListener('pointermove', onMove);
				window.removeEventListener('pointerup', onUp);
				window.removeEventListener('pointercancel', onCancel);
				document.removeEventListener('keydown', onKeydown, true);
				document.body.style.userSelect = '';
				try {
					if (el.hasPointerCapture?.(down.pointerId)) el.releasePointerCapture(down.pointerId);
				} catch {
					// Synthetic DOMs without active pointer capture.
				}
			};

			const finish = (event: PointerEvent | KeyboardEvent, canceled: boolean) => {
				if (raf !== 0 && !canceled) flush();
				cleanup();
				if (started) options.on_end?.(event, canceled);
			};

			const onMove = (move: PointerEvent) => {
				if (move.pointerId !== down.pointerId) return;
				latest = move;
				if (!started) {
					if (Math.hypot(move.clientX - startX, move.clientY - startY) < threshold) return;
					if (options.on_start?.(down) === false) {
						cleanup();
						return;
					}
					started = true;
					document.body.style.userSelect = 'none';
					try {
						el.setPointerCapture?.(down.pointerId);
					} catch {
						// Synthetic pointer events in tests.
					}
				}
				if (typeof requestAnimationFrame === 'function') {
					if (raf === 0) raf = requestAnimationFrame(flush);
				} else {
					flush();
				}
			};

			const onUp = (up: PointerEvent) => {
				if (up.pointerId !== down.pointerId) return;
				latest = up;
				finish(up, false);
			};

			const onCancel = (cancel: PointerEvent) => {
				if (cancel.pointerId !== down.pointerId) return;
				latest = cancel;
				finish(cancel, true);
			};

			const onKeydown = (key: KeyboardEvent) => {
				if (options.cancel_on_escape === false || !started || key.key !== 'Escape') return;
				key.preventDefault();
				key.stopPropagation();
				finish(key, true);
			};

			abortActive = cleanup;
			window.addEventListener('pointermove', onMove);
			window.addEventListener('pointerup', onUp);
			window.addEventListener('pointercancel', onCancel);
			document.addEventListener('keydown', onKeydown, true);
		};

		el.addEventListener('pointerdown', onPointerDown);
		return () => {
			abortActive?.();
			el.removeEventListener('pointerdown', onPointerDown);
		};
	};
}

/** Options for `create_auto_scroll`. */
export type AutoScrollOptions = {
	/** Edge proximity threshold in px where scrolling begins (default `48`). */
	readonly edge?: number;
	/** Maximum scroll speed in px/frame at the edge (default `18`). */
	readonly speed?: number;
	/** Called after each scrolled frame so drag hit-testing updates under a stationary pointer. */
	readonly on_scroll?: () => void;
	/** Optional element to ignore when hit-testing scrollers underneath the pointer. */
	readonly ignore?: () => Element | null | undefined;
};

/** Return value of `create_auto_scroll`. */
export type AutoScroll = ReturnType<typeof create_auto_scroll>;

function edgeVelocity(pos: number, start: number, end: number, edge: number, speed: number): number {
	const band = Math.min(edge, (end - start) / 3);
	if (band <= 0) return 0;
	if (pos < start + band) return -speed * Math.min(1, (start + band - pos) / band);
	if (pos > end - band) return speed * Math.min(1, (pos - (end - band)) / band);
	return 0;
}

function isScrollable(el: Element, axis: 'x' | 'y'): boolean {
	const style = getComputedStyle(el);
	const prop = axis === 'x' ? style.overflowX : style.overflowY;
	return /auto|scroll|overlay/.test(prop) && (axis === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight);
}

/**
 * Scrolls the innermost scrollable container under a dragging pointer (falling back to the window)
 * when the pointer approaches its edges.
 */
export function create_auto_scroll(options: AutoScrollOptions = {}) {
	const edge = options.edge ?? 48;
	const speed = options.speed ?? 18;
	let raf = 0;
	let px = 0;
	let py = 0;
	let active = false;

	function findTarget(x: number, y: number): Element | null {
		if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null;
		const ignored = options.ignore?.();
		for (const el of document.elementsFromPoint(x, y)) {
			if (ignored !== null && ignored !== undefined && (el === ignored || ignored.contains(el))) continue;
			if (isScrollable(el, 'x') || isScrollable(el, 'y')) return el;
		}
		return null;
	}

	function tickFrame(): void {
		raf = 0;
		if (!active || typeof window === 'undefined') return;
		const scroller = findTarget(px, py);
		let moved = false;

		if (scroller !== null) {
			const rect = scroller.getBoundingClientRect();
			const vx = isScrollable(scroller, 'x') ? edgeVelocity(px, rect.left, rect.right, edge, speed) : 0;
			const vy = isScrollable(scroller, 'y') ? edgeVelocity(py, rect.top, rect.bottom, edge, speed) : 0;
			if (vx !== 0 || vy !== 0) {
				const prevL = scroller.scrollLeft;
				const prevT = scroller.scrollTop;
				scroller.scrollLeft += vx;
				scroller.scrollTop += vy;
				moved = scroller.scrollLeft !== prevL || scroller.scrollTop !== prevT;
			}
		} else {
			const vx = edgeVelocity(px, 0, window.innerWidth, edge, speed);
			const vy = edgeVelocity(py, 0, window.innerHeight, edge, speed);
			if (vx !== 0 || vy !== 0) {
				const prevX = window.scrollX;
				const prevY = window.scrollY;
				window.scrollBy(vx, vy);
				moved = window.scrollX !== prevX || window.scrollY !== prevY;
			}
		}

		if (moved) {
			options.on_scroll?.();
			if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tickFrame);
		}
	}

	function update(x: number, y: number): void {
		px = x;
		py = y;
		active = true;
		if (raf === 0 && typeof requestAnimationFrame === 'function') {
			raf = requestAnimationFrame(tickFrame);
		}
	}

	function stop(): void {
		active = false;
		if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
		raf = 0;
	}

	return { update, stop };
}

/** Map of container keys to their ordered item keys. */
export type TransferLists = Readonly<Record<string, readonly string[]>>;

/** Live draft while an item is being transferred across containers. */
export type TransferDraft = {
	readonly key: string;
	readonly from: string;
	readonly lists: TransferLists;
};

/** Options for `create_transfer`. */
export type TransferOptions = {
	/** Ordered container keys (e.g. Kanban lane ids). */
	readonly containers: () => readonly string[];
	/** Current lists per container. */
	readonly lists: () => TransferLists;
	/** Called once on drop or keyboard commit with the next container map. */
	readonly on_commit: (next: TransferLists, move: { readonly key: string; readonly from: string; readonly to: string; readonly index: number }) => void;
	/** Optional predicate rejecting moves into a container. */
	readonly can_drop?: (key: string, toContainer: string) => boolean;
	/** Human-readable item label for screen-reader announcements. */
	readonly item_label?: (key: string) => string;
	/** Human-readable container label for screen-reader announcements. */
	readonly container_label?: (container: string) => string;
};

/** Return value of `create_transfer`. */
export type Transfer = ReturnType<typeof create_transfer>;

function transferItem(lists: TransferLists, key: string, to: string, index: number): Record<string, string[]> {
	const next: Record<string, string[]> = {};
	for (const [col, items] of Object.entries(lists)) {
		next[col] = items.filter((id) => id !== key);
	}
	const target = [...(next[to] ?? [])];
	const clamped = Math.max(0, Math.min(target.length, index));
	target.splice(clamped, 0, key);
	next[to] = target;
	return next;
}

/**
 * Headless cross-container drag-and-drop + keyboard transfer (Kanban boards, folder lists, team rosters)
 * with live draft preview, edge auto-scrolling and screen-reader announcements.
 */
export function create_transfer(options: TransferOptions) {
	let draft = $state<TransferDraft | null>(null);
	const containerEls = new Map<string, HTMLElement>();
	const itemEls = new Map<string, HTMLElement>();
	const scroller = create_auto_scroll();

	const currentLists = $derived(draft !== null ? draft.lists : options.lists());
	const labelOf = (key: string) => options.item_label?.(key) ?? key;
	const containerName = (id: string) => options.container_label?.(id) ?? id;

	function findContainer(lists: TransferLists, key: string): { container: string; index: number } | null {
		for (const [col, items] of Object.entries(lists)) {
			const idx = items.indexOf(key);
			if (idx >= 0) return { container: col, index: idx };
		}
		return null;
	}

	function move(key: string, to: string, index: number, commitNow = true): void {
		if (options.can_drop?.(key, to) === false) return;
		const base = currentLists;
		const located = findContainer(base, key);
		if (located === null) return;
		const next = transferItem(base, key, to, index);
		const finalIndex = next[to]?.indexOf(key) ?? 0;
		if (commitNow) {
			draft = null;
			options.on_commit(next, { key, from: located.container, to, index: finalIndex });
			announce(`Moved ${labelOf(key)} to ${containerName(to)}, position ${finalIndex + 1}`);
		} else {
			draft = { key, from: draft?.from ?? located.container, lists: next };
		}
	}

	function stepKeyboard(key: string, dr: number, dc: number): void {
		const cols = options.containers();
		const located = findContainer(currentLists, key);
		if (located === null) return;
		const colIdx = cols.indexOf(located.container);
		if (dc !== 0) {
			const nextCol = cols[colIdx + dc];
			if (nextCol === undefined) return;
			move(key, nextCol, located.index, true);
			return;
		}
		const colItems = currentLists[located.container] ?? [];
		const nextIdx = Math.max(0, Math.min(colItems.length - 1, located.index + dr));
		if (nextIdx !== located.index) move(key, located.container, nextIdx, true);
	}

	function hitTest(x: number, y: number, draggingKey: string): { container: string; index: number } | null {
		for (const [colId, colEl] of containerEls.entries()) {
			const rect = colEl.getBoundingClientRect();
			if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
			const items = (currentLists[colId] ?? []).filter((id) => id !== draggingKey);
			let insertAt = items.length;
			for (let i = 0; i < items.length; i++) {
				const id = items[i];
				if (id === undefined) continue;
				const el = itemEls.get(id);
				if (el === undefined) continue;
				const box = el.getBoundingClientRect();
				if (y < box.top + box.height / 2) {
					insertAt = i;
					break;
				}
			}
			return { container: colId, index: insertAt };
		}
		return null;
	}

	return {
		get lists() {
			return currentLists;
		},
		get draft() {
			return draft;
		},
		get dragging() {
			return draft?.key ?? null;
		},
		move,
		container(id: string): Attachment<HTMLElement> {
			return (el) => {
				containerEls.set(id, el);
				return () => {
					if (containerEls.get(id) === el) containerEls.delete(id);
				};
			};
		},
		item(key: string): Attachment<HTMLElement> {
			const drag = bind_drag({
				on_start: () => {
					const located = findContainer(options.lists(), key);
					if (located === null) return false;
					draft = { key, from: located.container, lists: options.lists() };
					announce(`Picked up ${labelOf(key)} from ${containerName(located.container)}`);
					return true;
				},
				on_move: (sample) => {
					scroller.update(sample.x, sample.y);
					const hit = hitTest(sample.x, sample.y, key);
					if (hit !== null) move(key, hit.container, hit.index, false);
				},
				on_end: (_event, canceled) => {
					scroller.stop();
					const active = draft;
					draft = null;
					if (active === null) return;
					if (canceled) {
						announce(`Canceled moving ${labelOf(key)}`);
						return;
					}
					const landed = findContainer(active.lists, key);
					if (landed === null) return;
					options.on_commit(active.lists, {
						key,
						from: active.from,
						to: landed.container,
						index: landed.index
					});
					announce(`Dropped ${labelOf(key)} in ${containerName(landed.container)}, position ${landed.index + 1}`);
				}
			});
			return (el) => {
				itemEls.set(key, el);
				const stopDrag = drag(el);
				return () => {
					stopDrag?.();
					if (itemEls.get(key) === el) itemEls.delete(key);
				};
			};
		},
		item_attrs(key: string) {
			return {
				'data-dragging': draft?.key === key ? '' : undefined,
				onkeydown: (event: KeyboardEvent) => {
					if (!event.altKey) return;
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						stepKeyboard(key, -1, 0);
					} else if (event.key === 'ArrowDown') {
						event.preventDefault();
						stepKeyboard(key, 1, 0);
					} else if (event.key === 'ArrowLeft') {
						event.preventDefault();
						stepKeyboard(key, 0, -1);
					} else if (event.key === 'ArrowRight') {
						event.preventDefault();
						stepKeyboard(key, 0, 1);
					}
				}
			};
		}
	};
}

/** One flattened row accepted by `create_tree_reorder`. */
export type TreeReorderRow = {
	readonly id: string;
	readonly depth: number;
	readonly parent: string | null;
	readonly label?: string;
};

/** Drop placement relative to a target tree row. */
export type TreePlace = {
	readonly target: string;
	readonly position: 'before' | 'inside' | 'after';
};

/** Returns the exclusive index past the subtree rooted at `index` in a pre-order flat row array. */
export function subtree_end(rows: readonly TreeReorderRow[], index: number): number {
	const root = rows[index];
	if (root === undefined) return index;
	let end = index + 1;
	while (end < rows.length && (rows[end]?.depth ?? 0) > root.depth) end++;
	return end;
}

/** Options for `create_tree_reorder`. */
export type TreeReorderOptions = {
	/** Visible pre-order tree rows. */
	readonly rows: () => readonly TreeReorderRow[];
	/** Invoked when a node (with its subtree) moves to `place`. */
	readonly on_move: (id: string, place: TreePlace) => void;
	/** Optional predicate forbidding drops into/around a target. */
	readonly can_drop?: (id: string, place: TreePlace) => boolean;
};

/** Return value of `create_tree_reorder`. */
export type TreeReorder = ReturnType<typeof create_tree_reorder>;

/**
 * Headless hierarchical tree reordering (pointer drop zones: top 25% `before`, middle 50% `inside`,
 * bottom 25% `after`; plus `Alt+ArrowUp/Down/Left/Right` keyboard reparenting) with subtree cycle guard.
 */
export function create_tree_reorder(options: TreeReorderOptions) {
	let dragging = $state<string | null>(null);
	let drop = $state<TreePlace | null>(null);
	const rowEls = new Map<string, HTMLElement>();

	function isDescendant(ancestorId: string, candidateId: string): boolean {
		const rows = options.rows();
		const start = rows.findIndex((r) => r.id === ancestorId);
		if (start < 0) return false;
		const end = subtree_end(rows, start);
		for (let i = start; i < end; i++) {
			if (rows[i]?.id === candidateId) return true;
		}
		return false;
	}

	function commit(id: string, place: TreePlace): void {
		if (id === place.target || isDescendant(id, place.target)) return;
		if (options.can_drop?.(id, place) === false) return;
		options.on_move(id, place);
		const rows = options.rows();
		const name = rows.find((r) => r.id === id)?.label ?? id;
		const targetName = rows.find((r) => r.id === place.target)?.label ?? place.target;
		announce(`Moved ${name} ${place.position} ${targetName}`);
	}

	function hitTest(y: number, draggingId: string): TreePlace | null {
		for (const row of options.rows()) {
			if (row.id === draggingId || isDescendant(draggingId, row.id)) continue;
			const el = rowEls.get(row.id);
			if (el === undefined) continue;
			const rect = el.getBoundingClientRect();
			if (y < rect.top || y > rect.bottom) continue;
			const ratio = (y - rect.top) / Math.max(1, rect.height);
			const position: TreePlace['position'] = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
			const candidate: TreePlace = { target: row.id, position };
			if (options.can_drop?.(draggingId, candidate) === false) return null;
			return candidate;
		}
		return null;
	}

	function moveKey(id: string, key: string): void {
		const rows = options.rows();
		const idx = rows.findIndex((r) => r.id === id);
		const row = rows[idx];
		if (row === undefined) return;
		if (key === 'ArrowUp' && idx > 0) {
			const prev = rows[idx - 1];
			if (prev !== undefined) commit(id, { target: prev.id, position: 'before' });
		} else if (key === 'ArrowDown') {
			const afterSub = subtree_end(rows, idx);
			const next = rows[afterSub];
			if (next !== undefined) commit(id, { target: next.id, position: 'after' });
		} else if (key === 'ArrowRight' && idx > 0) {
			const prev = rows[idx - 1];
			if (prev !== undefined) commit(id, { target: prev.id, position: 'inside' });
		} else if (key === 'ArrowLeft' && row.parent !== null) {
			commit(id, { target: row.parent, position: 'after' });
		}
	}

	return {
		get dragging() {
			return dragging;
		},
		get drop() {
			return drop;
		},
		commit,
		item(id: string): Attachment<HTMLElement> {
			const drag = bind_drag({
				on_start: () => {
					dragging = id;
					return true;
				},
				on_move: (sample) => {
					drop = hitTest(sample.y, id);
				},
				on_end: (_event, canceled) => {
					const place = drop;
					dragging = null;
					drop = null;
					if (!canceled && place !== null) commit(id, place);
				}
			});
			return (el) => {
				rowEls.set(id, el);
				const stop = drag(el);
				return () => {
					stop?.();
					if (rowEls.get(id) === el) rowEls.delete(id);
				};
			};
		},
		item_attrs(id: string) {
			const dropPos = drop?.target === id ? drop.position : undefined;
			return {
				'data-dragging': dragging === id ? '' : undefined,
				'data-drop-position': dropPos,
				onkeydown: (event: KeyboardEvent) => {
					if (!event.altKey) return;
					if (
						event.key === 'ArrowUp' ||
						event.key === 'ArrowDown' ||
						event.key === 'ArrowLeft' ||
						event.key === 'ArrowRight'
					) {
						event.preventDefault();
						moveKey(id, event.key);
					}
				}
			};
		}
	};
}
