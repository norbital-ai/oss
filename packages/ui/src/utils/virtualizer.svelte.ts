/**
 * Svelte 5 Runes-based Virtualizer
 *
 * A lightweight virtualizer using runed primitives and small inlined helpers (e.g. sorted-index binary search).
 */

function sortedIndexBy<T>(array: T[], value: T, fn: (item: T) => number): number {
	let lo = 0;
	let hi = array.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (fn(array[mid]) < fn(value)) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	return lo;
}
import { watch } from 'runed';

// ============================================================================
// Types
// ============================================================================

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
	onChange?: (virtualizer: Virtualizer) => void;
	initialOffset?: number;
	indexAttribute?: string;
}

export interface Virtualizer {
	readonly virtualItems: VirtualItem[];
	readonly totalSize: number;
	readonly scrollOffset: number;
	scrollToIndex: (index: number, options?: ScrollToIndexOptions) => void;
	scrollToOffset: (offset: number, options?: ScrollToOffsetOptions) => void;
	measure: () => void;
	measureElement: (element: HTMLElement | null) => void;
	getOffsetForIndex: (index: number, align?: ScrollAlignment) => number;
	getVirtualItems: () => VirtualItem[];
	getTotalSize: () => number;
}

export interface ScrollToIndexOptions {
	align?: ScrollAlignment;
	behavior?: ScrollBehavior;
}

export interface ScrollToOffsetOptions {
	behavior?: ScrollBehavior;
}

export type ScrollAlignment = 'start' | 'center' | 'end' | 'auto';

// ============================================================================
// Implementation
// ============================================================================

export function createVirtualizer(options: VirtualizerOptions): Virtualizer {
	const overscan = options.overscan;
	const getOverscan =
		typeof overscan === 'function' ? overscan : () => overscan ?? 3;

	// Reactive state
	let scrollOffset = $state(options.initialOffset ?? 0);
	let viewportSize = $state(0);
	let measureVersion = $state(0);

	// Size cache
	const measuredSizes = new Map<number, number>();

	// Cleanup tracking
	let cleanup: (() => void) | null = null;
	let scrollFrame: number | null = null;

	// Computed measurements
	const measurements = $derived.by(() => {
		const count = options.count();
		void measureVersion; // Dependency for re-computation

		const result: Array<{
			index: number;
			start: number;
			size: number;
			end: number;
		}> = [];
		let offset = 0;

		for (let i = 0; i < count; i++) {
			const size = measuredSizes.get(i) ?? options.estimateSize(i);
			result.push({ index: i, start: offset, size, end: offset + size });
			offset += size;
		}

		return result;
	});

	// Computed total size
	const totalSize = $derived(
		measurements.length > 0 ? measurements[measurements.length - 1].end : 0
	);

	// Computed visible range via binary search over cumulative measurements
	const visibleRange = $derived.by(() => {
		const m = measurements;
		const viewport = viewportSize;
		const offset = scrollOffset;
		const overscan = getOverscan();

		if (m.length === 0) {
			return { startIndex: 0, endIndex: 0 };
		}

		// If viewport is 0 (not yet measured), render all items up to a reasonable limit
		// This prevents blank rendering on initial mount before ResizeObserver fires
		if (viewport === 0) {
			return { startIndex: 0, endIndex: Math.min(m.length - 1, 20) };
		}

		// Binary search for visible range
		const startIndex = Math.max(
			0,
			sortedIndexBy(m, { start: offset } as (typeof m)[0], (item) => item.start) - 1 - overscan
		);
		const endIndex = Math.min(
			m.length - 1,
			sortedIndexBy(m, { end: offset + viewport } as (typeof m)[0], (item) => item.end) + overscan
		);

		return { startIndex, endIndex };
	});

	// Computed virtual items
	const virtualItems = $derived.by(() => {
		const m = measurements;
		const { startIndex, endIndex } = visibleRange;

		if (m.length === 0) return [];

		const items: VirtualItem[] = [];
		for (let i = startIndex; i <= endIndex; i++) {
			const measurement = m[i];
			if (measurement) {
				items.push({
					index: i,
					key: options.getItemKey?.(i) ?? i,
					start: measurement.start,
					end: measurement.end,
					size: measurement.size
				});
			}
		}
		return items;
	});

	// Watch scroll element changes and set up listeners
	watch(
		() => options.scrollElement(),
		(el) => {
			// Cleanup previous listeners
			cleanup?.();
			cleanup = null;

			if (!el) {
				viewportSize = 0;
				return;
			}

			const syncScrollOffset = () => {
				scrollFrame = null;
				scrollOffset = options.horizontal ? el.scrollLeft : el.scrollTop;
			};

			const handleScroll = () => {
				if (scrollFrame !== null) return;
				scrollFrame = requestAnimationFrame(syncScrollOffset);
			};

			// Update viewport size
			const updateViewport = () => {
				viewportSize = options.horizontal ? el.clientWidth : el.clientHeight;
			};

			// Initial values
			updateViewport();
			scrollOffset = options.horizontal ? el.scrollLeft : el.scrollTop;

			// Set up listeners
			el.addEventListener('scroll', handleScroll, { passive: true });

			const resizeObserver = new ResizeObserver(updateViewport);
			resizeObserver.observe(el);

			cleanup = () => {
				if (scrollFrame !== null) {
					cancelAnimationFrame(scrollFrame);
					scrollFrame = null;
				}
				el.removeEventListener('scroll', handleScroll);
				resizeObserver.disconnect();
			};
		}
	);

	// Watch for virtual items changes to call onChange
	let previousItems: VirtualItem[] = [];
	watch(
		() => virtualItems,
		(items) => {
			const hasChanged =
				items.length !== previousItems.length ||
				items.some((item, i) => item.index !== previousItems[i]?.index);

			if (hasChanged && options.onChange) {
				options.onChange(virtualizer);
			}
			previousItems = items;
		}
	);

	// Methods
	function scrollToOffset(offset: number, opts?: ScrollToOffsetOptions) {
		const el = options.scrollElement();
		if (!el) return;

		el.scrollTo({
			[options.horizontal ? 'left' : 'top']: offset,
			behavior: opts?.behavior ?? 'auto'
		});
	}

	function getOffsetForIndex(index: number, align: ScrollAlignment = 'auto'): number {
		const m = measurements;
		const viewport = viewportSize;
		const measurement = m[index];

		if (!measurement) return 0;

		const { start: itemStart, end: itemEnd, size: itemSize } = measurement;

		switch (align) {
			case 'start':
				return itemStart;
			case 'end':
				return itemEnd - viewport;
			case 'center':
				return itemStart + itemSize / 2 - viewport / 2;
			case 'auto':
			default: {
				const currentEnd = scrollOffset + viewport;
				if (itemStart >= scrollOffset && itemEnd <= currentEnd) return scrollOffset;
				if (itemStart < scrollOffset) return itemStart;
				return itemEnd - viewport;
			}
		}
	}

	function scrollToIndex(index: number, opts?: ScrollToIndexOptions) {
		scrollToOffset(getOffsetForIndex(index, opts?.align), {
			behavior: opts?.behavior
		});
	}

	function measure() {
		measuredSizes.clear();
		measureVersion++;
	}

	function measureElement(element: HTMLElement | null) {
		if (!element) return;

		const indexStr = element.getAttribute(options.indexAttribute ?? 'data-index');
		if (indexStr == null) return;

		const index = parseInt(indexStr, 10);
		if (isNaN(index)) return;

		const size = options.horizontal ? element.offsetWidth : element.offsetHeight;
		if (measuredSizes.get(index) !== size) {
			measuredSizes.set(index, size);
			measureVersion++;
		}
	}

	const virtualizer: Virtualizer = {
		get virtualItems() {
			return virtualItems;
		},
		get totalSize() {
			return totalSize;
		},
		get scrollOffset() {
			return scrollOffset;
		},
		scrollToIndex,
		scrollToOffset,
		measure,
		measureElement,
		getOffsetForIndex,
		getVirtualItems: () => virtualItems,
		getTotalSize: () => totalSize
	};

	return virtualizer;
}
