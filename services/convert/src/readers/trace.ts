// A PDF page's primitives from MuPDF's own device trace, read as it streams: every glyph where it stands, the straight
// strokes and thin bars that rule tables, and where each picture is painted. `mutool trace` is the page as shown: /Rotate
// and every matrix applied, y running down.
import { spawn } from 'node:child_process';
import { Effect } from 'effect';

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
export type H = { y: number; x0: number; x1: number };
export type V = { x: number; y0: number; y1: number };
/** Where a picture is painted on the shown page (y up): its pixels' size, and the matrix taking its unit square there. */
export type Paint = { width: number; height: number; m: readonly number[] };
export type Traced = { n: number; width: number; height: number; words: Word[]; h: H[]; v: V[]; paints: Paint[] };

const SPACE = 32;
const NEWLINE = 10;
/** A gap past this share of the size parts two glyphs of one run into two words. */
const WORD_GAP = 0.25;
const BOLD = /bold|black|heavy|semibold|demi/i;
const ITALIC = /italic|oblique/i;

/** The value of `name="…"`; '' when the line has none. */
const attr = (line: string, name: string) => {
	const key = `${name}="`,
		at = line.indexOf(key);
	return at === -1 ? '' : line.slice(at + key.length, line.indexOf('"', at + key.length));
};
const numbers = (text: string) => text.split(' ').map(Number);
const CHARACTER = /^&(?:#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));$/;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unicode = (value: string) => {
	if (value.length < 3) return value;
	const m = CHARACTER.exec(value);
	if (m === null) return value;
	return m[1] === undefined ? (NAMED[m[2] ?? ''] ?? '') : String.fromCodePoint(parseInt(m[1], 16));
};

/** One page being read. */
class Page {
	readonly words: Word[] = [];
	readonly h: H[] = [];
	readonly v: V[] = [];
	readonly paints: Paint[] = [];
	readonly drawn = new Set<string>();
	// the text run: its matrix, the span's size, slant and weight, and the word it is building
	t = [1, 0, 0, 1, 0, 0];
	size = 1;
	adv = 1;
	bold = false;
	italic = false;
	rotated = false;
	word: Word | undefined;
	spaces = 0;
	// the path: its matrix, whether it strokes, and the subpath's start, pen and box
	stroke = false;
	sx = 0;
	sy = 0;
	px = 0;
	py = 0;
	x0 = 0;
	y0 = 0;
	x1 = 0;
	y1 = 0;
	points = 0;
	readonly n: number;
	readonly width: number;
	readonly height: number;
	constructor(n: number, width: number, height: number) {
		this.n = n;
		this.width = width;
		this.height = height;
	}
	private flush() {
		const w = this.word;
		this.word = undefined;
		if (w === undefined) return;
		// a word laid over itself (filled then stroked, or struck twice to look bold) lands once
		const key = `${w.text}|${Math.round(w.x0)}|${Math.round(w.y)}`;
		if (this.drawn.has(key)) return;
		this.drawn.add(key);
		this.words.push(w);
	}
	text(line: string) {
		this.t = numbers(attr(line, 'transform'));
	}
	span(line: string) {
		this.flush();
		const [a = 1, b = 0, c = 0, d = 1] = numbers(attr(line, 'trm')),
			[ta = 1, tb = 0, tc = 0, td = 1] = this.t,
			font = attr(line, 'font');
		const ma = a * ta + b * tc,
			mb = a * tb + b * td,
			mc = c * ta + d * tc,
			md = c * tb + d * td;
		this.size = Math.hypot(mc, md) || Math.hypot(ma, mb) || 1;
		this.adv = ma;
		this.rotated = Math.abs(mb) > 0.01 || Math.abs(mc) > 0.01;
		this.bold = BOLD.test(font);
		this.italic = ITALIC.test(font);
		this.spaces = 0;
	}
	glyph(line: string) {
		const ch = unicode(attr(line, 'unicode'));
		// a glyph mapped to no character is a gap on the page, never a character of the word
		if (ch === ' ' || ch === '\u00a0' || ch === '' || ch === '\ufffd') {
			this.flush();
			this.spaces++;
			return;
		}
		const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = this.t,
			gx = Number(attr(line, 'x')),
			gy = Number(attr(line, 'y')),
			x = a * gx + c * gy + e,
			y = this.height - (b * gx + d * gy + f),
			adv = Number(attr(line, 'adv')) * this.adv,
			w = this.word;
		if (w !== undefined && !this.rotated && Math.abs(x - w.x1) > WORD_GAP * this.size) this.flush();
		if (this.word === undefined)
			this.word = {
				text: ch,
				x0: x,
				x1: this.rotated ? x : x + adv,
				y,
				size: this.size,
				split: this.spaces >= 2,
				rotated: this.rotated,
				bold: this.bold,
				italic: this.italic
			};
		else {
			this.word.text += ch;
			if (!this.rotated) this.word.x1 = x + adv;
		}
		this.spaces = 0;
	}
	endText() {
		this.flush();
	}
	path(line: string, stroke: boolean) {
		this.t = numbers(attr(line, 'transform'));
		this.stroke = stroke;
		this.points = 0;
	}
	private at(line: string, xName: string, yName: string): [number, number] {
		const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = this.t,
			x = Number(attr(line, xName)),
			y = Number(attr(line, yName));
		return [a * x + c * y + e, this.height - (b * x + d * y + f)];
	}
	private rule(ax: number, ay: number, bx: number, by: number) {
		if (Math.abs(ay - by) <= 0.5 && Math.abs(ax - bx) > 1)
			this.h.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
		else if (Math.abs(ax - bx) <= 0.5 && Math.abs(ay - by) > 1)
			this.v.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
	}
	/** A thin filled bar is a rule; a wider fill is shading. */
	private bar() {
		if (this.stroke || this.points < 2) return;
		const { x0, x1, y0, y1 } = this;
		if (y1 - y0 <= 2.5 && x1 - x0 > y1 - y0) this.rule(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
		else if (x1 - x0 <= 2.5 && y1 - y0 > x1 - x0) this.rule((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
	}
	moveto(line: string) {
		this.bar();
		const [x, y] = this.at(line, 'x', 'y');
		this.sx = this.px = this.x0 = this.x1 = x;
		this.sy = this.py = this.y0 = this.y1 = y;
		this.points = 1;
	}
	private to(x: number, y: number) {
		if (this.stroke) this.rule(this.px, this.py, x, y);
		this.px = x;
		this.py = y;
		this.x0 = Math.min(this.x0, x);
		this.x1 = Math.max(this.x1, x);
		this.y0 = Math.min(this.y0, y);
		this.y1 = Math.max(this.y1, y);
		this.points++;
	}
	lineto(line: string) {
		const [x, y] = this.at(line, 'x', 'y');
		this.to(x, y);
	}
	/** A curve rules nothing, and a filled shape with one is no bar. */
	curveto(line: string, xName: string, yName: string) {
		const [x, y] = this.at(line, xName, yName);
		this.px = x;
		this.py = y;
		this.points = 0;
	}
	close() {
		this.to(this.sx, this.sy);
	}
	endPath() {
		this.bar();
		this.points = 0;
	}
	image(line: string) {
		const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = numbers(attr(line, 'transform'));
		this.paints.push({
			width: Number(attr(line, 'width')),
			height: Number(attr(line, 'height')),
			// y flipped onto the shown page: the unit square's corners are what matter
			m: [a, -b, c, -d, e, this.height - f]
		});
	}
}

/** One line of the trace, its indent gone. */
const handle = (line: string, page: Page | undefined, begin: (p: Page) => void, end: () => void) => {
	if (line.startsWith('<g ')) page?.glyph(line);
	else if (line.startsWith('<lineto')) page?.lineto(line);
	else if (line.startsWith('<moveto')) page?.moveto(line);
	else if (line.startsWith('<closepath')) page?.close();
	else if (line.startsWith('<curveto')) page?.curveto(line, 'x3', 'y3');
	else if (line.startsWith('<quadto')) page?.curveto(line, 'x2', 'y2');
	else if (line.startsWith('<span')) page?.span(line);
	else if (/^<(fill|stroke|clip|clip_stroke|ignore)_text/.test(line)) page?.text(line);
	else if (/^<\/(fill|stroke|clip|clip_stroke|ignore)_text/.test(line)) page?.endText();
	else if (line.startsWith('<fill_path')) page?.path(line, false);
	else if (line.startsWith('<stroke_path')) page?.path(line, true);
	else if (line.startsWith('</fill_path') || line.startsWith('</stroke_path')) page?.endPath();
	else if (line.startsWith('<fill_image ')) page?.image(line);
	else if (line.startsWith('<page ')) {
		const [, , width = 0, height = 0] = numbers(attr(line, 'mediabox'));
		begin(new Page(Number(attr(line, 'number')), width, height));
	} else if (line.startsWith('</page')) end();
};
/** Pages `first` to `last` of `path`, each handed over as it ends, so a long file is held a page at a time. */
export const tracePages = (path: string, first: number, last: number, each: (page: Traced) => void) =>
	Effect.callback<void, Error>((resume, signal) => {
		const child = spawn('mutool', ['trace', path, `${first}-${last}`], { stdio: ['ignore', 'pipe', 'ignore'], signal });
		let page: Page | undefined,
			rest: Buffer | undefined;
		const begin = (p: Page) => {
			page = p;
		};
		const end = () => {
			if (page !== undefined) each(page);
			page = undefined;
		};
		child.stdout.on('data', (chunk: Buffer) => {
			const data = rest === undefined ? chunk : Buffer.concat([rest, chunk]);
			let start = 0;
			for (let at = data.indexOf(NEWLINE, start); at !== -1; at = data.indexOf(NEWLINE, start)) {
				let from = start;
				while (from < at && data[from] === SPACE) from++;
				if (at > from) handle(data.toString('utf8', from, at), page, begin, end);
				start = at + 1;
			}
			rest = start < data.length ? data.subarray(start) : undefined;
		});
		child.on('error', (error) => resume(Effect.fail(error)));
		child.on('close', (code) =>
			resume(code === 0 ? Effect.void : Effect.fail(new Error(`mutool trace ended with ${code}`)))
		);
	});
