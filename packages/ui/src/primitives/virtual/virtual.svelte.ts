// One list window for every long list in ui and the bolt shell (owner rule: fast and snappy). Headless: the list renders
// a top spacer carrying `anchor`, the `slice` of its items each carrying `measure(key)`, and a bottom spacer of `after`
// px, in whatever element fits (`tr`, `li`, `div`), so sticky headers, table layout and list semantics stay the page's.
//
// The visible band is the viewport clipped by every overflow ancestor of the anchor, so a list in page flow (the
// window scrolls), in its own scroll port or several lists in one port (a Board lane's pages) each window alone with
// no scroll-element prop. Heights are measured (margins included) and cached by key, so a reorder or a remount keeps
// them; unmeasured rows count as `estimate`. At or below `threshold` items nothing is windowed: the list renders whole.
import type { Attachment } from 'svelte/attachments';
import { offsets, windowOf } from './virtual.js';

/**
 * What `virtualList` windows: the item count, each item's stable key, the estimated height, the threshold and the overscan.
 */
export type VirtualOptions = {
	count: () => number;
	/** Stable identity of item `i` (its id): measured heights follow it. */
	key: (index: number) => string;
	/** An unmeasured item's height in px. */
	estimate: number;
	/** Render every item at or below this count (default 60). */
	threshold?: number;
	/** Items rendered beyond each edge of the visible band (default 8). */
	overscan?: number;
};
/** A windowed list: the `slice` of items to render, the spacers around it and the `measure` attachment. */
export type Virtual = ReturnType<typeof virtualList>;

const CLIPS = /auto|scroll|hidden|clip|overlay/;

/**
 * Windows a long list to the rows in view (measuring each row's height), so a page renders only what is visible; a short list renders whole.
 */
export function virtualList(o: VirtualOptions) {
	const threshold = o.threshold ?? 60, overscan = o.overscan ?? 8;
	const sizes = new Map<string, number>();
	const keys = new WeakMap<Element, string>();
	let version = $state(0);
	// the visible band in list coordinates; before the first sync, a screen from the top
	let top = $state(0), band = $state(typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight : 800);
	let seenTop = 0, seenBand = 0;
	let anchorEl: HTMLElement | null = null, clips: Element[] = [];

	const on = $derived(o.count() > threshold);
	const offs = $derived.by(() => {
		void version;
		if (!on) return [0];
		const n = o.count(), hs = new Array<number>(n);
		for (let i = 0; i < n; i++) hs[i] = sizes.get(o.key(i)) ?? o.estimate;
		return offsets(hs);
	});
	const win = $derived(on ? windowOf(offs, top, band, overscan) : { start: 0, end: o.count() });

	function sync() {
		if (anchorEl === null) return;
		let lo = 0, hi = innerHeight;
		for (const c of clips) { const b = c.getBoundingClientRect(); lo = Math.max(lo, b.top); hi = Math.min(hi, b.bottom); }
		const t = lo - anchorEl.getBoundingClientRect().top, h = Math.max(0, hi - lo);
		if (t !== seenTop) top = seenTop = t;
		if (h !== seenBand) band = seenBand = h;
	}
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver((entries) => {
		let changed = false;
		for (const e of entries) {
			const k = keys.get(e.target);
			if (k === undefined) continue;
			const cs = getComputedStyle(e.target);
			const h = (e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight) + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
			// a hidden list (the other layout of a Table) measures 0: keep the estimate
			if (h > 0 && sizes.get(k) !== h) { sizes.set(k, h); changed = true; }
		}
		if (changed) version++;
	});

	return {
		get on() { return on; },
		get start() { return win.start; },
		get end() { return win.end; },
		/** The top spacer's height. */
		get before() { return on ? offs[win.start]! : 0; },
		/** The bottom spacer's height. */
		get after() { return on ? offs[offs.length - 1]! - offs[win.end]! : 0; },
		/** The rendered items; index `j` of the slice is item `start + j`. */
		slice<T>(items: readonly T[]): readonly T[] { return on ? items.slice(win.start, win.end) : items; },
		/** On the top spacer: finds the clipping ancestors and follows every scroll and resize (one read per frame). */
		anchor: ((el: HTMLElement) => {
			anchorEl = el;
			clips = [];
			for (let p = el.parentElement; p !== null; p = p.parentElement) if (CLIPS.test(getComputedStyle(p).overflowY)) clips.push(p);
			let frame = 0;
			const schedule = () => { if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; sync(); }); };
			schedule();
			document.addEventListener('scroll', schedule, { capture: true, passive: true });
			addEventListener('resize', schedule, { passive: true });
			const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
			for (const c of clips) ro?.observe(c);
			return () => {
				cancelAnimationFrame(frame);
				document.removeEventListener('scroll', schedule, { capture: true });
				removeEventListener('resize', schedule);
				ro?.disconnect();
				if (anchorEl === el) anchorEl = null;
			};
		}) satisfies Attachment<HTMLElement>,
		/** On each rendered item: its height, margins included, cached under `key`. */
		measure(key: string): Attachment<Element> {
			return (el) => {
				keys.set(el, key);
				observer?.observe(el);
				return () => observer?.unobserve(el);
			};
		},
		/** Scrolls the nearest scrolling ancestor (else the window) so item `index` shows; for keyboard focus on an unmounted row. */
		reveal(index: number): void {
			if (!on || anchorEl === null || index < 0 || index >= offs.length - 1) return;
			const port = clips.find((c) => c.scrollHeight > c.clientHeight) ?? null;
			const at = anchorEl.getBoundingClientRect().top;
			const [a, b] = [at + offs[index]!, at + offs[index + 1]!];
			const box = port === null ? { top: 0, bottom: innerHeight } : port.getBoundingClientRect();
			const by = a < box.top ? a - box.top : b > box.bottom ? b - box.bottom : 0;
			if (by !== 0) (port ?? document.scrollingElement)?.scrollBy({ top: by });
		},
	};
}
