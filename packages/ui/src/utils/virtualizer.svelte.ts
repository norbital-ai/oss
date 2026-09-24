/**
 * Svelte 5 runes virtualizer: one vertical (or horizontal) window over a list of `count` items.
 *
 * Sizes start at `estimateSize` and are replaced by `measureElement`, cached by item key so a
 * reorder, an insertion or a remount keeps what was measured. A list that does not start at the
 * top of its scrollport (a transcript under a header, a child list inside a parent row) passes
 * `listElement`; its offset inside the scroll content is subtracted before the window is chosen.
 */
import { watch } from 'runed';
import { Predicate } from 'effect';

export interface VirtualItem {
	index: number;
	key: string | number;
	start: number;
	end: number;
	size: number;
}

export interface VirtualizerOptions {
	count: () => number;
	scrollElement: () => HTMLElement | null;
	estimateSize: (index: number) => number;
	overscan?: number | (() => number);
	horizontal?: boolean;
	getItemKey?: (index: number) => string | number;
	/** The element the items are laid out in, when it is not the scroll content's origin. */
	listElement?: () => HTMLElement | null;
	onChange?: (virtualizer: Virtualizer) => void;
}

export interface Virtualizer {
	readonly virtualItems: VirtualItem[];
	readonly totalSize: number;
	scrollToIndex: (index: number, options?: ScrollToIndexOptions) => void;
	scrollToOffset: (offset: number, options?: ScrollToOffsetOptions) => void;
	/** Drops every measured size; the next `measureElement` calls re-fill the cache. */
	measure: () => void;
	/** Records the size of an element carrying `data-index`. */
	measureElement: (element: HTMLElement | null) => void;
}

export interface ScrollToIndexOptions {
	align?: ScrollAlignment;
	behavior?: ScrollBehavior;
}

export interface ScrollToOffsetOptions {
	behavior?: ScrollBehavior;
}

export type ScrollAlignment = 'start' | 'center' | 'end' | 'auto';

/** First index whose `pick` is >= `value` in an ascending array. */
function lowerBound<T>(array: readonly T[], value: number, pick: (item: T) => number): number {
	let lo = 0;
	let hi = array.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (pick(array[mid]!) < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Viewport-less first paint: enough rows to fill a screen before the ResizeObserver reports. */
const UNMEASURED_WINDOW = 20;

export function createVirtualizer(options: VirtualizerOptions): Virtualizer {
	const overscanOption = options.overscan;
	const getOverscan = Predicate.isFunction(overscanOption)
		? overscanOption
		: () => overscanOption ?? 3;
	const keyAt = (index: number) => options.getItemKey?.(index) ?? index;
	const axisOffset = (el: HTMLElement) => (options.horizontal ? el.scrollLeft : el.scrollTop);

	let scrollOffset = $state(0);
	let scrollMargin = $state(0);
	let viewportSize = $state(0);
	let measureVersion = $state(0);
	const measuredSizes = new Map<string | number, number>();

	const measurements = $derived.by(() => {
		const count = options.count();
		void measureVersion;
		const result: VirtualItem[] = [];
		let start = 0;
		for (let index = 0; index < count; index++) {
			const key = keyAt(index);
			const size = measuredSizes.get(key) ?? options.estimateSize(index);
			result.push({ index, key, start, size, end: start + size });
			start += size;
		}
		return result;
	});

	const totalSize = $derived(measurements.at(-1)?.end ?? 0);

	const virtualItems = $derived.by(() => {
		const m = measurements;
		if (m.length === 0) return [];
		if (viewportSize === 0) return m.slice(0, UNMEASURED_WINDOW + 1);
		const overscan = getOverscan();
		const offset = scrollOffset - scrollMargin;
		const startIndex = Math.max(0, lowerBound(m, offset, (item) => item.end) - overscan);
		const endIndex = Math.min(
			m.length - 1,
			lowerBound(m, offset + viewportSize, (item) => item.end) + overscan
		);
		return m.slice(startIndex, endIndex + 1);
	});

	function readMargin(el: HTMLElement): number {
		const list = options.listElement?.();
		if (!list) return 0;
		const listRect = list.getBoundingClientRect();
		const portRect = el.getBoundingClientRect();
		return options.horizontal
			? listRect.left - portRect.left + el.scrollLeft
			: listRect.top - portRect.top + el.scrollTop;
	}

	watch(
		() => [options.scrollElement(), options.listElement?.()] as const,
		([el, list]) => {
			if (!el) {
				viewportSize = 0;
				return;
			}
			let frame: number | null = null;
			const sync = () => {
				frame = null;
				scrollOffset = axisOffset(el);
				scrollMargin = readMargin(el);
				viewportSize = options.horizontal ? el.clientWidth : el.clientHeight;
			};
			const schedule = () => {
				frame ??= requestAnimationFrame(sync);
			};
			sync();
			el.addEventListener('scroll', schedule, { passive: true });
			const resizeObserver = new ResizeObserver(schedule);
			resizeObserver.observe(el);
			if (list) resizeObserver.observe(list);
			return () => {
				if (frame !== null) cancelAnimationFrame(frame);
				el.removeEventListener('scroll', schedule);
				resizeObserver.disconnect();
			};
		}
	);

	const windowSignature = $derived(
		`${virtualItems[0]?.index ?? -1}:${virtualItems.at(-1)?.index ?? -1}:${measurements.length}`
	);
	if (options.onChange) {
		const onChange = options.onChange;
		watch(
			() => windowSignature,
			() => onChange(virtualizer)
		);
	}

	function scrollToOffset(offset: number, opts?: ScrollToOffsetOptions) {
		options.scrollElement()?.scrollTo({
			[options.horizontal ? 'left' : 'top']: offset,
			behavior: opts?.behavior ?? 'auto'
		});
	}

	function scrollToIndex(index: number, opts?: ScrollToIndexOptions) {
		const item = measurements[index];
		if (!item) return;
		const start = item.start + scrollMargin;
		const end = item.end + scrollMargin;
		const target = (() => {
			switch (opts?.align ?? 'auto') {
				case 'start':
					return start;
				case 'end':
					return end - viewportSize;
				case 'center':
					return start + item.size / 2 - viewportSize / 2;
				case 'auto':
					if (start >= scrollOffset && end <= scrollOffset + viewportSize) return null;
					return start < scrollOffset ? start : end - viewportSize;
			}
		})();
		if (target !== null) scrollToOffset(target, { behavior: opts?.behavior });
	}

	function measure() {
		measuredSizes.clear();
		measureVersion++;
	}

	function measureElement(element: HTMLElement | null) {
		const index = Number(element?.dataset.index);
		const item = measurements[index];
		if (!element || !item) return;
		const size = options.horizontal ? element.offsetWidth : element.offsetHeight;
		if (measuredSizes.get(item.key) === size) return;
		measuredSizes.set(item.key, size);
		measureVersion++;
		// An item above the window changing size would shove everything the reader is looking at.
		// Absorb the delta into the scroll position — the same anchoring `overflow-anchor` gives flow
		// layout, which a translated window cannot use.
		const el = options.scrollElement();
		if (el && item.start + scrollMargin < axisOffset(el) && size !== item.size) {
			const next = axisOffset(el) + size - item.size;
			if (options.horizontal) el.scrollLeft = next;
			else el.scrollTop = next;
		}
	}

	const virtualizer: Virtualizer = {
		get virtualItems() {
			return virtualItems;
		},
		get totalSize() {
			return totalSize;
		},
		scrollToIndex,
		scrollToOffset,
		measure,
		measureElement
	};
	return virtualizer;
}
