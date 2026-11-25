// 2D data-grid behaviors:
// - `create_grid_focus`: index-based `(row, col)` roving focus over virtualized or full grids
// - `create_cell_range`: rectangular spreadsheet selection + TSV copy/paste (`cells_to_text`/`text_to_cells`)
// - `create_inline_edit`: in-place cell/title editing (Enter/F2/type-to-edit, Escape revert, Tab advance)
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';

/** Zero-based `(row, col)` coordinate in a 2D grid. */
export type GridCell = { readonly row: number; readonly col: number };

/** Rectangular cell range from `anchor` to `end`. */
export type CellRange = { readonly anchor: GridCell; readonly end: GridCell };

/** Normalized inclusive rectangular bounds of a `CellRange`. */
export type CellBounds = {
	readonly top: number;
	readonly left: number;
	readonly bottom: number;
	readonly right: number;
};

/** Options for `create_grid_focus`. */
export type GridFocusOptions = {
	/** Total row count. */
	readonly rows: () => number;
	/** Total column count. */
	readonly cols: () => number;
	/** Controlled active cell; omit for internal state. */
	readonly active?: () => GridCell | null;
	/** Called whenever the active cell moves. */
	readonly on_move?: (cell: GridCell, details: { readonly from: GridCell | null; readonly shift: boolean }) => void;
	/** Rows skipped by PageUp / PageDown (default `10`). */
	readonly page_size?: number | (() => number);
	/** Skip cells matching this predicate. */
	readonly disabled?: (cell: GridCell) => boolean;
	/** Scroll an unrendered virtualized cell into view before focusing. */
	readonly reveal?: (cell: GridCell) => void;
};

/** Return value of `create_grid_focus`. */
export type GridFocus = ReturnType<typeof create_grid_focus>;

const cellKey = (cell: GridCell) => `${cell.row}:${cell.col}`;
const sameCell = (a: GridCell | null | undefined, b: GridCell | null | undefined) =>
	a !== null && a !== undefined && b !== null && b !== undefined && a.row === b.row && a.col === b.col;

/**
 * Headless WAI-ARIA 2D grid roving focus manager supporting Arrow keys (RTL-aware), Home/End,
 * Ctrl/Cmd+Home/End, PageUp/PageDown and virtualized row reveal.
 */
export function create_grid_focus(options: GridFocusOptions) {
	let internal = $state<GridCell | null>(null);
	let pendingFocus: GridCell | null = null;
	const nodes = new Map<string, HTMLElement>();

	const active = $derived.by((): GridCell | null => {
		const raw = options.active ? options.active() : internal;
		const rows = options.rows();
		const cols = options.cols();
		if (rows <= 0 || cols <= 0) return null;
		if (raw !== null && raw.row >= 0 && raw.row < rows && raw.col >= 0 && raw.col < cols) return raw;
		return { row: 0, col: 0 };
	});

	const isDisabled = (cell: GridCell) => options.disabled?.(cell) === true;
	const pageSize = () =>
		typeof options.page_size === 'function' ? options.page_size() : (options.page_size ?? 10);

	function focusCell(cell: GridCell, shift = false): void {
		const rows = options.rows();
		const cols = options.cols();
		if (rows <= 0 || cols <= 0) return;
		const next: GridCell = {
			row: Math.max(0, Math.min(rows - 1, cell.row)),
			col: Math.max(0, Math.min(cols - 1, cell.col))
		};
		if (isDisabled(next)) return;
		const prev = active;
		if (!options.active) internal = next;
		options.on_move?.(next, { from: prev, shift });
		options.reveal?.(next);
		const el = nodes.get(cellKey(next));
		if (el !== undefined) {
			pendingFocus = null;
			el.focus({ preventScroll: false });
		} else {
			pendingFocus = next;
		}
	}

	function step(dr: number, dc: number, shift: boolean): void {
		const cur = active ?? { row: 0, col: 0 };
		const rows = options.rows();
		const cols = options.cols();
		let r = cur.row + dr;
		let c = cur.col + dc;
		while (r >= 0 && r < rows && c >= 0 && c < cols) {
			const candidate = { row: r, col: c };
			if (!isDisabled(candidate)) {
				focusCell(candidate, shift);
				return;
			}
			r += Math.sign(dr);
			c += Math.sign(dc);
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		const rows = options.rows();
		const cols = options.cols();
		if (rows <= 0 || cols <= 0) return;
		const cur = active ?? { row: 0, col: 0 };
		const rtl =
			event.currentTarget instanceof HTMLElement &&
			getComputedStyle(event.currentTarget).direction === 'rtl';
		const dir = rtl ? -1 : 1;
		const corner = event.ctrlKey || event.metaKey;

		switch (event.key) {
			case 'ArrowRight':
				event.preventDefault();
				step(0, dir, event.shiftKey);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				step(0, -dir, event.shiftKey);
				break;
			case 'ArrowDown':
				event.preventDefault();
				step(1, 0, event.shiftKey);
				break;
			case 'ArrowUp':
				event.preventDefault();
				step(-1, 0, event.shiftKey);
				break;
			case 'Home':
				event.preventDefault();
				focusCell(corner ? { row: 0, col: 0 } : { row: cur.row, col: 0 }, event.shiftKey);
				break;
			case 'End':
				event.preventDefault();
				focusCell(
					corner ? { row: rows - 1, col: cols - 1 } : { row: cur.row, col: cols - 1 },
					event.shiftKey
				);
				break;
			case 'PageDown':
				event.preventDefault();
				focusCell({ row: Math.min(rows - 1, cur.row + pageSize()), col: cur.col }, event.shiftKey);
				break;
			case 'PageUp':
				event.preventDefault();
				focusCell({ row: Math.max(0, cur.row - pageSize()), col: cur.col }, event.shiftKey);
				break;
		}
	}

	return {
		get active() {
			return active;
		},
		focus: focusCell,
		cell(cell: GridCell): Attachment<HTMLElement> {
			const key = cellKey(cell);
			return (el) => {
				nodes.set(key, el);
				if (sameCell(pendingFocus, cell)) {
					pendingFocus = null;
					el.focus({ preventScroll: false });
				}
				return () => {
					if (nodes.get(key) === el) nodes.delete(key);
				};
			};
		},
		grid_attrs() {
			return {
				role: 'grid' as const,
				'aria-rowcount': options.rows(),
				'aria-colcount': options.cols(),
				onkeydown: handleKeydown
			};
		},
		cell_attrs(cell: GridCell) {
			const off = isDisabled(cell);
			const isActive = !off && sameCell(active, cell);
			return {
				role: 'gridcell' as const,
				'aria-rowindex': cell.row + 1,
				'aria-colindex': cell.col + 1,
				'aria-disabled': off ? (true as const) : undefined,
				'data-active': isActive ? '' : undefined,
				tabindex: off ? undefined : isActive ? 0 : -1,
				onfocus: () => {
					if (!off && !sameCell(active, cell)) {
						const prev = active;
						if (!options.active) internal = cell;
						options.on_move?.(cell, { from: prev, shift: false });
					}
				}
			};
		}
	};
}

/** Normalizes any `CellRange` into `{ top, left, bottom, right }` inclusive bounds. */
export function cell_bounds(range: CellRange): CellBounds {
	return {
		top: Math.min(range.anchor.row, range.end.row),
		bottom: Math.max(range.anchor.row, range.end.row),
		left: Math.min(range.anchor.col, range.end.col),
		right: Math.max(range.anchor.col, range.end.col)
	};
}

/** Serializes a 2D cell range to spreadsheet-compatible tab-separated text (TSV). */
export function cells_to_text(bounds: CellBounds, read: (cell: GridCell) => string): string {
	const lines: string[] = [];
	for (let r = bounds.top; r <= bounds.bottom; r++) {
		const cols: string[] = [];
		for (let c = bounds.left; c <= bounds.right; c++) {
			const value = read({ row: r, col: c });
			cols.push(/[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
		}
		lines.push(cols.join('\t'));
	}
	return lines.join('\n');
}

/** Parses tab-separated clipboard text (TSV) into a 2D matrix of strings. */
export function text_to_cells(text: string): string[][] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	if (normalized === '') return [];
	const rows = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n');
	return rows.map((line) => line.split('\t'));
}

/** Options for `create_cell_range`. */
export type CellRangeOptions = {
	/** Total row count. */
	readonly rows: () => number;
	/** Total column count. */
	readonly cols: () => number;
	/** Controlled range; omit for internal state. */
	readonly range?: () => CellRange | null;
	/** Called when the selected cell range changes. */
	readonly on_change?: (range: CellRange | null) => void;
	/** Optional live-region message formatter on range updates. */
	readonly message?: (bounds: CellBounds) => string;
};

/** Return value of `create_cell_range`. */
export type CellRangeBehavior = ReturnType<typeof create_cell_range>;

/**
 * Rectangular spreadsheet cell-range selection with pointer drag painting, Shift-click/arrow
 * extension, Ctrl+Space column / Shift+Space row selection, TSV copy/paste and screen-reader announcements.
 */
export function create_cell_range(options: CellRangeOptions) {
	let internal = $state<CellRange | null>(null);
	let painting = $state(false);

	const range = $derived(options.range ? options.range() : internal);
	const bounds = $derived(range === null ? null : cell_bounds(range));

	function commit(next: CellRange | null, notify = false): void {
		if (!options.range) internal = next;
		options.on_change?.(next);
		if (notify && next !== null) {
			const b = cell_bounds(next);
			const rCount = b.bottom - b.top + 1;
			const cCount = b.right - b.left + 1;
			announce(
				options.message?.(b) ??
					`${rCount} ${rCount === 1 ? 'row' : 'rows'} by ${cCount} ${cCount === 1 ? 'column' : 'columns'} selected`
			);
		}
	}

	function start(cell: GridCell): void {
		commit({ anchor: cell, end: cell });
	}

	function extend(to: GridCell, from?: GridCell, notify = false): void {
		const anchor = range?.anchor ?? from ?? to;
		commit({ anchor, end: to }, notify);
	}

	function select_row(row: number): void {
		const cols = options.cols();
		if (cols <= 0) return;
		commit({ anchor: { row, col: 0 }, end: { row, col: cols - 1 } }, true);
	}

	function select_col(col: number): void {
		const rows = options.rows();
		if (rows <= 0) return;
		commit({ anchor: { row: 0, col }, end: { row: rows - 1, col } }, true);
	}

	function clear(): void {
		commit(null);
	}

	function contains(cell: GridCell): boolean {
		if (bounds === null) return false;
		return (
			cell.row >= bounds.top &&
			cell.row <= bounds.bottom &&
			cell.col >= bounds.left &&
			cell.col <= bounds.right
		);
	}

	return {
		get range() {
			return range;
		},
		get bounds() {
			return bounds;
		},
		get dragging() {
			return painting;
		},
		start,
		extend,
		select_row,
		select_col,
		clear,
		contains,
		to_text(read: (cell: GridCell) => string): string {
			return bounds === null ? '' : cells_to_text(bounds, read);
		},
		cell_attrs(cell: GridCell) {
			const selected = contains(cell);
			return {
				'aria-selected': selected,
				'data-in-range': selected ? '' : undefined,
				onpointerdown: (event: PointerEvent) => {
					if (event.button !== 0) return;
					if (event.shiftKey) {
						extend(cell);
						return;
					}
					painting = true;
					start(cell);
					const up = () => {
						painting = false;
						window.removeEventListener('pointerup', up);
						window.removeEventListener('pointercancel', up);
					};
					window.addEventListener('pointerup', up);
					window.addEventListener('pointercancel', up);
				},
				onpointerenter: () => {
					if (painting) extend(cell);
				}
			};
		}
	};
}

/** Why an inline edit started or finished. */
export type InlineEditReason =
	| 'edit-key'
	| 'type'
	| 'double-click'
	| 'enter-key'
	| 'escape-key'
	| 'focus-out'
	| 'tab-key'
	| 'imperative';

/** Options for `create_inline_edit`. */
export type InlineEditOptions = {
	/** Reads the current text for `id` when editing starts. */
	readonly value: (id: string) => string;
	/** Persists the edited text; return `false` to keep editing (e.g. validation error). */
	readonly commit: (id: string, text: string, reason: InlineEditReason) => boolean | void;
	/** Optional disabled predicate per id. */
	readonly disabled?: (id: string) => boolean;
	/** Called when Tab commits so an enclosing grid can advance to the next/previous cell. */
	readonly on_tab?: (id: string, direction: 1 | -1) => void;
};

/** Return value of `create_inline_edit`. */
export type InlineEdit = ReturnType<typeof create_inline_edit>;

/**
 * Headless edit-in-place behavior for table cells, card titles and tree labels:
 * Enter/F2/double-click edits preserving value, printable key replaces value, Enter/blur/Tab
 * commits, Escape reverts and focus restores to the originating cell.
 */
export function create_inline_edit(options: InlineEditOptions) {
	let editing = $state<string | null>(null);
	let draft = $state('');
	let originEl: HTMLElement | null = null;
	let selectAllOnMount = false;

	function restoreOrigin(): void {
		const el = originEl;
		originEl = null;
		if (el !== null && el.isConnected) {
			queueMicrotask(() => el.focus({ preventScroll: true }));
		}
	}

	function begin(id: string, reason: InlineEditReason, initial?: string, origin?: HTMLElement | null): void {
		if (options.disabled?.(id)) return;
		originEl = origin ?? (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
		editing = id;
		draft = initial ?? options.value(id);
		selectAllOnMount = initial === undefined;
	}

	function end(reason: InlineEditReason, save = true): boolean {
		const id = editing;
		if (id === null) return false;
		if (save) {
			const ok = options.commit(id, draft, reason);
			if (ok === false) return false;
		}
		editing = null;
		draft = '';
		if (reason !== 'focus-out') restoreOrigin();
		return true;
	}

	function cancel(reason: InlineEditReason = 'escape-key'): void {
		end(reason, false);
	}

	const input: Attachment<HTMLInputElement | HTMLTextAreaElement> = (el) => {
		el.focus({ preventScroll: true });
		if (selectAllOnMount) el.select();
		else el.setSelectionRange(el.value.length, el.value.length);
	};

	return {
		get editing() {
			return editing;
		},
		get draft() {
			return draft;
		},
		set draft(value: string) {
			draft = value;
		},
		is_editing(id: string): boolean {
			return editing === id;
		},
		begin,
		commit: (reason: InlineEditReason = 'imperative') => end(reason, true),
		cancel,
		input,
		cell_attrs(id: string) {
			return {
				'data-editing': editing === id ? '' : undefined,
				ondblclick: (event: MouseEvent) => {
					const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
					begin(id, 'double-click', undefined, target);
				},
				onkeydown: (event: KeyboardEvent) => {
					if (editing === id || event.isComposing) return;
					const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
					if (event.key === 'F2' || event.key === 'Enter') {
						event.preventDefault();
						begin(id, 'edit-key', undefined, target);
						return;
					}
					if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== ' ') {
						event.preventDefault();
						begin(id, 'type', event.key, target);
					}
				}
			};
		},
		input_attrs() {
			return {
				value: draft,
				oninput: (event: Event) => {
					if (event.currentTarget instanceof HTMLInputElement || event.currentTarget instanceof HTMLTextAreaElement) {
						draft = event.currentTarget.value;
					}
				},
				onkeydown: (event: KeyboardEvent) => {
					if (event.isComposing) return;
					if (event.key === 'Enter' && !(event.currentTarget instanceof HTMLTextAreaElement && event.shiftKey)) {
						event.preventDefault();
						event.stopPropagation();
						end('enter-key', true);
					} else if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						cancel('escape-key');
					} else if (event.key === 'Tab') {
						const id = editing;
						if (id !== null && end('tab-key', true)) {
							event.preventDefault();
							options.on_tab?.(id, event.shiftKey ? -1 : 1);
						}
					}
				},
				onblur: () => {
					if (editing !== null) end('focus-out', true);
				}
			};
		}
	};
}
