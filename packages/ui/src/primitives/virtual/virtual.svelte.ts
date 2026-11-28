// One headless 1D & 2D windowing engine for every long list, table, board, timeline, log, combobox,
// transcript and calendar matrix in `@norbital-ai/ui` and `@norbital-ai/bolt`.
//
// Supports both an O(1) fixed-size fast path (`size`, zero ResizeObserver overhead) and an O(log N)
// Fenwick-tree variable-size path (`estimate`, cached by key with optional fixed `gap` to skip
// per-item `getComputedStyle`). Binds directly to the relevant axis's scrolling ancestors (ignoring
// orthogonal-axis scrolls), sets `overflow-anchor: none` so browser scroll anchoring never fights
// virtual spacers, updates synchronously within the scroll frame, and scales overscan forward along
// the active scroll velocity so fast flings never hit blank space.
import type { Attachment } from 'svelte/attachments';
import { directionalOverscan, fixedWindowOf, SizeTree, treeWindowOf } from './virtual.js';

/** The scroll axis a virtualizer windows along: `'y'` (vertical) or `'x'` (horizontal). */
export type VirtualAxis = 'y' | 'x';

/** Snapshot of the currently rendered virtual slice reported to `on_range`. */
export type VirtualRange = {
	/** First rendered index (inclusive). */
	readonly start: number;
	/** Last rendered index (exclusive). */
	readonly end: number;
	/** Total item count along the axis. */
	readonly count: number;
	/** Items remaining past `end` (`Math.max(0, count - end)`). */
	readonly remaining: number;
	/** Whether the user has scrolled this axis at least once since mount. */
	readonly scrolled: boolean;
};

/**
 * Options for `virtual_list`: item count, fixed `size` or variable `estimate` (+ stable `key`),
 * scroll `axis`, `gap`, activation `threshold`, base/velocity `overscan`, tail pinning and prefetch `on_range`.
 */
export type VirtualOptions = {
	/** Total number of items along this axis. */
	count: () => number;
	/** Stable identity of item `i`: measured sizes follow it (optional when `size` is fixed). */
	key?: (index: number) => string;
	/** Uniform item size in px along the axis (enables the O(1) fast path without ResizeObserver). */
	size?: number | (() => number);
	/** Unmeasured variable item size in px along the axis (used when `size` is not provided). */
	estimate?: number | (() => number);
	/** Scroll axis to virtualize: `'y'` (default, vertical) or `'x'` (horizontal). */
	axis?: VirtualAxis;
	/** Fixed spacing/margin between adjacent items in px; skips per-item `getComputedStyle` in variable mode. */
	gap?: number;
	/** Render every item at or below this count (default 60). */
	threshold?: number;
	/** Minimum items rendered beyond each edge of the visible band (default 8). */
	overscan?: number;
	/** Maximum extra lookahead items added in the scroll direction during fast flings. */
	max_overscan?: number;
	/** Window the last visible items while a bottom-origin viewport is latched to its tail. */
	tail?: () => boolean;
	/** Invoked when the rendered slice changes, useful for prefetching before reaching the end. */
	on_range?: (range: VirtualRange) => void;
};

/** A windowed 1D list: the rendered `slice`, spacer extents, `total` extent, `anchor` and `measure` attachments. */
export type Virtual = ReturnType<typeof virtual_list>;

/** Options for `virtual_grid`: row (vertical) and column (horizontal) virtualizer configurations. */
export type VirtualGridOptions = {
	/** Vertical row axis configuration. */
	rows: Omit<VirtualOptions, 'axis'>;
	/** Horizontal column axis configuration. */
	cols: Omit<VirtualOptions, 'axis'>;
};

/** A 2D virtualized grid composing independent row (`y`) and column (`x`) axes. */
export type VirtualGrid = ReturnType<typeof virtual_grid>;

const CLIPS = /auto|scroll|hidden|clip|overlay/;
const SCROLLS = /auto|scroll|overlay/;
const SETTLE_MS = 140;
const VELOCITY_EMA = 0.4;
const MAX_DT_MS = 120;

function initialBand(horizontal: boolean): number {
	if (horizontal) return typeof innerWidth === 'number' && innerWidth > 0 ? innerWidth : 1024;
	return typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 800;
}

/**
 * Windows a long list (vertical or horizontal) to the items near the visible viewport, using O(1) math
 * for fixed `size` items or an O(log N) Fenwick tree for measured variable `estimate` items.
 */
export function virtual_list(o: VirtualOptions) {
	const axis: VirtualAxis = o.axis ?? 'y';
	const horizontal = axis === 'x';
	const threshold = o.threshold ?? 60;
	const baseOverscan = o.overscan ?? 8;
	const maxExtra = o.max_overscan ?? Math.max(baseOverscan * 3, 24);

	const sizes = new Map<string, number>();
	const pendingMeasures = new Map<string, number>();
	const keys = new WeakMap<Element, string>();
	const reversedPorts = new WeakMap<Element, boolean>();
	const lastPortScroll = new WeakMap<Element, { main: number; cross: number }>();

	let version = $state(0);
	let pos = $state(0);
	let band = $state(initialBand(horizontal));
	let leadBefore = $state(baseOverscan);
	let leadAfter = $state(baseOverscan);
	let scrolled = $state(false);

	let anchorEl: HTMLElement | null = null;
	let clips: Element[] = [];
	let scrollClips: Element[] = [];
	let velocity = 0;
	let lastSamplePos = 0;
	let lastSampleTime = 0;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let measureFrame = 0;

	const keyAt = (index: number) => (o.key ? o.key(index) : String(index));
	const fixedSize = $derived(typeof o.size === 'function' ? o.size() : o.size);
	const estimate = $derived(
		fixedSize ?? (typeof o.estimate === 'function' ? o.estimate() : (o.estimate ?? 40))
	);
	const gap = $derived(o.gap ?? 0);
	const fixedStride = $derived(fixedSize === undefined ? undefined : Math.max(1, fixedSize + gap));
	const count = $derived(o.count());
	const on = $derived(count > threshold);

	// Variable-mode structure: rebuilt only when `on`, `count`, keys, or `estimate` change (never on ResizeObserver bumps).
	const structure = $derived.by(() => {
		const tree = new SizeTree();
		const keyIndex = new Map<string, number>();
		if (!on || fixedStride !== undefined) return { tree, keyIndex };
		const n = count;
		const fallback = Math.max(1, estimate + gap);
		for (let i = 0; i < n; i++) keyIndex.set(keyAt(i), i);
		tree.rebuild(n, (i) => sizes.get(keyAt(i)) ?? fallback);
		// Prune stale cache entries in long-lived paged sessions without discarding active keys.
		if (sizes.size > Math.max(4096, n * 2)) {
			for (const cached of sizes.keys()) {
				if (!keyIndex.has(cached)) sizes.delete(cached);
			}
		}
		return { tree, keyIndex };
	});

	const total = $derived.by(() => {
		if (count <= 0) return 0;
		if (fixedStride !== undefined) return count * fixedStride;
		if (!on) return count * Math.max(1, estimate + gap);
		void version;
		return structure.tree.total;
	});

	const windowPos = $derived(o.tail?.() === true ? Math.max(0, total - band) : pos);

	const range = $derived.by(() => {
		if (!on) return { start: 0, end: count };
		if (fixedStride !== undefined) {
			return fixedWindowOf(count, fixedStride, windowPos, band, leadBefore, leadAfter);
		}
		void version;
		return treeWindowOf(structure.tree, windowPos, band, leadBefore, leadAfter);
	});

	// Expose primitive numbers so Svelte 5 skips downstream updates whenever a scroll doesn't move the slice.
	const start = $derived(range.start);
	const end = $derived(range.end);

	const before = $derived.by(() => {
		if (!on) return 0;
		if (fixedStride !== undefined) return start * fixedStride;
		void version;
		return structure.tree.offset(start);
	});

	const after = $derived.by(() => {
		if (!on) return 0;
		if (fixedStride !== undefined) return Math.max(0, total - end * fixedStride);
		void version;
		return Math.max(0, total - structure.tree.offset(end));
	});

	if (o.on_range !== undefined) {
		const notifyRange = o.on_range;
		$effect(() => {
			notifyRange({
				start,
				end,
				count,
				remaining: Math.max(0, count - end),
				scrolled
			});
		});
	}

	function scrollPort(): Element | null {
		return (
			scrollClips.find((c) =>
				horizontal ? c.scrollWidth > c.clientWidth : c.scrollHeight > c.clientHeight
			) ?? null
		);
	}

	function measureBand(): { nextPos: number; nextBand: number } | null {
		if (anchorEl === null) return null;
		let lo = 0;
		let hi = horizontal ? innerWidth : innerHeight;
		for (const c of clips) {
			const b = c.getBoundingClientRect();
			if (horizontal) {
				lo = Math.max(lo, b.left);
				hi = Math.min(hi, b.right);
			} else {
				lo = Math.max(lo, b.top);
				hi = Math.min(hi, b.bottom);
			}
		}
		const anchorRect = anchorEl.getBoundingClientRect();
		return {
			nextPos: lo - (horizontal ? anchorRect.left : anchorRect.top),
			nextBand: Math.max(0, hi - lo)
		};
	}

	function updateVelocity(nextPos: number, fromScroll: boolean) {
		if (!fromScroll) return;
		const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
		const dt = lastSampleTime > 0 ? now - lastSampleTime : 0;
		const delta = nextPos - lastSamplePos;
		lastSamplePos = nextPos;
		lastSampleTime = now;

		if (Math.abs(delta) >= 1 && !scrolled) scrolled = true;

		if (dt > 0 && dt <= MAX_DT_MS && Math.abs(delta) >= 1) {
			const instant = delta / dt;
			// Reset EMA on direction reversal so overscan immediately shifts ahead of the new direction.
			velocity =
				velocity !== 0 && Math.sign(instant) !== Math.sign(velocity)
					? instant * 0.6
					: velocity * (1 - VELOCITY_EMA) + instant * VELOCITY_EMA;
		} else if (dt > MAX_DT_MS) {
			velocity = 0;
		}

		const itemSize = fixedStride ?? Math.max(1, estimate + gap);
		const next = directionalOverscan(velocity, band, itemSize, baseOverscan, maxExtra);
		if (next.before !== leadBefore) leadBefore = next.before;
		if (next.after !== leadAfter) leadAfter = next.after;

		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			velocity = 0;
			if (leadBefore !== baseOverscan) leadBefore = baseOverscan;
			if (leadAfter !== baseOverscan) leadAfter = baseOverscan;
		}, SETTLE_MS);
	}

	function sync(fromScroll = false) {
		const measured = measureBand();
		if (measured === null) return;
		const { nextPos, nextBand } = measured;
		if (fromScroll) updateVelocity(nextPos, true);
		else {
			lastSamplePos = nextPos;
		}
		// Sub-pixel hysteresis avoids fractional DPR scroll jitter while staying frame-accurate.
		if (Math.abs(nextPos - pos) >= 1) pos = nextPos;
		if (Math.abs(nextBand - band) >= 1) band = nextBand;
	}

	function offsetOf(index: number): number {
		const clamped = Math.max(0, Math.min(count, index));
		if (fixedStride !== undefined) return clamped * fixedStride;
		if (!on) return clamped * Math.max(1, estimate + gap);
		void version;
		return structure.tree.offset(clamped);
	}

	function sizeOf(index: number): number {
		if (index < 0 || index >= count) return 0;
		if (fixedStride !== undefined) return fixedStride;
		if (!on) return Math.max(1, estimate + gap);
		void version;
		return structure.tree.get(index);
	}

	function recordPortScroll(target: Element) {
		lastPortScroll.set(target, {
			main: horizontal ? target.scrollLeft : target.scrollTop,
			cross: horizontal ? target.scrollTop : target.scrollLeft
		});
	}

	function flushMeasurements() {
		measureFrame = 0;
		if (!on || fixedStride !== undefined || pendingMeasures.size === 0) {
			pendingMeasures.clear();
			return;
		}
		let changed = false;
		let anchorDelta = 0;
		const liveMeasured = measureBand();
		const currentPos = liveMeasured?.nextPos ?? pos;
		const tailed = o.tail?.() === true;
		const fallback = Math.max(1, estimate + gap);
		const { tree, keyIndex } = structure;

		for (const [k, extent] of pendingMeasures) {
			const prev = sizes.get(k);
			if (extent > 0 && (prev === undefined || Math.abs(prev - extent) >= 0.5)) {
				const idx = keyIndex.get(k);
				const prior = prev ?? fallback;
				if (!tailed && currentPos > 0 && idx !== undefined) {
					const itemEnd = tree.offset(idx) + prior;
					// Item lies strictly before the visible viewport: compensate scroll to prevent jump jitter.
					if (itemEnd <= currentPos) {
						anchorDelta += extent - prior;
					}
				}
				sizes.set(k, extent);
				if (idx !== undefined) tree.set(idx, extent);
				changed = true;
			}
		}
		pendingMeasures.clear();

		if (changed) {
			if (Math.abs(anchorDelta) >= 1 && anchorEl !== null) {
				const port = scrollPort();
				if (port !== null && reversedPorts.get(port) === true) {
					// Bottom-origin port (`flex-col-reverse` / `flex-row-reverse`) already holds its anchor.
				} else if (port !== null) {
					if (horizontal) {
						const prevScroll = port.scrollLeft;
						port.scrollLeft = Math.max(0, prevScroll + anchorDelta);
						const applied = port.scrollLeft - prevScroll;
						pos = Math.max(0, pos + applied);
						lastSamplePos = pos;
					} else {
						const prevScroll = port.scrollTop;
						port.scrollTop = Math.max(0, prevScroll + anchorDelta);
						const applied = port.scrollTop - prevScroll;
						pos = Math.max(0, pos + applied);
						lastSamplePos = pos;
					}
					recordPortScroll(port);
				} else if (document.scrollingElement) {
					if (horizontal) {
						const prevScroll = document.scrollingElement.scrollLeft;
						document.scrollingElement.scrollBy({ left: anchorDelta });
						pos = Math.max(0, pos + (document.scrollingElement.scrollLeft - prevScroll));
					} else {
						const prevScroll = document.scrollingElement.scrollTop;
						document.scrollingElement.scrollBy({ top: anchorDelta });
						pos = Math.max(0, pos + (document.scrollingElement.scrollTop - prevScroll));
					}
					lastSamplePos = pos;
				}
			}
			version++;
		}
	}

	// Only allocate a ResizeObserver when item sizes are variable (fixed `size` skips measurements completely).
	// Measurements commit on the next animation frame so DOM/spacer updates never trigger a ResizeObserver loop error.
	const observer =
		o.size !== undefined || typeof ResizeObserver === 'undefined'
			? null
			: new ResizeObserver((entries) => {
					if (!on || fixedStride !== undefined) return;
					const fixedGap = o.gap;
					let queued = false;
					for (const e of entries) {
						const k = keys.get(e.target);
						if (k === undefined) continue;
						const box = e.borderBoxSize?.[0];
						const rawExtent = horizontal
							? (box?.inlineSize ?? (e.target instanceof HTMLElement ? e.target.offsetWidth : undefined))
							: (box?.blockSize ?? (e.target instanceof HTMLElement ? e.target.offsetHeight : undefined));
						if (rawExtent === undefined) continue;

						let margin = fixedGap;
						if (margin === undefined) {
							const cs = getComputedStyle(e.target);
							margin = horizontal
								? (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0)
								: (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
						}
						const extent = rawExtent + margin;
						const prev = sizes.get(k);
						if (extent > 0 && (prev === undefined || Math.abs(prev - extent) >= 0.5)) {
							pendingMeasures.set(k, extent);
							queued = true;
						}
					}
					if (queued && measureFrame === 0) {
						measureFrame = requestAnimationFrame(flushMeasurements);
					}
				});

	return {
		/** Whether windowing is currently active (`count > threshold`). */
		get on() {
			return on;
		},
		/** Scroll axis (`'y'` or `'x'`). */
		get axis() {
			return axis;
		},
		/** First rendered item index (inclusive). */
		get start() {
			return start;
		},
		/** Last rendered item index (exclusive). */
		get end() {
			return end;
		},
		/** Leading spacer extent in px before `start`. */
		get before() {
			return before;
		},
		/** Trailing spacer extent in px after `end`. */
		get after() {
			return after;
		},
		/** Total scroll extent of all items in px. */
		get total() {
			return total;
		},
		/** Whether this axis has been scrolled since mount. */
		get scrolled() {
			return scrolled;
		},
		/** The rendered slice of `items`; index `j` of the slice is item `start + j`. */
		slice<T>(items: readonly T[]): readonly T[] {
			return on ? items.slice(start, end) : items;
		},
		/** Start offset in px of item `index` along this axis. */
		offset_of(index: number): number {
			return offsetOf(index);
		},
		/**
		 * Attach to the leading spacer (or list origin wrapper in transform mode): locates clipping and
		 * scrolling ancestors on this axis, disables competing browser `overflow-anchor`, and syncs live.
		 */
		anchor: ((el: HTMLElement) => {
			anchorEl = el;
			clips = [];
			scrollClips = [];
			const anchoredPorts: { el: HTMLElement; prev: string }[] = [];
			for (let p = el.parentElement; p !== null; p = p.parentElement) {
				const cs = getComputedStyle(p);
				const overflow = horizontal
					? cs.overflowX || cs.overflow
					: cs.overflowY || cs.overflow;
				if (CLIPS.test(overflow)) clips.push(p);
				if (SCROLLS.test(overflow)) {
					scrollClips.push(p);
					const dir = cs.flexDirection;
					reversedPorts.set(
						p,
						horizontal ? dir === 'row-reverse' : dir === 'column-reverse'
					);
					recordPortScroll(p);
					if (p instanceof HTMLElement) {
						anchoredPorts.push({ el: p, prev: p.style.overflowAnchor });
						p.style.overflowAnchor = 'none';
					}
				}
			}

			let frame = 0;
			const schedule = () => {
				if (frame === 0)
					frame = requestAnimationFrame(() => {
						frame = 0;
						sync(false);
					});
			};

			const onPortScroll = (event: Event) => {
				const target = event.currentTarget;
				if (target instanceof Element) {
					const curMain = horizontal ? target.scrollLeft : target.scrollTop;
					const curCross = horizontal ? target.scrollTop : target.scrollLeft;
					const prev = lastPortScroll.get(target);
					lastPortScroll.set(target, { main: curMain, cross: curCross });
					// Pure cross-axis scroll (e.g. horizontal scroll on a vertical virtualizer): zero layout reads.
					if (prev !== undefined && curMain === prev.main && curCross !== prev.cross) return;
				}
				sync(true);
			};

			const onWindowScroll = () => {
				sync(true);
			};

			schedule();
			for (const sc of scrollClips) {
				sc.addEventListener('scroll', onPortScroll, { passive: true });
			}
			window.addEventListener('scroll', onWindowScroll, { passive: true });
			addEventListener('resize', schedule, { passive: true });
			const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
			for (const c of clips) ro?.observe(c);

			return () => {
				cancelAnimationFrame(frame);
				if (measureFrame !== 0) {
					cancelAnimationFrame(measureFrame);
					measureFrame = 0;
				}
				pendingMeasures.clear();
				if (settleTimer !== undefined) {
					clearTimeout(settleTimer);
					settleTimer = undefined;
				}
				for (const sc of scrollClips) {
					sc.removeEventListener('scroll', onPortScroll);
				}
				window.removeEventListener('scroll', onWindowScroll);
				removeEventListener('resize', schedule);
				ro?.disconnect();
				for (const { el: portEl, prev } of anchoredPorts) {
					portEl.style.overflowAnchor = prev;
				}
				if (anchorEl === el) anchorEl = null;
			};
		}) satisfies Attachment<HTMLElement>,
		/** Attach to each rendered item in variable-size mode; a no-op when fixed `size` is set. */
		measure(key: string): Attachment<Element> {
			if (observer === null) return () => {};
			return (el) => {
				keys.set(el, key);
				observer.observe(el);
				return () => observer.unobserve(el);
			};
		},
		/** Resets tracked scroll position and velocity (and rewinds the scroll port to 0) on filter/page resets. */
		reset(): void {
			if (settleTimer !== undefined) {
				clearTimeout(settleTimer);
				settleTimer = undefined;
			}
			velocity = 0;
			lastSamplePos = 0;
			lastSampleTime = 0;
			pos = 0;
			scrolled = false;
			if (leadBefore !== baseOverscan) leadBefore = baseOverscan;
			if (leadAfter !== baseOverscan) leadAfter = baseOverscan;
			const port = scrollPort();
			if (port !== null) {
				if (horizontal) port.scrollLeft = 0;
				else port.scrollTop = 0;
				recordPortScroll(port);
			}
		},
		/** Scrolls the nearest scrolling ancestor (else the window) so item `index` is in view. */
		reveal(index: number): void {
			if (!on || anchorEl === null || index < 0 || index >= count) return;
			const itemStart = offsetOf(index);
			const itemEnd = itemStart + sizeOf(index);
			const port = scrollPort();
			const anchorRect = anchorEl.getBoundingClientRect();
			const origin = horizontal ? anchorRect.left : anchorRect.top;
			const [a, b] = [origin + itemStart, origin + itemEnd];
			const box =
				port === null
					? horizontal
						? { lo: 0, hi: innerWidth }
						: { lo: 0, hi: innerHeight }
					: (() => {
							const r = port.getBoundingClientRect();
							return horizontal ? { lo: r.left, hi: r.right } : { lo: r.top, hi: r.bottom };
						})();
			const by = a < box.lo ? a - box.lo : b > box.hi ? b - box.hi : 0;
			if (by !== 0) {
				const target = port ?? document.scrollingElement;
				target?.scrollBy(horizontal ? { left: by } : { top: by });
			}
		}
	};
}

/**
 * Composes independent row (`y`) and column (`x`) `virtual_list` instances for 2D matrices such as
 * roster boards, schedules and wide tables.
 */
export function virtual_grid(o: VirtualGridOptions) {
	const rows = virtual_list({ ...o.rows, axis: 'y' });
	const cols = virtual_list({ ...o.cols, axis: 'x' });
	return {
		/** Vertical row virtualizer. */
		rows,
		/** Horizontal column virtualizer. */
		cols,
		/** Attach to a shared origin element to drive both row and column axes together. */
		anchor: ((el: HTMLElement) => {
			const offRows = rows.anchor(el);
			const offCols = cols.anchor(el);
			return () => {
				offRows?.();
				offCols?.();
			};
		}) satisfies Attachment<HTMLElement>
	};
}
