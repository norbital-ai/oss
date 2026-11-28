// The window math of every long list and 2D grid (Table, Board, EventCalendar, LogLines, Combobox,
// CommandMenu, Transcript, HRMS MonthBoard): pure, over fixed strides or measured item sizes, so it is
// tested without a DOM.

/** Prefix sums: `offsets[i]` is item `i`'s start offset, `offsets[n]` the total extent. */
export function offsets(heights: readonly number[]): [number, ...number[]] {
	const out: [number, ...number[]] = [0];
	let total = 0;
	for (const h of heights) out.push((total += h));
	return out;
}

/** The first index whose item ends strictly past `pos`. */
function rowAt(offs: readonly number[], pos: number): number {
	let lo = 0,
		hi = offs.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const end = offs[mid + 1];
		if (end === undefined) throw new RangeError('The virtual row has no end offset.');
		if (end > pos) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/**
 * Binary Indexed (Fenwick) tree over measured item sizes: O(N) build, O(log N) point update,
 * O(log N) prefix sum, O(log N) binary-lifted offset lookup, and O(1) total extent.
 */
export class SizeTree {
	#n = 0;
	#maxBit = 0;
	#total = 0;
	#values = new Float64Array(0);
	#tree = new Float64Array(1);

	get length(): number {
		return this.#n;
	}

	get total(): number {
		return this.#total;
	}

	/** Rebuilds the tree in linear time for `count` items using `sizeOf(index)`. */
	rebuild(count: number, sizeOf: (index: number) => number): void {
		const n = Math.max(0, count);
		this.#n = n;
		let bit = 1;
		while (bit << 1 <= n) bit <<= 1;
		this.#maxBit = n > 0 ? bit : 0;
		const values = this.#values.length >= n ? this.#values : new Float64Array(n);
		const tree = this.#tree.length >= n + 1 ? this.#tree : new Float64Array(n + 1);
		tree[0] = 0;
		let sum = 0;
		for (let i = 0; i < n; i++) {
			const v = sizeOf(i);
			values[i] = v;
			tree[i + 1] = v;
			sum += v;
		}
		for (let i = 1; i <= n; i++) {
			const parent = i + (i & -i);
			if (parent <= n) tree[parent] = (tree[parent] ?? 0) + (tree[i] ?? 0);
		}
		this.#values = values;
		this.#tree = tree;
		this.#total = sum;
	}

	/** Current size of item `index`. */
	get(index: number): number {
		if (index < 0 || index >= this.#n) return 0;
		return this.#values[index] ?? 0;
	}

	/** Updates item `index` to `value` in O(log N), returning the signed delta (`value - prior`). */
	set(index: number, value: number): number {
		if (index < 0 || index >= this.#n) return 0;
		const prior = this.#values[index] ?? 0;
		const delta = value - prior;
		if (delta === 0) return 0;
		this.#values[index] = value;
		this.#total += delta;
		for (let k = index + 1; k <= this.#n; k += k & -k) {
			this.#tree[k] = (this.#tree[k] ?? 0) + delta;
		}
		return delta;
	}

	/** Start offset of item `index` (`offset(length) === total`) in O(log N). */
	offset(index: number): number {
		if (index <= 0) return 0;
		if (index >= this.#n) return this.#total;
		let sum = 0;
		for (let k = index; k > 0; k -= k & -k) sum += this.#tree[k] ?? 0;
		return sum;
	}

	/** First index in `[0, length]` whose item ends strictly past `pos`, in O(log N). */
	indexAt(pos: number): number {
		if (pos < 0 || this.#n === 0) return 0;
		if (pos >= this.#total) return this.#n;
		let idx = 0;
		let sum = 0;
		for (let bit = this.#maxBit; bit > 0; bit >>= 1) {
			const next = idx + bit;
			if (next <= this.#n) {
				const cand = sum + (this.#tree[next] ?? 0);
				if (cand <= pos) {
					idx = next;
					sum = cand;
				}
			}
		}
		return idx;
	}
}

/**
 * The rendered slice `[start, end)` for a viewport at `top` (list coordinates) `viewport` px wide/tall,
 * with `overscanBefore` items before the leading edge and `overscanAfter` items past the trailing edge.
 * Lists that sit strictly beyond the viewport + overscan return an empty slice (`start === end`) so
 * off-screen sections mount zero DOM nodes while preserving total spacer height.
 */
export function windowOf(
	offs: readonly number[],
	top: number,
	viewport: number,
	overscanBefore = 10,
	overscanAfter = overscanBefore
): { start: number; end: number } {
	const n = offs.length - 1;
	if (n <= 0) return { start: 0, end: 0 };
	const total = offs[n] ?? 0;
	if (viewport > 0 && total > 0) {
		const avg = total / n;
		if (top + viewport < -overscanAfter * avg) return { start: 0, end: 0 };
		if (top > total + overscanBefore * avg) return { start: n, end: n };
	}
	return {
		start: Math.max(0, rowAt(offs, top) - overscanBefore),
		end: Math.min(n, rowAt(offs, top + viewport) + 1 + overscanAfter)
	};
}

/** O(log N) equivalent of `windowOf` backed by a `SizeTree`. */
export function treeWindowOf(
	tree: SizeTree,
	top: number,
	viewport: number,
	overscanBefore = 10,
	overscanAfter = overscanBefore
): { start: number; end: number } {
	const n = tree.length;
	if (n <= 0) return { start: 0, end: 0 };
	const total = tree.total;
	if (viewport > 0 && total > 0) {
		const avg = total / n;
		if (top + viewport < -overscanAfter * avg) return { start: 0, end: 0 };
		if (top > total + overscanBefore * avg) return { start: n, end: n };
	}
	return {
		start: Math.max(0, tree.indexAt(top) - overscanBefore),
		end: Math.min(n, tree.indexAt(top + viewport) + 1 + overscanAfter)
	};
}

/** O(1) window calculation for uniform fixed-stride lists and grid axes. */
export function fixedWindowOf(
	count: number,
	stride: number,
	top: number,
	viewport: number,
	overscanBefore = 10,
	overscanAfter = overscanBefore
): { start: number; end: number } {
	if (count <= 0 || stride <= 0) return { start: 0, end: 0 };
	const total = count * stride;
	if (viewport > 0) {
		if (top + viewport < -overscanAfter * stride) return { start: 0, end: 0 };
		if (top > total + overscanBefore * stride) return { start: count, end: count };
	}
	const first = top <= 0 ? 0 : Math.min(count, Math.floor(top / stride));
	const last = top + viewport <= 0 ? 0 : Math.min(count, Math.floor((top + viewport) / stride));
	return {
		start: Math.max(0, first - overscanBefore),
		end: Math.min(count, last + 1 + overscanAfter)
	};
}

/**
 * Velocity-adaptive directional overscan: expands the leading buffer in the active scroll direction
 * so fast trackpad flings never overtake rendered items, while keeping the trailing buffer compact.
 */
export function directionalOverscan(
	velocityPxPerMs: number,
	viewport: number,
	itemSize: number,
	base: number,
	maxExtra: number
): { before: number; after: number } {
	const speed = Math.abs(velocityPxPerMs);
	if (speed < 0.15 || maxExtra <= 0) return { before: base, after: base };
	const lookaheadPx = Math.min(speed * 160, Math.max(viewport * 1.5, 960));
	const extra = Math.min(maxExtra, Math.ceil(lookaheadPx / Math.max(1, itemSize)));
	return velocityPxPerMs > 0
		? { before: base, after: base + extra }
		: { before: base + extra, after: base };
}
