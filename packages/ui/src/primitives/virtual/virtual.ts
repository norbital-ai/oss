// The window math of every long list (Table, Board, Matrix, Combobox, CommandMenu, LogView, the agent transcript): pure,
// over measured row heights, so it is tested without a DOM.

/** Prefix sums: `offsets[i]` is row i's top, `offsets[n]` the total height. */
export function offsets(heights: readonly number[]): number[] {
	const out = [0];
	for (const h of heights) out.push(out[out.length - 1]! + h);
	return out;
}

/** The first index whose row ends below `y`. */
function rowAt(offs: readonly number[], y: number): number {
	let lo = 0, hi = offs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (offs[mid + 1]! > y) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The rendered slice `[start, end)` for a viewport at `top` (list coordinates) `viewport` px tall, `overscan` rows either side. */
export function windowOf(offs: readonly number[], top: number, viewport: number, overscan = 10): { start: number; end: number } {
	const n = offs.length - 1;
	return { start: Math.max(0, rowAt(offs, top) - overscan), end: Math.min(n, rowAt(offs, top + viewport) + 1 + overscan) };
}
