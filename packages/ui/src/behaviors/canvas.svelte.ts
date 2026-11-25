// Direct-manipulation and canvas behaviors:
// - `create_move`: 2D free drag + keyboard nudge with optional grid snapping
// - `create_area`: 2D normalized X/Y slider plane (color pickers, XY pads)
// - `create_spans` (+ `is_span_free`, `stack_spans`): draw, move and resize time/track spans
// - `create_lasso`: rubber-band marquee drag selection
// - `create_viewport`: pan/zoom canvas camera transform
// - `create_connect`: port-to-port edge wiring on node graphs
// - `create_swipe_actions`: row swipe-to-reveal & full-swipe action with keyboard fallback
// - `bind_scroll_picker`: scroll-snap wheel picker exposing `--picker-offset`
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';
import { bind_drag } from './drag.svelte.js';

/** 2D coordinate point. */
export type MovePoint = { readonly x: number; readonly y: number };

/** Options for `create_move`. */
export type MoveOptions = {
	readonly position: () => MovePoint;
	readonly on_change: (next: MovePoint) => void;
	readonly on_commit?: (final: MovePoint) => void;
	readonly step?: number;
	readonly grid?: number;
	readonly bounds?: () => { readonly min_x: number; readonly max_x: number; readonly min_y: number; readonly max_y: number };
	readonly scale?: () => number;
	readonly label?: string;
};

/** Return value of `create_move`. */
export type MoveBehavior = ReturnType<typeof create_move>;

function snap(value: number, grid: number | undefined): number {
	if (grid === undefined || grid <= 0) return value;
	return Math.round(value / grid) * grid;
}

/**
 * Headless 2D free-move behavior (pointer drag + Arrow keys, optional grid snap & bounds).
 */
export function create_move(options: MoveOptions) {
	let dragging = $state(false);
	const step = options.step ?? 10;

	function clamp(pt: MovePoint): MovePoint {
		let x = snap(pt.x, options.grid);
		let y = snap(pt.y, options.grid);
		const b = options.bounds?.();
		if (b !== undefined) {
			x = Math.max(b.min_x, Math.min(b.max_x, x));
			y = Math.max(b.min_y, Math.min(b.max_y, y));
		}
		return { x, y };
	}

	let startPt: MovePoint = { x: 0, y: 0 };
	let latestPt: MovePoint = { x: 0, y: 0 };

	const handle = bind_drag({
		on_start: () => {
			startPt = options.position();
			latestPt = startPt;
			dragging = true;
			return true;
		},
		on_move: (sample) => {
			const scale = options.scale?.() ?? 1;
			latestPt = clamp({ x: startPt.x + sample.dx / scale, y: startPt.y + sample.dy / scale });
			options.on_change(latestPt);
		},
		on_end: (_event, canceled) => {
			dragging = false;
			if (canceled) {
				options.on_change(startPt);
			} else {
				options.on_commit?.(latestPt);
			}
		}
	});

	function onkeydown(event: KeyboardEvent): void {
		const mult = event.shiftKey ? 5 : 1;
		const inc = (options.grid ?? step) * mult;
		const cur = options.position();
		let next: MovePoint | null = null;
		if (event.key === 'ArrowRight') next = clamp({ x: cur.x + inc, y: cur.y });
		else if (event.key === 'ArrowLeft') next = clamp({ x: cur.x - inc, y: cur.y });
		else if (event.key === 'ArrowDown') next = clamp({ x: cur.x, y: cur.y + inc });
		else if (event.key === 'ArrowUp') next = clamp({ x: cur.x, y: cur.y - inc });
		if (next === null) return;
		event.preventDefault();
		options.on_change(next);
		options.on_commit?.(next);
		if (options.label !== undefined) announce(`${options.label} moved to ${next.x}, ${next.y}`);
	}

	return {
		get dragging() {
			return dragging;
		},
		handle,
		handle_attrs() {
			return {
				tabindex: 0,
				'aria-label': options.label,
				'data-dragging': dragging ? '' : undefined,
				onkeydown
			};
		}
	};
}

/** 2D slider coordinates `{ x, y }`. */
export type AreaValue = { readonly x: number; readonly y: number };

/** Options for `create_area`. */
export type AreaOptions = {
	readonly value?: () => AreaValue;
	readonly default_value?: AreaValue;
	readonly on_change?: (value: AreaValue) => void;
	readonly on_commit?: (value: AreaValue) => void;
	readonly min_x?: number;
	readonly max_x?: number;
	readonly min_y?: number;
	readonly max_y?: number;
	readonly step_x?: number;
	readonly step_y?: number;
	readonly label?: string;
};

/** Return value of `create_area`. */
export type AreaBehavior = ReturnType<typeof create_area>;

function quantizeStep(raw: number, min: number, max: number, step: number): number {
	const clamped = Math.max(min, Math.min(max, raw));
	const stepped = Math.round((clamped - min) / step) * step + min;
	const decimals = String(step).split('.')[1]?.length ?? 0;
	return Number(Math.max(min, Math.min(max, stepped)).toFixed(decimals));
}

/**
 * Headless 2D XY slider plane (e.g. color saturation/lightness picker or 2D joystick control).
 */
export function create_area(options: AreaOptions = {}) {
	const minX = options.min_x ?? 0;
	const maxX = options.max_x ?? 100;
	const minY = options.min_y ?? 0;
	const maxY = options.max_y ?? 100;
	const stepX = options.step_x ?? 1;
	const stepY = options.step_y ?? 1;

	let internal = $state<AreaValue>(options.default_value ?? { x: minX, y: minY });
	let dragging = $state(false);
	let surfaceEl: HTMLElement | null = null;

	const value = $derived(options.value ? options.value() : internal);
	const percent_x = $derived(maxX === minX ? 0 : ((value.x - minX) / (maxX - minX)) * 100);
	const percent_y = $derived(maxY === minY ? 0 : ((value.y - minY) / (maxY - minY)) * 100);

	function set(next: AreaValue, commitNow = false): void {
		const quantized: AreaValue = {
			x: quantizeStep(next.x, minX, maxX, stepX),
			y: quantizeStep(next.y, minY, maxY, stepY)
		};
		if (!options.value) internal = quantized;
		options.on_change?.(quantized);
		if (commitNow) options.on_commit?.(quantized);
	}

	function setFromPoint(clientX: number, clientY: number): void {
		if (surfaceEl === null) return;
		const rect = surfaceEl.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const rx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		const ry = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
		set({ x: minX + rx * (maxX - minX), y: minY + ry * (maxY - minY) });
	}

	const surface: Attachment<HTMLElement> = (el) => {
		surfaceEl = el;
		const onDown = (down: PointerEvent) => {
			if (down.button !== 0) return;
			down.preventDefault();
			dragging = true;
			setFromPoint(down.clientX, down.clientY);
			const move = (m: PointerEvent) => setFromPoint(m.clientX, m.clientY);
			const up = () => {
				window.removeEventListener('pointermove', move);
				window.removeEventListener('pointerup', up);
				window.removeEventListener('pointercancel', up);
				dragging = false;
				options.on_commit?.(value);
			};
			window.addEventListener('pointermove', move);
			window.addEventListener('pointerup', up);
			window.addEventListener('pointercancel', up);
		};
		el.addEventListener('pointerdown', onDown);
		return () => {
			el.removeEventListener('pointerdown', onDown);
			if (surfaceEl === el) surfaceEl = null;
		};
	};

	function onkeydown(event: KeyboardEvent): void {
		const mult = event.shiftKey ? 10 : 1;
		switch (event.key) {
			case 'ArrowRight':
				event.preventDefault();
				set({ x: value.x + stepX * mult, y: value.y }, true);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				set({ x: value.x - stepX * mult, y: value.y }, true);
				break;
			case 'ArrowDown':
				event.preventDefault();
				set({ x: value.x, y: value.y + stepY * mult }, true);
				break;
			case 'ArrowUp':
				event.preventDefault();
				set({ x: value.x, y: value.y - stepY * mult }, true);
				break;
			case 'Home':
				event.preventDefault();
				set({ x: minX, y: value.y }, true);
				break;
			case 'End':
				event.preventDefault();
				set({ x: maxX, y: value.y }, true);
				break;
		}
	}

	return {
		get value() {
			return value;
		},
		get percent_x() {
			return percent_x;
		},
		get percent_y() {
			return percent_y;
		},
		get dragging() {
			return dragging;
		},
		set,
		surface,
		thumb_attrs() {
			return {
				role: 'slider' as const,
				tabindex: 0,
				'aria-label': options.label,
				'aria-valuetext': `${value.x}, ${value.y}`,
				'data-dragging': dragging ? '' : undefined,
				onkeydown
			};
		}
	};
}

/** A range placed on a named track (calendar event, Gantt bar, room booking). */
export type Span = {
	readonly id: string;
	readonly track: string;
	readonly start: number;
	readonly end: number;
};

/** Returns whether `[start, end)` overlaps no existing span on `track` (excluding `ignoreId`). */
export function is_span_free(
	spans: readonly Span[],
	track: string,
	start: number,
	end: number,
	ignoreId?: string
): boolean {
	for (const s of spans) {
		if (s.track !== track || s.id === ignoreId) continue;
		if (start < s.end && end > s.start) return false;
	}
	return true;
}

/** Packs overlapping spans on one track into non-overlapping visual lanes (`lane` index & `lanes` total). */
export function stack_spans<S extends Span>(
	spans: readonly S[]
): readonly (S & { readonly lane: number; readonly lanes: number })[] {
	const sorted = [...spans].sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
	const laneEnds: number[] = [];
	const assigned = sorted.map((span) => {
		let lane = laneEnds.findIndex((end) => end <= span.start);
		if (lane < 0) {
			lane = laneEnds.length;
			laneEnds.push(span.end);
		} else {
			laneEnds[lane] = span.end;
		}
		return { ...span, lane };
	});
	const total = Math.max(1, laneEnds.length);
	return assigned.map((item) => ({ ...item, lanes: total }));
}

/** Options for `create_spans`. */
export type SpansOptions<S extends Span = Span> = {
	readonly tracks: () => readonly string[];
	readonly spans: () => readonly S[];
	readonly min: number;
	readonly max: number;
	readonly step?: number;
	readonly min_duration?: number;
	readonly on_commit: (next: readonly S[], action: 'draw' | 'move' | 'resize' | 'delete', id: string) => void;
	readonly create_span?: (draft: Span) => S;
};

/** Return value of `create_spans`. */
export type SpansBehavior<S extends Span = Span> = ReturnType<typeof create_spans<S>>;

/**
 * Headless track-span editor (week calendars, Gantt charts, room schedulers): move along or across
 * tracks, resize start/end edges, draw new spans and delete — all snapped to `step` with keyboard support.
 */
export function create_spans<S extends Span = Span>(options: SpansOptions<S>) {
	const step = options.step ?? 15;
	const minDuration = options.min_duration ?? step;
	let draft = $state.raw<readonly S[] | null>(null);
	let activeId = $state<string | null>(null);

	const spans = $derived(draft ?? options.spans());
	const snapUnit = (v: number) =>
		Math.max(options.min, Math.min(options.max, Math.round((v - options.min) / step) * step + options.min));

	function updateSpan(id: string, patch: Partial<Pick<Span, 'track' | 'start' | 'end'>>, action: 'move' | 'resize', commitNow = true): void {
		const list = spans;
		const existing = list.find((s) => s.id === id);
		if (existing === undefined) return;
		const start = snapUnit(patch.start ?? existing.start);
		const end = Math.max(start + minDuration, snapUnit(patch.end ?? existing.end));
		if (end > options.max) return;
		const updated: S = { ...existing, track: patch.track ?? existing.track, start, end };
		const next = list.map((s) => (s.id === id ? updated : s));
		if (commitNow) {
			draft = null;
			activeId = null;
			options.on_commit(next, action, id);
		} else {
			draft = next;
			activeId = id;
		}
	}

	function remove(id: string): void {
		const next = spans.filter((s) => s.id !== id);
		draft = null;
		activeId = null;
		options.on_commit(next, 'delete', id);
	}

	function create(track: string, start: number, end: number): void {
		if (options.create_span === undefined) return;
		const s = snapUnit(Math.min(start, end));
		const e = Math.max(s + minDuration, snapUnit(Math.max(start, end)));
		const base: Span = { id: `span-${Date.now()}`, track, start: s, end: Math.min(options.max, e) };
		const created = options.create_span(base);
		options.on_commit([...options.spans(), created], 'draw', created.id);
	}

	function span_attrs(span: S) {
		return {
			tabindex: 0,
			'data-span-id': span.id,
			'data-dragging': activeId === span.id ? '' : undefined,
			onkeydown: (event: KeyboardEvent) => {
				const tracks = options.tracks();
				const tIdx = tracks.indexOf(span.track);
				const dur = span.end - span.start;
				if (event.key === 'Delete' || event.key === 'Backspace') {
					event.preventDefault();
					remove(span.id);
				} else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
					event.preventDefault();
					if (event.shiftKey) {
						updateSpan(span.id, { end: span.end + step }, 'resize', true);
					} else if (event.key === 'ArrowRight' && tracks[tIdx + 1] !== undefined) {
						updateSpan(span.id, { track: tracks[tIdx + 1] }, 'move', true);
					} else {
						updateSpan(span.id, { start: span.start + step, end: span.start + step + dur }, 'move', true);
					}
				} else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
					event.preventDefault();
					if (event.shiftKey) {
						updateSpan(span.id, { end: Math.max(span.start + minDuration, span.end - step) }, 'resize', true);
					} else if (event.key === 'ArrowLeft' && tracks[tIdx - 1] !== undefined) {
						updateSpan(span.id, { track: tracks[tIdx - 1] }, 'move', true);
					} else {
						const ns = Math.max(options.min, span.start - step);
						updateSpan(span.id, { start: ns, end: ns + dur }, 'move', true);
					}
				}
			}
		};
	}

	return {
		get spans() {
			return spans;
		},
		get active() {
			return activeId;
		},
		update_span: updateSpan,
		create,
		remove,
		cancel() {
			draft = null;
			activeId = null;
		},
		span_attrs
	};
}

/** Marquee rectangle in container-relative coordinates. */
export type LassoRect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** Options for `create_lasso`. */
export type LassoOptions = {
	/** Called continuously as the marquee rectangle changes with intersecting item keys. */
	readonly on_change: (keys: readonly string[], rect: LassoRect) => void;
	/** Called when the marquee drag finishes. */
	readonly on_commit?: (keys: readonly string[]) => void;
};

/** Return value of `create_lasso`. */
export type LassoBehavior = ReturnType<typeof create_lasso>;

/**
 * Headless marquee / rubber-band drag selection over spatially positioned items.
 */
export function create_lasso(options: LassoOptions) {
	let rect = $state<LassoRect | null>(null);
	let surfaceEl: HTMLElement | null = null;
	const itemEls = new Map<string, HTMLElement>();
	let latestKeys: string[] = [];

	function intersect(box: LassoRect, origin: DOMRect): string[] {
		const left = origin.left + box.x;
		const top = origin.top + box.y;
		const right = left + box.width;
		const bottom = top + box.height;
		const hits: string[] = [];
		for (const [key, el] of itemEls.entries()) {
			const r = el.getBoundingClientRect();
			if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) {
				hits.push(key);
			}
		}
		return hits;
	}

	const drag = bind_drag({
		on_move: (sample) => {
			if (surfaceEl === null) return;
			const origin = surfaceEl.getBoundingClientRect();
			const x1 = sample.start_x - origin.left;
			const y1 = sample.start_y - origin.top;
			const x2 = sample.x - origin.left;
			const y2 = sample.y - origin.top;
			const next: LassoRect = {
				x: Math.min(x1, x2),
				y: Math.min(y1, y2),
				width: Math.abs(x2 - x1),
				height: Math.abs(y2 - y1)
			};
			rect = next;
			latestKeys = intersect(next, origin);
			options.on_change(latestKeys, next);
		},
		on_end: (_event, canceled) => {
			rect = null;
			if (!canceled) options.on_commit?.(latestKeys);
			latestKeys = [];
		}
	});

	const surface: Attachment<HTMLElement> = (el) => {
		surfaceEl = el;
		const stop = drag(el);
		return () => {
			stop?.();
			if (surfaceEl === el) surfaceEl = null;
		};
	};

	function item(key: string): Attachment<HTMLElement> {
		return (el) => {
			itemEls.set(key, el);
			return () => {
				if (itemEls.get(key) === el) itemEls.delete(key);
			};
		};
	}

	return {
		get rect() {
			return rect;
		},
		get active() {
			return rect !== null;
		},
		surface,
		item
	};
}

/** Camera state of a pan/zoom canvas viewport. */
export type ViewportCamera = { readonly x: number; readonly y: number; readonly zoom: number };

/** Options for `create_viewport`. */
export type ViewportOptions = {
	readonly initial?: ViewportCamera;
	readonly min_zoom?: number;
	readonly max_zoom?: number;
	readonly on_change?: (camera: ViewportCamera) => void;
};

/** Return value of `create_viewport`. */
export type ViewportBehavior = ReturnType<typeof create_viewport>;

/**
 * Headless pan/zoom canvas viewport with pointer panning, wheel-to-zoom around cursor, fit and reset.
 */
export function create_viewport(options: ViewportOptions = {}) {
	const minZoom = options.min_zoom ?? 0.2;
	const maxZoom = options.max_zoom ?? 4;
	const initial = options.initial ?? { x: 0, y: 0, zoom: 1 };
	let x = $state(initial.x);
	let y = $state(initial.y);
	let zoom = $state(initial.zoom);
	let panning = $state(false);
	let start = { x: 0, y: 0 };

	function emit(): void {
		options.on_change?.({ x, y, zoom });
	}

	function set_camera(next: Partial<ViewportCamera>): void {
		if (next.x !== undefined) x = next.x;
		if (next.y !== undefined) y = next.y;
		if (next.zoom !== undefined) zoom = Math.max(minZoom, Math.min(maxZoom, next.zoom));
		emit();
	}

	function zoom_at(factor: number, originX: number, originY: number): void {
		const nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom * factor));
		const ratio = nextZoom / zoom;
		x = originX - (originX - x) * ratio;
		y = originY - (originY - y) * ratio;
		zoom = nextZoom;
		emit();
	}

	const drag = bind_drag({
		on_start: () => {
			start = { x, y };
			panning = true;
			return true;
		},
		on_move: (sample) => {
			x = start.x + sample.dx;
			y = start.y + sample.dy;
			emit();
		},
		on_end: () => {
			panning = false;
		}
	});

	const surface: Attachment<HTMLElement> = (el) => {
		const stopDrag = drag(el);
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			const factor = Math.exp(-event.deltaY * 0.002);
			zoom_at(factor, event.clientX - rect.left, event.clientY - rect.top);
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			stopDrag?.();
			el.removeEventListener('wheel', onWheel);
		};
	};

	return {
		get x() {
			return x;
		},
		get y() {
			return y;
		},
		get zoom() {
			return zoom;
		},
		get panning() {
			return panning;
		},
		get transform() {
			return `translate3d(${x}px, ${y}px, 0) scale(${zoom})`;
		},
		set_camera,
		zoom_at,
		reset() {
			set_camera(initial);
		},
		surface
	};
}

/** Active wire being dragged from a source port to pointer coordinates. */
export type ConnectDraft = {
	readonly from: string;
	readonly x: number;
	readonly y: number;
	readonly over: string | null;
};

/** Options for `create_connect`. */
export type ConnectOptions = {
	readonly can_connect?: (from: string, to: string) => boolean;
	readonly on_connect: (from: string, to: string) => void;
};

/** Return value of `create_connect`. */
export type ConnectBehavior = ReturnType<typeof create_connect>;

/**
 * Headless node-graph port wiring behavior (pointer drag from port to port + keyboard Enter pick/connect).
 */
export function create_connect(options: ConnectOptions) {
	let draft = $state<ConnectDraft | null>(null);
	let pendingFrom = $state<string | null>(null);
	const portEls = new Map<string, HTMLElement>();

	const allow = (from: string, to: string) => from !== to && (options.can_connect?.(from, to) ?? true);

	function hitPort(x: number, y: number, from: string): string | null {
		for (const [id, el] of portEls.entries()) {
			if (!allow(from, id)) continue;
			const r = el.getBoundingClientRect();
			if (x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8) return id;
		}
		return null;
	}

	function port(id: string): Attachment<HTMLElement> {
		const drag = bind_drag({
			threshold: 2,
			on_start: (down) => {
				draft = { from: id, x: down.clientX, y: down.clientY, over: null };
				return true;
			},
			on_move: (sample) => {
				draft = { from: id, x: sample.x, y: sample.y, over: hitPort(sample.x, sample.y, id) };
			},
			on_end: (_event, canceled) => {
				const target = draft?.over ?? null;
				draft = null;
				if (!canceled && target !== null && allow(id, target)) {
					options.on_connect(id, target);
					announce(`Connected ${id} to ${target}`);
				}
			}
		});
		return (el) => {
			portEls.set(id, el);
			const stop = drag(el);
			return () => {
				stop?.();
				if (portEls.get(id) === el) portEls.delete(id);
			};
		};
	}

	function port_attrs(id: string) {
		return {
			tabindex: 0,
			'data-connecting': draft?.from === id || pendingFrom === id ? '' : undefined,
			'data-connect-target': draft?.over === id ? '' : undefined,
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === 'Escape' && pendingFrom !== null) {
					event.preventDefault();
					pendingFrom = null;
				} else if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					if (pendingFrom === null) {
						pendingFrom = id;
					} else if (allow(pendingFrom, id)) {
						options.on_connect(pendingFrom, id);
						announce(`Connected ${pendingFrom} to ${id}`);
						pendingFrom = null;
					} else {
						pendingFrom = null;
					}
				}
			}
		};
	}

	return {
		get draft() {
			return draft;
		},
		get pending_from() {
			return pendingFrom;
		},
		port,
		port_attrs
	};
}

/** Side on which row swipe actions sit. */
export type SwipeSide = 'start' | 'end';

/** Currently revealed swipe row. */
export type SwipeOpen = { readonly key: string; readonly side: SwipeSide };

/** Options for `create_swipe_actions`. */
export type SwipeActionsOptions = {
	/** Width in px of revealed action tray (default `120`). */
	readonly tray_width?: number;
	/** Fraction of tray width needed to snap open (default `0.5`). */
	readonly open_ratio?: number;
	/** Distance in px triggering immediate full-swipe action (default `220`). */
	readonly full_swipe_px?: number;
	/** Optional full-swipe callback (e.g. archive/delete). */
	readonly on_full_swipe?: (key: string, side: SwipeSide) => void;
};

/** Return value of `create_swipe_actions`. */
export type SwipeActions = ReturnType<typeof create_swipe_actions>;

/**
 * Mail-style row swipe-to-reveal actions with rubber-band resistance, full-swipe trigger
 * and ArrowLeft/ArrowRight/Escape keyboard parity.
 */
export function create_swipe_actions(options: SwipeActionsOptions = {}) {
	const tray = options.tray_width ?? 120;
	const threshold = tray * (options.open_ratio ?? 0.5);
	const fullPx = options.full_swipe_px ?? 220;

	let open = $state<SwipeOpen | null>(null);
	let offset = $state<{ readonly key: string; readonly x: number } | null>(null);

	function close(): void {
		open = null;
		offset = null;
	}

	function row(key: string): Attachment<HTMLElement> {
		let baseOffset = 0;
		return bind_drag({
			threshold: 8,
			on_start: () => {
				baseOffset = open?.key === key ? (open.side === 'start' ? tray : -tray) : 0;
				return true;
			},
			on_move: (sample) => {
				if (Math.abs(sample.dy) > Math.abs(sample.dx) * 1.5 && offset === null) return;
				const raw = baseOffset + sample.dx;
				const damped =
					Math.abs(raw) > tray
						? Math.sign(raw) * (tray + (Math.abs(raw) - tray) * 0.35)
						: raw;
				offset = { key, x: Math.round(damped) };
			},
			on_end: (_event, canceled) => {
				const cur = offset?.key === key ? offset.x : 0;
				offset = null;
				if (canceled) return;
				if (Math.abs(cur) >= fullPx && options.on_full_swipe !== undefined) {
					const side: SwipeSide = cur > 0 ? 'start' : 'end';
					open = null;
					options.on_full_swipe(key, side);
					return;
				}
				if (cur >= threshold) open = { key, side: 'start' };
				else if (cur <= -threshold) open = { key, side: 'end' };
				else if (open?.key === key) open = null;
			}
		});
	}

	function row_attrs(key: string) {
		const x =
			offset?.key === key
				? offset.x
				: open?.key === key
					? open.side === 'start'
						? tray
						: -tray
					: 0;
		return {
			'data-swipe-open': open?.key === key ? open.side : undefined,
			style: `--swipe-x:${x}px;`,
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === 'Escape' && open?.key === key) {
					event.preventDefault();
					close();
				} else if (event.key === 'ArrowRight' && event.shiftKey) {
					event.preventDefault();
					open = { key, side: 'start' };
				} else if (event.key === 'ArrowLeft' && event.shiftKey) {
					event.preventDefault();
					open = { key, side: 'end' };
				}
			}
		};
	}

	return {
		get open() {
			return open;
		},
		get offset() {
			return offset;
		},
		close,
		row,
		row_attrs
	};
}

/** Options for `bind_scroll_picker`. */
export type ScrollPickerOptions = {
	/** Called when the centered option changes after scrolling settles. */
	readonly on_select: (index: number) => void;
	/** Scroll axis (default `'vertical'`). */
	readonly orientation?: 'vertical' | 'horizontal';
};

/**
 * Scroll-snap wheel picker attachment (`{@attach bind_scroll_picker(...)}`) that writes
 * `--picker-offset` (`-1..1` normalized distance from center) on each child option and reports
 * the centered index on scroll settle.
 */
export function bind_scroll_picker(options: ScrollPickerOptions): Attachment<HTMLElement> {
	return (el) => {
		const horizontal = options.orientation === 'horizontal';
		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		let lastIndex = -1;

		const measure = (commit: boolean) => {
			const rect = el.getBoundingClientRect();
			const center = horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
			const half = Math.max(1, (horizontal ? rect.width : rect.height) / 2);
			let bestIndex = -1;
			let bestDist = Number.POSITIVE_INFINITY;

			const children = Array.from(el.children);
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (!(child instanceof HTMLElement)) continue;
				const cr = child.getBoundingClientRect();
				const c = horizontal ? cr.left + cr.width / 2 : cr.top + cr.height / 2;
				const dist = Math.abs(c - center);
				const norm = Math.max(-1, Math.min(1, (c - center) / half));
				child.style.setProperty('--picker-offset', norm.toFixed(3));
				if (dist < bestDist) {
					bestDist = dist;
					bestIndex = i;
				}
			}

			if (commit && bestIndex >= 0 && bestIndex !== lastIndex) {
				lastIndex = bestIndex;
				options.on_select(bestIndex);
			}
		};

		const onScroll = () => {
			measure(false);
			if (settleTimer !== undefined) clearTimeout(settleTimer);
			settleTimer = setTimeout(() => {
				settleTimer = undefined;
				measure(true);
			}, 90);
		};

		measure(false);
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => {
			if (settleTimer !== undefined) clearTimeout(settleTimer);
			el.removeEventListener('scroll', onScroll);
		};
	};
}
