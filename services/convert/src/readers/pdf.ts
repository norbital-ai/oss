// A PDF from its own structure: MuPDF's trace of each page (trace.ts), never pixels, never a model, never OCR. As shown:
//   text      glyphs → words → lines → headings (size, weight), list items (marker, hanging indent), paragraphs
//   ruled     the rules make a grid; an inner rule missing between two cells merges them (colspan, rowspan); a grid
//             inside another's cell nests in it; a grid ending a page continues on the next when that page opens with
//             a grid of the same columns
//   unruled   ≥ 3 consecutive lines whose gaps line up into ≥ 2 columns of short cells; anything less stays paragraphs
//   pictures  in reading order, from Poppler: a JPEG as stored, anything else a PNG, a turned one rendered as shown
// Every word lands once: in one table cell or in one line of text.
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { escape, inline, type Block, type Cell, type Images } from '../blocks.ts';
import { scratch, tool } from './tools.ts';
import { tracePages, type H, type Paint, type Traced, type V, type Word } from './trace.ts';

/** PDF user space, y up. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

const TOL = 2;

// ---------- text ----------
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
/** Processes one file is traced across, and the fewest pages worth a process of their own. */
const READERS = Math.min(availableParallelism(), 8);
const RANGE_PAGES = 64;
/** A page's size in points, its 72 dpi. */
const POINTS = 72;

/** Page ranges a file is read across, each by its own process. */
const rangesOf = (pages: number) => {
	const ranges = Math.max(1, Math.min(READERS, Math.ceil(pages / RANGE_PAGES))),
		size = Math.ceil(pages / ranges);
	return Array.from({ length: ranges }, (_, i) => [i * size + 1, Math.min(pages, (i + 1) * size)] as const);
};
const pageCount = (path: string) =>
	Effect.map(tool('pdfinfo', [path]), (info) => Number(/^Pages:\s+(\d+)/m.exec(info.toString('utf8'))?.[1] ?? 0));
type Stored = { page: number; width: number; height: number; object: string; file: string };
/** The pictures of pages `first` to `last` as Poppler wrote them out, in painting order. */
const stored = (path: string, first: number, last: number) =>
	Effect.gen(function* () {
		const dir = yield* scratch,
			range = ['-f', `${first}`, '-l', `${last}`];
		yield* tool('pdfimages', ['-png', '-j', ...range, path, join(dir, 'p')]);
		const files = new Map(
			(yield* Effect.tryPromise(() => readdir(dir))).map((name) => [Number(/-(\d+)\./.exec(name)?.[1]), name])
		);
		const list = (yield* tool('pdfimages', ['-list', ...range, path])).toString('utf8').split('\n').slice(2);
		return list.flatMap((row): Stored[] => {
			const [page, num, type, width, height, , , , , , object] = row.trim().split(/\s+/),
				file = files.get(Number(num));
			return type === 'image' && file !== undefined
				? [{ page: Number(page), width: Number(width), height: Number(height), object: object ?? '0', file: join(dir, file) }]
				: [];
		});
	});
const box = ({ m }: Paint): Box => {
	const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = m,
		xs = [e, a + e, c + e, a + c + e],
		ys = [f, b + f, d + f, b + d + f];
	return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
/** A picture turned on its page, as the page shows it, at its own resolution. */
const rendered = (path: string, page: Pictured, paint: Paint, at: Box) => {
	const longest = Math.max(paint.width, paint.height) / Math.max(at.x1 - at.x0, at.y1 - at.y0),
		dpi = Math.max(36, Math.round(longest * POINTS)),
		scale = dpi / POINTS;
	return tool('pdftoppm', [
		'-f', `${page.n}`,
		'-l', `${page.n}`,
		'-r', `${dpi}`,
		'-png',
		'-singlefile',
		'-x', `${Math.round(at.x0 * scale)}`,
		'-y', `${Math.round((page.height - at.y1) * scale)}`,
		'-W', `${Math.round((at.x1 - at.x0) * scale)}`,
		'-H', `${Math.round((at.y1 - at.y0) * scale)}`,
		path
	]);
};
/** What a page's pictures need of it, once its words are gone. */
type Pictured = Pick<Traced, 'n' | 'height' | 'paints'>;
type Planned = { page: Pictured; paint: Paint; at: Box; file: Stored; upright: boolean };
/**
 * The pictures to return, in page order. A paint Poppler does not list is no picture of the page's: it is a tile of a
 * pattern fill.
 */
const planned = (pages: readonly Pictured[], files: readonly Stored[]) => {
	const byPage = new Map<number, Stored[]>();
	for (const file of files) byPage.set(file.page, [...(byPage.get(file.page) ?? []), file]);
	return pages.flatMap((page) => {
		const left = byPage.get(page.n) ?? [];
		return page.paints.flatMap((paint): Planned[] => {
			const found = left.findIndex((f) => f.width === paint.width && f.height === paint.height);
			if (found === -1) return [];
			const [file] = left.splice(found, 1),
				[a = 0, b = 0, c = 0, d = 0] = paint.m;
			return file === undefined || paint.width < MIN_PICTURE || paint.height < MIN_PICTURE
				? []
				: [{ page, paint, at: box(paint), file, upright: Math.abs(b) < 1e-6 && Math.abs(c) < 1e-6 && a > 0 && d < 0 }];
		});
	});
};

export const readPdf = Effect.fn('Convert.pdf')(function* (path: string, images: Images, pictures: boolean) {
	const count = yield* pageCount(path),
		pictured: Pictured[] = [],
		found: Page[] = [];
	yield* Effect.forEach(
		rangesOf(count),
		([first, last]) =>
			tracePages(path, first, last, (page) => {
				// a page's words become its tables as it ends; its glyphs are gone by then
				const ruled = lattice(page, page.words),
					used = new Set(ruled.flatMap((t) => t.words));
				found[page.n - 1] = {
					n: page.n,
					view: { x0: 0, y0: 0, x1: page.width, y1: page.height },
					words: page.words,
					tables: [...ruled, ...stream(page.words.filter((w) => !used.has(w)), page.v)],
					pictures: []
				};
				if (pictures && page.paints.length > 0)
					pictured.push({ n: page.n, height: page.height, paints: page.paints });
			}),
		{ concurrency: 'unbounded' }
	);
	if (pictured.length > 0) {
		const files = yield* Effect.forEach(rangesOf(count), ([first, last]) => stored(path, first, last), {
				concurrency: 'unbounded'
			}),
			plans = planned(pictured.sort((a, b) => a.n - b.n), files.flat());
		const bytes = yield* Effect.forEach(
			plans,
			(plan) =>
				plan.upright
					? Effect.tryPromise(() => readFile(plan.file.file))
					: rendered(path, plan.page, plan.paint, plan.at),
			{ concurrency: READERS }
		);
		// a logo on every page is one picture: one object of the file, its bytes returned once
		const added = new Map<string, string>();
		plans.forEach((plan, i) => {
			const key = `${plan.file.object}|${plan.upright}`,
				mime = plan.upright && plan.file.file.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
				src = (plan.file.object !== '0' && added.get(key)) || images.add(bytes[i] ?? new Uint8Array(), mime);
			added.set(key, src);
			(found[plan.page.n - 1] as Page).pictures.push({ box: plan.at, block: { t: 'img', src, alt: '' } });
		});
	}
	const pages = found.filter((p) => p !== undefined);
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
		return {
			t: 'section',
			kind: 'page',
			n: p.n,
			blocks: p.words.length + p.pictures.length === 0 ? [{ t: 'p', html: 'No text on this page.' }] : blocks
		};
	});
}, Effect.scoped);
