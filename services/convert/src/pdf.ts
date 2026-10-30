// A PDF from its own structure, read once by pdf.js: never pixels, never a model, never OCR. Per page, as shown (its
// /Rotate and every matrix applied):
//   text      positioned runs → lines → headings (size, weight), list items (marker, hanging indent), paragraphs
//   ruled     the rules make a grid; an inner rule missing between two cells merges them (colspan, rowspan); a grid
//             inside another's cell nests in it; a grid ending a page continues on the next when that page opens with
//             a grid of the same columns
//   unruled   ≥ 3 consecutive lines whose gaps line up into ≥ 2 columns of short cells; anything less stays paragraphs
//   pictures  in reading order, turned as the page shows them (a scanned page is its picture, upright)
// Every word lands once: in one table cell or in one line of text.
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { Effect, Option } from 'effect';
import { escape, inline, type Block, type Cell, type Images } from './blocks.ts';
import { encode, orient, type Pixels } from './png.ts';

/** PDF user space, y up. */
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Word = {
	text: string;
	x0: number;
	x1: number;
	y: number;
	size: number;
	split: boolean;
	rotated: boolean;
	bold: boolean;
	italic: boolean;
};

const TOL = 2;

// ---------- text ----------
type Item = { str: string; transform: number[]; width: number; bold?: boolean; italic?: boolean };
export function wordsOf(items: readonly Item[], start: M = [1, 0, 0, 1, 0, 0]): Word[] {
	const out: Word[] = [];
	for (const { str, transform, width, bold = false, italic = false } of items) {
		const t = matrix(transform);
		if (!str.trim() || !t) continue;
		const [a, b, c, d, e, f] = mul(t, start);
		const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;
		// Rotated text has no column: its words sit at the run's origin.
		const rotated = Math.abs(b) > 0.01 || Math.abs(c) > 0.01;
		const unit = rotated ? 0 : width / str.length;
		for (const m of str.matchAll(/\S+/g))
			out.push({
				text: m[0],
				x0: e + m.index * unit,
				x1: e + (m.index + m[0].length) * unit,
				y: f,
				size,
				split: / {2,}$/.test(str.slice(0, m.index)),
				rotated,
				bold,
				italic
			});
	}
	return out;
}
/** Words in lines, top to bottom, each left to right. */
export function linesOf(words: readonly Word[]): Word[][] {
	const lines: Word[][] = [];
	for (const w of [...words].sort((p, q) => q.y - p.y)) {
		const line = lines.at(-1);
		if (line && Math.abs(line[0]!.y - w.y) <= 0.35 * Math.max(line[0]!.size, w.size)) line.push(w);
		else lines.push([w]);
	}
	return lines.map((l) => l.sort((p, q) => p.x0 - q.x0));
}
/** One word set in two runs (a kern, a change of font): touching, not overlapping. */
const glued = (line: readonly Word[], i: number) => {
	const gap = i > 0 ? line[i]!.x0 - line[i - 1]!.x1 : Infinity;
	return gap <= 0.12 * line[i]!.size && gap >= -0.2 * line[i]!.size;
};
/** A line as inline HTML: words a space apart (touching ones joined), bold and italic runs wrapped (a heading's bold is its own). */
const htmlOf = (line: readonly Word[], heading = false) => {
	let out = '';
	for (let i = 0; i < line.length; ) {
		const w = line[i]!;
		let j = i;
		let run = '';
		for (; j < line.length && (heading || line[j]!.bold === w.bold) && line[j]!.italic === w.italic; j++)
			run += (j > i && !glued(line, j) ? ' ' : '') + escape(line[j]!.text);
		out += (i > 0 && !glued(line, i) ? ' ' : '') + inline(run, { strong: w.bold && !heading, em: w.italic });
		i = j;
	}
	return out;
};
const joined = (line: readonly Word[]) => line.reduce((s, w, i) => s + (i > 0 && !glued(line, i) ? ' ' : '') + w.text, '');
const cell = (words: readonly Word[], colspan = 1, rowspan = 1, nested: Block[] = []): Cell => {
	const t = linesOf(words).map((l) => htmlOf(l)).join(' ');
	return { header: false, colspan, rowspan, blocks: [...(t ? [{ t: 'p' as const, html: t }] : []), ...nested] };
};
const centre = (w: Word) => ({ x: (w.x0 + w.x1) / 2, y: w.y + 0.3 * w.size });
const inside = (b: Box, x: number, y: number) => x >= b.x0 - TOL && x <= b.x1 + TOL && y >= b.y0 - TOL && y <= b.y1 + TOL;

// ---------- rules and pictures ----------
type H = { y: number; x0: number; x1: number };
type V = { x: number; y0: number; y1: number };
export type M = [number, number, number, number, number, number];
const matrix = (x: unknown): M | undefined => {
	const n = Array.isArray(x) || x instanceof Float32Array ? Array.from(x, Number) : [];
	return n.length === 6 && n.every(Number.isFinite) ? [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!] : undefined;
};
const mul = (m: M, c: M): M => [
	m[0] * c[0] + m[1] * c[2],
	m[0] * c[1] + m[1] * c[3],
	m[2] * c[0] + m[3] * c[2],
	m[2] * c[1] + m[3] * c[3],
	m[4] * c[0] + m[5] * c[2] + c[4],
	m[4] * c[1] + m[5] * c[3] + c[5]
];
const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
const FILL = new Set([OPS.fill, OPS.eoFill]);

/**
 * Where a picture is painted: its pixel size, the matrix taking its unit square onto the shown page (y up), and its
 * pixels (an object id, or the inline image itself).
 */
export type Paint = { width: number; height: number; m: M; source: string | object };
/**
 * The page's straight horizontal and vertical strokes and its thin filled bars, and the pictures it paints, in the
 * shown page's space (`start` takes the page's own space there: its /Rotate).
 */
export function rulesOf(fnArray: readonly number[], argsArray: readonly unknown[], start: M = [1, 0, 0, 1, 0, 0]): { h: H[]; v: V[]; paints: Paint[] } {
	const h: H[] = [];
	const v: V[] = [];
	const paints: Paint[] = [];
	const line = (ax: number, ay: number, bx: number, by: number) => {
		if (Math.abs(ay - by) <= 0.5 && Math.abs(ax - bx) > 1) h.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
		else if (Math.abs(ax - bx) <= 0.5 && Math.abs(ay - by) > 1) v.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
	};
	let m: M = start;
	const stack: M[] = [];
	for (let i = 0; i < fnArray.length; i++) {
		const fn = fnArray[i];
		const args: unknown = argsArray[i];
		const list: readonly unknown[] = Array.isArray(args) ? args : [];
		if (fn === OPS.save) stack.push(m);
		else if (fn === OPS.restore) m = stack.pop() ?? m;
		else if (fn === OPS.transform) m = mul(matrix(list) ?? [1, 0, 0, 1, 0, 0], m);
		else if (fn === OPS.paintFormXObjectBegin) {
			stack.push(m);
			m = mul(matrix(list[0]) ?? [1, 0, 0, 1, 0, 0], m);
		} else if (fn === OPS.paintFormXObjectEnd) m = stack.pop() ?? m;
		else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
			const first: unknown = list[0];
			const [source, width, height]: unknown[] =
				fn === OPS.paintImageXObject
					? [first, list[1], list[2]]
					: typeof first === 'object' && first !== null && 'width' in first && 'height' in first
						? [first, first.width, first.height]
						: [];
			if ((typeof source === 'string' || (typeof source === 'object' && source !== null)) && typeof width === 'number' && typeof height === 'number')
				paints.push({ width, height, m, source });
		} else if (fn === OPS.constructPath) {
			const paint = list[0];
			const inner: unknown = list[1];
			const data: unknown = Array.isArray(inner) ? inner[0] : undefined;
			if (typeof paint !== 'number' || !(data instanceof Float32Array) || !(STROKE.has(paint) || FILL.has(paint))) continue;
			const at = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
			const subpaths: [number, number][][] = [];
			let start: [number, number] = [0, 0];
			for (let k = 0; k < data.length; ) {
				const op = data[k++];
				if (op === 0 || op === 1) {
					const p = at(data[k]!, data[k + 1]!);
					k += 2;
					if (op === 0) subpaths.push([(start = p)]);
					else subpaths.at(-1)?.push(p);
				} else if (op === 2 || op === 3) {
					const n = op === 2 ? 6 : 4;
					subpaths.push([at(data[k + n - 2]!, data[k + n - 1]!)]);
					k += n;
				} else if (op === 4) subpaths.at(-1)?.push(start);
				else break;
			}
			for (const s of subpaths) {
				if (STROKE.has(paint)) for (let j = 1; j < s.length; j++) line(s[j - 1]![0], s[j - 1]![1], s[j]![0], s[j]![1]);
				else {
					// A thin filled bar is a rule; a wider fill is shading.
					const xs = s.map((p) => p[0]);
					const ys = s.map((p) => p[1]);
					const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
					if (y1 - y0 <= 2.5 && x1 - x0 > y1 - y0) line(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
					else if (x1 - x0 <= 2.5 && y1 - y0 > x1 - x0) line((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
				}
			}
		}
	}
	return { h, v, paints };
}

/** Values within TOL of the previous one share the first one's value. */
const snap = (values: number[]) => {
	const sorted = [...new Set(values)].sort((a, b) => a - b);
	const out: number[] = [];
	for (const x of sorted) if (out.length === 0 || x - out.at(-1)! > TOL) out.push(x);
	return out;
};
const nearest = (grid: number[], x: number) => grid.reduce((b, g) => (Math.abs(g - x) < Math.abs(b - x) ? g : b), grid[0]!);
/** Collinear and touching segments joined. */
function merge<S>(segs: S[], at: (s: S) => number, lo: (s: S) => number, hi: (s: S) => number, make: (at: number, lo: number, hi: number) => S) {
	const grid = snap(segs.map(at));
	const sorted = segs.map((s) => make(nearest(grid, at(s)), lo(s), hi(s))).sort((a, b) => at(a) - at(b) || lo(a) - lo(b));
	const out: S[] = [];
	for (const s of sorted) {
		const last = out.at(-1);
		if (last && at(last) === at(s) && lo(s) <= hi(last) + TOL) out[out.length - 1] = make(at(last), lo(last), Math.max(hi(last), hi(s)));
		else out.push(s);
	}
	return out;
}

type Grid = { box: Box; cols: number[]; rows: Cell[][]; words: Word[] };
/** Ruled tables: each connected set of rules is a grid; the words inside it fill its cells. A grid that is not clean holds none. */
export function lattice(rules: { h: H[]; v: V[] }, words: readonly Word[]): Grid[] {
	const hs = merge(rules.h, (s) => s.y, (s) => s.x0, (s) => s.x1, (y, x0, x1) => ({ y, x0, x1 }));
	const vs = merge(rules.v, (s) => s.x, (s) => s.y0, (s) => s.y1, (x, y0, y1) => ({ x, y0, y1 }));
	// ponytail: O(h·v) component search; a page of thousands of rules (a vector drawing) is skipped rather than gridded.
	if (hs.length * vs.length > 250_000) return [];
	const parent = [...hs, ...vs].map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
	hs.forEach((h, i) =>
		vs.forEach((v, j) => {
			if (v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && h.y >= v.y0 - TOL && h.y <= v.y1 + TOL) parent[find(i)] = find(hs.length + j);
		})
	);
	const groups = new Map<number, { h: H[]; v: V[] }>();
	hs.forEach((h, i) => groups.get(find(i))?.h.push(h) ?? groups.set(find(i), { h: [h], v: [] }));
	vs.forEach((v, j) => groups.get(find(hs.length + j))?.v.push(v) ?? groups.set(find(hs.length + j), { h: [], v: [v] }));
	const comps = [...groups.values()]
		.filter((g) => g.h.length >= 2 && g.v.length >= 2)
		.map((g) => {
			const xs = snap([...g.v.map((v) => v.x), Math.min(...g.h.map((h) => h.x0)), Math.max(...g.h.map((h) => h.x1))]);
			const ys = snap([...g.h.map((h) => h.y), Math.min(...g.v.map((v) => v.y0)), Math.max(...g.v.map((v) => v.y1))]).reverse();
			return { ...g, xs, ys, box: { x0: xs[0]!, x1: xs.at(-1)!, y0: ys.at(-1)!, y1: ys[0]! } };
		})
		.sort((a, b) => (a.box.x1 - a.box.x0) * (a.box.y1 - a.box.y0) - (b.box.x1 - b.box.x0) * (b.box.y1 - b.box.y0));
	const taken = new Set<Word>();
	const tables: (Grid & { nested?: boolean })[] = [];
	for (const g of comps) {
		const covered = (x: number, top: number, bottom: number) =>
			g.v.reduce((s, v) => s + (Math.abs(v.x - x) <= TOL ? Math.max(0, Math.min(v.y1, top) - Math.max(v.y0, bottom)) : 0), 0) >=
			0.5 * (top - bottom);
		const coveredH = (y: number, left: number, right: number) =>
			g.h.reduce((s, h) => s + (Math.abs(h.y - y) <= TOL ? Math.max(0, Math.min(h.x1, right) - Math.max(h.x0, left)) : 0), 0) >=
			0.5 * (right - left);
		// A rule that bounds no cell anywhere (a tick, a short underline) is no boundary.
		const ys = g.ys.filter((y, r) => r === 0 || r === g.ys.length - 1 || g.xs.some((x, c) => c > 0 && coveredH(y, g.xs[c - 1]!, x)));
		const xs = g.xs.filter((x, c) => c === 0 || c === g.xs.length - 1 || ys.some((y, r) => r > 0 && covered(x, ys[r - 1]!, y)));
		const nR = ys.length - 1;
		const nC = xs.length - 1;
		if (nR < 2 || nC < 2) continue;
		const cells = Array.from({ length: nR * nC }, (_, i) => i);
		const root = (i: number): number => (cells[i] === i ? i : (cells[i] = root(cells[i]!)));
		for (let r = 0; r < nR; r++)
			for (let c = 0; c < nC; c++) {
				if (c + 1 < nC && !covered(xs[c + 1]!, ys[r]!, ys[r + 1]!)) cells[root(r * nC + c + 1)] = root(r * nC + c);
				if (r + 1 < nR && !coveredH(ys[r + 1]!, xs[c]!, xs[c + 1]!)) cells[root((r + 1) * nC + c)] = root(r * nC + c);
			}
		const span = new Map<number, { r0: number; r1: number; c0: number; c1: number; n: number; words: Word[]; nested: Block[] }>();
		for (let i = 0; i < nR * nC; i++) {
			const [r, c, k] = [Math.floor(i / nC), i % nC, root(i)];
			const s = span.get(k) ?? { r0: r, r1: r, c0: c, c1: c, n: 0, words: [], nested: [] };
			span.set(k, { ...s, r1: Math.max(s.r1, r), c0: Math.min(s.c0, c), c1: Math.max(s.c1, c), n: s.n + 1 });
		}
		const box: Box = { x0: xs[0]!, x1: xs[nC]!, y0: ys[nR]!, y1: ys[0]! };
		const slot = (x: number, y: number) => {
			const c = Math.min(nC - 1, Math.max(0, xs.findLastIndex((v) => v <= x)));
			const r = Math.min(nR - 1, Math.max(0, ys.findLastIndex((v) => v >= y)));
			return span.get(root(r * nC + c))!;
		};
		let clean = [...span.values()].every((s) => s.n === (s.r1 - s.r0 + 1) * (s.c1 - s.c0 + 1));
		const mine = words.filter((w) => !taken.has(w) && inside(box, centre(w).x, centre(w).y));
		for (const w of mine) {
			const s = slot(centre(w).x, centre(w).y);
			// A word across a drawn boundary has no one cell.
			const slack = 0.25 * w.size;
			if ((w.x0 < xs[s.c0]! - slack && s.c0 > 0) || (w.x1 > xs[s.c1 + 1]! + slack && s.c1 + 1 < nC)) clean = false;
			s.words.push(w);
		}
		// Text a space apart in two cells, or over other text, or running on past the grid's edge, crosses a rule.
		for (const l of linesOf(mine))
			l.forEach((w, i) => {
				const prev = l[i - 1];
				const gap = prev ? w.x0 - prev.x1 : Infinity;
				if (gap < -1 || (prev && gap < 0.3 * w.size && slot(centre(w).x, centre(w).y) !== slot(centre(prev).x, centre(prev).y))) clean = false;
			});
		const own = new Set(mine);
		const near = (w: Word, o: Word) =>
			!own.has(o) && !taken.has(o) && Math.abs(o.y - w.y) <= 0.35 * w.size && (Math.abs(o.x0 - w.x1) < 0.3 * w.size || Math.abs(w.x0 - o.x1) < 0.3 * w.size);
		if (mine.some((w) => (w.x1 > box.x1 - 2 * w.size || w.x0 < box.x0 + 2 * w.size) && words.some((o) => near(w, o)))) clean = false;
		const inner = tables.filter((t) => !t.nested && t.box.x0 >= box.x0 - TOL && t.box.x1 <= box.x1 + TOL && t.box.y0 >= box.y0 - TOL && t.box.y1 <= box.y1 + TOL);
		const filled = [...span.values()].filter((s) => s.words.length > 0 || inner.some((t) => slot((t.box.x0 + t.box.x1) / 2, (t.box.y0 + t.box.y1) / 2) === s)).length;
		// Mostly empty cells are a chart's grid or a blank form, not a table; an unclean grid stays text.
		if (!clean || filled < 2 || filled < 0.4 * span.size) continue;
		for (const t of inner) {
			slot((t.box.x0 + t.box.x1) / 2, (t.box.y0 + t.box.y1) / 2).nested.push({ t: 'table', rows: t.rows });
			t.nested = true;
		}
		mine.forEach((w) => taken.add(w));
		const rows: Cell[][] = Array.from({ length: nR }, () => []);
		for (const s of [...span.values()].sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0))
			rows[s.r0]!.push(cell(s.words, s.c1 - s.c0 + 1, s.r1 - s.r0 + 1, s.nested));
		tables.push({ box, cols: xs, rows, words: [...mine, ...inner.flatMap((t) => t.words)] });
	}
	return tables.filter((t) => !t.nested);
}

// ---------- unruled ----------
/** A line's chunks: words parted by a gap of about an em or more, or by a run of spaces. */
const chunksOf = (line: readonly Word[]) => {
	const out: Word[][] = [];
	line.forEach((w, i) => {
		const gap = i === 0 ? Infinity : w.x0 - line[i - 1]!.x1;
		if (gap > 0.9 * w.size || w.split) out.push([w]);
		else out.at(-1)!.push(w);
	});
	return out;
};
const extent = (ws: readonly Word[]) => ({ x0: Math.min(...ws.map((w) => w.x0)), x1: Math.max(...ws.map((w) => w.x1)) });

/**
 * Unruled tables: runs of ≥ 3 lines of ≥ 2 chunks that share columns and hold short cells, with no vertical rule
 * between them (a chart's axis labels have its frame there). A run with any line astray stays text.
 */
export function stream(words: readonly Word[], v: readonly V[] = []): Grid[] {
	const lines = linesOf(words.filter((w) => !w.rotated)).map((l) => ({ words: l, chunks: chunksOf(l) }));
	const runs: (typeof lines)[] = [];
	lines.forEach((l, i) => {
		const prev = lines[i - 1];
		const near = prev !== undefined && prev.words[0]!.y - l.words[0]!.y <= 2.2 * l.words[0]!.size;
		if (l.chunks.length < 2) return;
		if (near && runs.at(-1)?.at(-1) === prev) runs.at(-1)!.push(l);
		else runs.push([l]);
	});
	const tables: Grid[] = [];
	for (const run of runs) {
		if (run.length < 3) continue;
		const chunks = run.flatMap((l) => l.chunks);
		// Short cells: prose in two columns (or unspaced CJK lines) is no table.
		if (chunks.reduce((s, c) => s + c.length, 0) / chunks.length > 4) continue;
		if (chunks.reduce((s, c) => s + joined(c).length, 0) / chunks.length > 24) continue;
		const counts = run.map((l) => l.chunks.length);
		const often = (n: number) => counts.filter((m) => m === n).length;
		const k = [...new Set(counts)].sort((a, b) => often(b) - often(a) || b - a)[0]!;
		// Columns: where the chunks of the k-chunk lines fall; a stray line's chunk alone makes none.
		const full = run.filter((l) => l.chunks.length === k);
		const merged: { x0: number; x1: number; n: number }[] = [];
		for (const s of full.flatMap((l) => l.chunks.map(extent)).sort((a, b) => a.x0 - b.x0)) {
			const last = merged.at(-1);
			if (last && s.x0 <= last.x1) [last.x1, last.n] = [Math.max(last.x1, s.x1), last.n + 1];
			else merged.push({ ...s, n: 1 });
		}
		const cols = merged.filter((c) => c.n >= Math.max(2, full.length / 3));
		if (cols.length !== k) continue;
		const all = run.flatMap((l) => l.words);
		const box: Box = {
			x0: Math.min(...all.map((w) => w.x0)),
			x1: Math.max(...all.map((w) => w.x1)),
			y0: Math.min(...all.map((w) => w.y - 0.3 * w.size)),
			y1: Math.max(...all.map((w) => w.y + w.size))
		};
		if (v.some((r) => r.x > box.x0 + TOL && r.x < box.x1 - TOL && Math.min(r.y1, box.y1) - Math.max(r.y0, box.y0) >= 0.5 * (box.y1 - box.y0))) continue;
		const rows: Cell[][] = [];
		let clean = true;
		for (const l of run) {
			const row: Cell[] = [];
			let next = 0;
			for (const c of l.chunks) {
				const s = extent(c);
				const hit = cols.flatMap((col, i) => (s.x0 <= col.x1 && s.x1 >= col.x0 ? [i] : []));
				if (hit.length === 0 || hit[0]! < next) {
					clean = false;
					break;
				}
				for (; next < hit[0]!; next++) row.push(cell([]));
				row.push(cell(c, hit.length));
				next = hit.at(-1)! + 1;
			}
			for (; next < cols.length; next++) row.push(cell([]));
			rows.push(row);
		}
		if (clean) tables.push({ box, cols: cols.map((c) => c.x0), rows, words: all });
	}
	return tables;
}

// ---------- text blocks ----------
type Line = { words: Word[]; y: number; x0: number; x1: number; size: number; bold: boolean };
/** A heading holds at most this many characters (a title wraps onto at most three lines). */
const HEADING_CHARS = 150;
const BULLET = /^[•●○◦▪▫■□‣⁃∙·♦*\-–—]$/u;
const NUMBER = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\([ivxIVX]{1,4}\))$/;
/** The body text's size: the one most characters are set in. */
export function bodySize(words: readonly Word[]) {
	const chars = new Map<number, number>();
	for (const w of words) chars.set(Math.round(w.size * 2) / 2, (chars.get(Math.round(w.size * 2) / 2) ?? 0) + w.text.length);
	return [...chars].reduce((a, b) => (b[1] > a[1] ? b : a), [10, 0])[0];
}
/**
 * Lines as headings, list items and paragraphs. Lines run on into one block while the leading, the size, the weight
 * and the left edge hold (a list item: its hanging indent); a bullet or a number opens an item. A block of at most three
 * short lines set larger than the body (its level the rank of its size), or all bold over text that is not, is a heading.
 */
function textBlocks(lines: readonly Line[], body: number, levels: readonly number[]): Block[] {
	type Group = { lines: Line[]; marker: boolean; ordered: boolean; indent: number };
	const groups: Group[] = [];
	for (const l of lines) {
		const g = groups.at(-1);
		const prev = g?.lines.at(-1);
		const gap = prev ? prev.y - l.y : 0;
		const lead = g && g.lines.length > 1 ? g.lines[0]!.y - g.lines[1]!.y : 0;
		const first = l.words[0]!.text;
		const marker = l.words.length > 1 && (BULLET.test(first) || NUMBER.test(first));
		const near = prev !== undefined && gap > 0.3 * l.size && gap <= Math.max(1.5 * l.size, lead + 0.25 * l.size) && Math.abs(prev.size - l.size) <= 0.5 && prev.bold === l.bold;
		if (
			g &&
			near &&
			!marker &&
			(g.marker ? l.x0 >= g.indent - 0.5 * l.size : g.lines.length === 1 ? l.x0 <= g.indent + l.size : Math.abs(l.x0 - g.indent) <= l.size)
		) {
			if (!g.marker && g.lines.length === 1) g.indent = Math.min(g.indent, l.x0);
			g.lines.push(l);
		} else groups.push({ lines: [l], marker, ordered: marker && NUMBER.test(first), indent: marker ? l.words[1]!.x0 : l.x0 });
	}
	const out: Block[] = [];
	const bold = (g: Group | undefined) => g !== undefined && !g.marker && g.lines.every((l) => l.bold);
	for (const [i, g] of groups.entries()) {
		const text = g.lines.map((l) => joined(l.words)).join(' ');
		const size = Math.max(...g.lines.map((l) => l.size));
		const short = !g.marker && g.lines.length <= 3 && text.length <= HEADING_CHARS;
		const level =
			short && size >= body * 1.15
				? Math.min(6, levels.findIndex((s) => size >= s - 0.25) + 1)
				: short && bold(g) && groups[i + 1] !== undefined && !bold(groups[i + 1]) && !/[.,;:]$/.test(text)
					? Math.min(6, levels.length + 1)
					: 0;
		const html = g.lines.map((l) => htmlOf(l.words, level > 0)).join(' ');
		const last = out.at(-1);
		if (level > 0) out.push({ t: 'h', level, html });
		else if (!g.marker) out.push({ t: 'p', html });
		else if (last?.t === 'list' && last.ordered === g.ordered) last.items.push([{ t: 'p', html }]);
		else out.push({ t: 'list', ordered: g.ordered, items: [[{ t: 'p', html }]] });
	}
	return out;
}
const lineOf = (words: Word[]): Line => ({
	words,
	y: words[0]!.y,
	x0: words[0]!.x0,
	x1: words.at(-1)!.x1,
	size: Math.max(...words.map((w) => w.size)),
	bold: words.every((w) => w.bold)
});

// ---------- the document ----------
type Picture = { box: Box; block: Block };
type Page = { n: number; view: Box; words: Word[]; tables: Grid[]; pictures: Picture[] };
type Placed = { box: Box; block: Block | null };
/** A grid ending one page and one opening the next with the same columns are one table (`block` null on the later page). */
function continued(pages: readonly Page[]): Placed[][] {
	let open: { cols: number[]; rows: Cell[][] } | undefined;
	return pages.map((p) => {
		const sorted = [...p.tables].sort((a, b) => b.box.y1 - a.box.y1);
		const band = 0.1 * (p.view.y1 - p.view.y0);
		const free = (t: Grid) => p.words.filter((w) => !t.words.includes(w));
		if (sorted.length === 0 && p.words.length > 0) open = undefined;
		return sorted.map((t, i): Placed => {
			const first = i === 0 && free(t).every((w) => w.y <= t.box.y1 || w.y >= p.view.y1 - band);
			const same = open !== undefined && open.cols.length === t.cols.length && open.cols.every((x, j) => Math.abs(x - t.cols[j]!) <= TOL);
			let placed: Placed;
			if (first && same && open) {
				open.rows.push(...t.rows);
				placed = { box: t.box, block: null };
			} else {
				open = { cols: t.cols, rows: t.rows };
				placed = { box: t.box, block: { t: 'table', rows: open.rows } };
			}
			const last = i === sorted.length - 1 && free(t).every((w) => w.y >= t.box.y0 || w.y <= p.view.y0 + band);
			if (!last) open = undefined;
			return placed;
		});
	});
}

/**
 * A page as shown: its box (from 0, 0) and the matrix taking the page's own space there, so a page with /Rotate reads
 * the way it is seen.
 */
const shown = (page: { getViewport: (o: { scale: number }) => { transform: number[]; width: number; height: number } }) => {
	const vp = page.getViewport({ scale: 1 });
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = vp.transform;
	return { view: { x0: 0, y0: 0, x1: vp.width, y1: vp.height }, upright: [a, -b, c, -d, e, vp.height - f] satisfies M };
};
const open = (bytes: Uint8Array) =>
	Effect.acquireRelease(
		Effect.sync(() => getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, fontExtraProperties: true })),
		(t) => Effect.promise(() => t.destroy())
	).pipe(Effect.flatMap((t) => Effect.tryPromise(() => t.promise)));

/** A painted picture's pixels as pdf.js decoded them (rows top first, as stored), and its object ref. */
const pixelsOf = (data: unknown): (Pixels & { ref: unknown }) | undefined => {
	if (typeof data !== 'object' || data === null || !('width' in data && 'height' in data && 'kind' in data && 'data' in data)) return undefined;
	const { width, height, kind, data: raw } = data;
	const ref = 'ref' in data ? data.ref : undefined;
	if (typeof width !== 'number' || typeof height !== 'number' || !(raw instanceof Uint8Array || raw instanceof Uint8ClampedArray)) return undefined;
	if (kind === 2 || kind === 3) return { width, height, channels: kind === 2 ? 3 : 4, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), ref };
	if (kind !== 1) return undefined;
	// One bit a pixel, rows padded to a byte: set is white.
	const gray = new Uint8Array(width * height);
	const stride = (width + 7) >> 3;
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = (raw[y * stride + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
	return { width, height, channels: 1, data: gray, ref };
};
/**
 * The file's baseline JPEG image streams by pdf.js object ref (`12R`), so an upright JPEG is returned as stored rather
 * than re-encoded. None in an encrypted file (its streams are ciphertext), nor one with a mask, a decode array or CMYK.
 */
function jpegs(bytes: Uint8Array): Map<string, Uint8Array> {
	const s = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
	const out = new Map<string, Uint8Array>();
	if (/\/Encrypt\b/.test(s)) return out;
	for (const m of s.matchAll(/>>\s*stream\r?\n/g)) {
		const head = /(\d+)\s+(\d+)\s+obj\s*<<([\s\S]*)$/.exec(s.slice(Math.max(0, s.lastIndexOf(' obj', m.index) - 24), m.index));
		const dict = head?.[3] ?? '';
		if (!head || !/\/Filter\s*(\/DCTDecode|\[\s*\/DCTDecode\s*\])/.test(dict) || /\/(SMask|Mask|Decode|DeviceCMYK)\b/.test(dict)) continue;
		const start = m.index + m[0].length;
		const end = s.indexOf('endstream', start);
		if (end > start && bytes[start] === 0xff && bytes[start + 1] === 0xd8) out.set(`${head[1]}R${head[2] === '0' ? '' : head[2]}`, bytes.subarray(start, end));
	}
	return out;
}
/** A run of a line's words, a table or a picture, where it stands on the page. */
type Piece = Box & ({ words: Word[] } | { block: Block | null });
const prose = (side: readonly Piece[]) => {
	const segs = side.flatMap((q) => ('words' in q ? [q.words.length] : []));
	return segs.length === 0 || segs.reduce((a, b) => a + b, 0) / segs.length >= 3;
};
/**
 * Reading order by recursive cuts: the widest gap that parts every piece of a region, across it (above, then below)
 * or down it (left, then right). A cut down a region needs prose on both sides, so label and value pairs, forms and
 * figure labels stay on their lines. Each leaf is one region no gap parts.
 */
export function order(pieces: readonly Piece[]): Piece[][] {
	if (pieces.length <= 1) return [[...pieces]];
	let best: { gap: number; parts: [Piece[], Piece[]] } | undefined;
	const byTop = [...pieces].sort((a, b) => b.y1 - a.y1);
	let low = Infinity;
	byTop.forEach((q, i) => {
		const gap = i > 0 ? low - q.y1 : 0;
		if (gap > 0 && gap > (best?.gap ?? 0)) best = { gap, parts: [byTop.slice(0, i), byTop.slice(i)] };
		low = Math.min(low, q.y0);
	});
	const byLeft = [...pieces].sort((a, b) => a.x0 - b.x0);
	let right = -Infinity;
	byLeft.forEach((q, i) => {
		const gap = i > 0 ? q.x0 - right : 0;
		const parts: [Piece[], Piece[]] = [byLeft.slice(0, i), byLeft.slice(i)];
		if (gap > 0 && gap > (best?.gap ?? 0) && prose(parts[0]) && prose(parts[1])) best = { gap, parts };
		right = Math.max(right, q.x1);
	});
	return best ? [...order(best.parts[0]), ...order(best.parts[1])] : [[...pieces]];
}
/** Pictures smaller than this (pixels a side) are rules, bullets and spacers. */
const MIN_PICTURE = 16;

/** The PDF as one section per page: its text, tables and pictures in reading order. */
export const readPdf = Effect.fn('Convert.pdf')(function* (bytes: Uint8Array, images: Images) {
	const doc = yield* open(bytes);
	let stored: Map<string, Uint8Array> | undefined;
	const pages: Page[] = [];
	for (let n = 1; n <= doc.numPages; n++) {
		const page = yield* Effect.tryPromise(() => doc.getPage(n));
		const { view, upright } = shown(page);
		const ops = yield* Effect.tryPromise(() => page.getOperatorList());
		const text = yield* Effect.tryPromise(() => page.getTextContent());
		const fonts = new Map<string, { bold: boolean; italic: boolean }>();
		const style = (id: string) => {
			if (!fonts.has(id)) {
				const font: unknown = page.commonObjs.has(id) ? page.commonObjs.get(id) : undefined;
				const get = (k: string): unknown => (typeof font === 'object' && font !== null && k in font ? Reflect.get(font, k) : undefined);
				const name = String(get('name') ?? '');
				fonts.set(id, {
					bold: get('bold') === true || get('black') === true || /bold|black|heavy|semibold|demi/i.test(name),
					italic: get('italic') === true || /italic|oblique/i.test(name)
				});
			}
			return fonts.get(id)!;
		};
		const words = wordsOf(
			text.items.flatMap((i) => ('str' in i ? [{ str: i.str, transform: i.transform.map(Number), width: i.width, ...style(i.fontName) }] : [])),
			upright
		);
		const rules = rulesOf(ops.fnArray, ops.argsArray, upright);
		const ruled = lattice(rules, words);
		const used = new Set(ruled.flatMap((t) => t.words));
		const tables = [...ruled, ...stream(words.filter((w) => !used.has(w)), rules.v)];
		const pictures: Picture[] = [];
		for (const p of rules.paints) {
			if (p.width < MIN_PICTURE || p.height < MIN_PICTURE) continue;
			const { m, source } = p;
			const data: unknown =
				typeof source === 'string'
					? yield* Effect.callback<unknown>((resume) => {
							(source.startsWith('g_') ? page.commonObjs : page.objs).get(source, (d: unknown) => resume(Effect.succeed(d)));
						}).pipe(Effect.timeoutOption(5000), Effect.map(Option.getOrUndefined))
					: source;
			const pixels = pixelsOf(data);
			if (!pixels) continue;
			const upright = Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6 && m[0] > 0 && m[3] > 0;
			const jpeg = upright && typeof pixels.ref === 'string' ? (stored ??= jpegs(bytes)).get(pixels.ref) : undefined;
			// Columns run along the paint's x vector, rows against its y vector; the shown page's y runs down.
			const src = jpeg
				? images.add(jpeg, 'image/jpeg')
				: images.add(encode(upright ? pixels : orient(pixels, [m[0], -m[1]], [-m[2], m[3]]).pixels), 'image/png');
			const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
			const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
			pictures.push({ box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }, block: { t: 'img', src, alt: '' } });
		}
		page.cleanup();
		pages.push({ n, view, words, tables, pictures });
	}
	const placed = continued(pages);
	const free = pages.map((p) => {
		const inTable = new Set(p.tables.flatMap((t) => t.words));
		return p.words.filter((w) => !inTable.has(w));
	});
	// The body is the size prose is set in: lines of a few words or more (labels and figures are shorter).
	const sample = free.flatMap((ws) => linesOf(ws).filter((l) => l.length >= 6).flat());
	const body = bodySize(sample.length > 0 ? sample : free.flat());
	const levels = [
		...new Set(
			free.flatMap((ws) => linesOf(ws).filter((l) => joined(l).length <= HEADING_CHARS).flatMap((l) => l.filter((w) => w.size >= body * 1.15).map((w) => Math.round(w.size * 2) / 2)))
		)
	].sort((a, b) => b - a);
	return pages.map((p, i): Block => {
		// Lines cut where a gutter parts them, so columns can be read one after another.
		const pieces: Piece[] = [
			...linesOf(free[i]!).flatMap((l) => {
				const segs: Word[][] = [];
				l.forEach((w, k) => (k > 0 && w.x0 - l[k - 1]!.x1 <= 1.5 * w.size ? segs.at(-1)!.push(w) : segs.push([w])));
				return segs.map((ws) => ({ ...extent(ws), y0: ws[0]!.y - 0.25 * ws[0]!.size, y1: ws[0]!.y + 0.75 * ws[0]!.size, words: ws }));
			}),
			...placed[i]!.map((t) => ({ ...t.box, block: t.block })),
			...p.pictures.map((q) => ({ ...q.box, block: q.block }))
		];
		const blocks: Block[] = [];
		let lines: Line[] = [];
		const flush = () => {
			blocks.push(...textBlocks(lines, body, levels));
			lines = [];
		};
		for (const leaf of order(pieces)) {
			// A region no gap parts: its text, tables and pictures, top first.
			const parts = [
				...linesOf(leaf.flatMap((q) => ('words' in q ? q.words : []))).map((l) => ({ y: l[0]!.y + l[0]!.size, line: lineOf(l) })),
				...leaf.flatMap((q) => ('block' in q ? [{ y: q.y1, block: q.block }] : []))
			].sort((a, b) => b.y - a.y);
			for (const part of parts)
				if ('line' in part) lines.push(part.line);
				else {
					flush();
					if (part.block) blocks.push(part.block);
				}
		}
		flush();
		return { t: 'section', kind: 'page', n: p.n, blocks };
	});
}, Effect.scoped);
