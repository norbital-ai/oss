// OOXML (docx, xlsx, pptx) and ODF (odt, ods, odp) read straight from their XML into ingest blocks, so merged cells
// (colspan, rowspan) and nested tables survive; xlsx and ods are typed JSON, not HTML. Legacy binaries and rtf go through Kreuzberg
// (ingest.ts), PDF through pdf.js (pdf.ts).
import { inflateRawSync } from 'node:zlib';
import { escape, inline, type Block, type Cell, type Images } from './blocks.ts';
import { serialDate, sheet, type Anchor, type Merge, type Sheets, type Value } from './sheets.ts';

/** A zip bomb stops here, whatever size the entry declares. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export function unzip(zip: Uint8Array): Map<string, () => Buffer> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) throw new Error('the file is not a zip package');
	const entries = new Map<string, () => Buffer>();
	for (let at = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); n > 0; n--) {
		const method = v.getUint16(at + 10, true),
			size = v.getUint32(at + 20, true),
			nameLen = v.getUint16(at + 28, true),
			local = v.getUint32(at + 42, true);
		const name = Buffer.from(zip.subarray(at + 46, at + 46 + nameLen)).toString('utf8');
		at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
		entries.set(name, () => {
			const data = zip
				.subarray(local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true))
				.subarray(0, size);
			return method === 0
				? Buffer.from(data)
				: inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
		});
	}
	return entries;
}

/** An XML element by local name (prefixes dropped from element and attribute names). */
export type X = { name: string; attrs: Record<string, string>; kids: (X | string)[] };
const ENTITY: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unxml = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
		e[0] === '#'
			? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
			: (ENTITY[e] ?? all)
	);
const local = (n: string) => n.slice(n.indexOf(':') + 1);
export function xml(s: string): X {
	const root: X = { name: '#root', attrs: {}, kids: [] };
	const stack = [root];
	const re =
		/<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	for (const m of s.matchAll(re)) {
		const top = stack.at(-1)!;
		if (m[1] !== undefined) top.kids.push(m[1]);
		else if (m[6] !== undefined) top.kids.push(unxml(m[6]));
		else if (m[3] !== undefined) {
			if (m[2] === '/') {
				if (stack.length > 1) stack.pop();
				continue;
			}
			const attrs: Record<string, string> = {};
			for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
				attrs[local(a[1]!)] = unxml(a[2] ?? a[3] ?? '');
			const el: X = { name: local(m[3]), attrs, kids: [] };
			top.kids.push(el);
			if (m[5] !== '/') stack.push(el);
		}
	}
	return root;
}
const els = (x: X) => x.kids.filter((k): k is X => typeof k !== 'string');
const child = (x: X, name: string) => els(x).find((k) => k.name === name);
const kids = (x: X, name: string) => els(x).filter((k) => k.name === name);
function* walk(x: X): Generator<X> {
	for (const k of els(x)) {
		yield k;
		yield* walk(k);
	}
}
const find = (x: X, name: string) => {
	for (const k of walk(x)) if (k.name === name) return k;
	return undefined;
};
const text = (x: X): string => x.kids.map((k) => (typeof k === 'string' ? k : text(k))).join('');
const int = (s: string | undefined, d = 1) => {
	const n = Number(s);
	return Number.isInteger(n) && n > 0 ? Math.min(n, 1000) : d;
};
const posix = (base: string, rel: string) => {
	const parts = rel.startsWith('/') ? [] : base.split('/').slice(0, -1);
	for (const p of rel.replace(/^\//, '').split('/'))
		if (p === '..') parts.pop();
		else if (p !== '.') parts.push(p);
	return parts.join('/');
};
const IMAGE: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp'
};
/** A package image as an `<img>` block; emf, wmf, tiff and the like have no browser pixels and are skipped. */
function picture(zip: Map<string, () => Buffer>, path: string, images: Images, alt = ''): Block[] {
	const mime = IMAGE[path.split('.').pop()?.toLowerCase() ?? ''];
	const read = zip.get(path);
	return mime && read ? [{ t: 'img', src: images.add(read(), mime), alt }] : [];
}
/** Relationship id → package path, for the part at `part`. */
function rels(zip: Map<string, () => Buffer>, part: string): Map<string, string> {
	const file = posix(part, `_rels/${part.split('/').pop()}.rels`);
	const read = zip.get(file);
	const out = new Map<string, string>();
	if (read)
		for (const r of walk(xml(read().toString('utf8'))))
			if (r.name === 'Relationship' && r.attrs['TargetMode'] !== 'External')
				out.set(r.attrs['Id'] ?? '', posix(part, r.attrs['Target'] ?? ''));
	return out;
}
const part = (zip: Map<string, () => Buffer>, name: string) => {
	const read = zip.get(name);
	if (!read) throw new Error(`the package has no ${name}`);
	return xml(read().toString('utf8'));
};
const truthy = (x: X | undefined) =>
	x !== undefined && !['0', 'false', 'off', 'none'].includes(x.attrs['val'] ?? '');
/** Collapses runs of paragraphs that are list items into lists. */
function lists(blocks: (Block | { t: 'li'; ordered: boolean; block: Block })[]): Block[] {
	const out: Block[] = [];
	for (const b of blocks) {
		if (b.t !== 'li') {
			out.push(b);
			continue;
		}
		const last = out.at(-1);
		if (last?.t === 'list' && last.ordered === b.ordered) last.items.push([b.block]);
		else out.push({ t: 'list', ordered: b.ordered, items: [[b.block]] });
	}
	return out;
}

// ---------- docx ----------
export function docx(bytes: Uint8Array, images: Images): Block[] {
	const zip = unzip(bytes);
	const doc = part(zip, 'word/document.xml');
	const rel = rels(zip, 'word/document.xml');
	const numbering = zip.has('word/numbering.xml') ? part(zip, 'word/numbering.xml') : undefined;
	const ordered = (numId: string, ilvl: string) => {
		if (!numbering) return false;
		const num = kids(numbering, 'numbering')
			.flatMap((n) => kids(n, 'num'))
			.find((n) => n.attrs['numId'] === numId);
		const abs = num && child(num, 'abstractNumId')?.attrs['val'];
		const def = [...walk(numbering)].find((n) => n.name === 'abstractNum' && n.attrs['abstractNumId'] === abs);
		const lvl = def && kids(def, 'lvl').find((l) => (l.attrs['ilvl'] ?? '0') === ilvl);
		const fmt = lvl && child(lvl, 'numFmt')?.attrs['val'];
		return fmt !== undefined && fmt !== 'bullet' && fmt !== 'none';
	};
	const runs = (p: X, pics: Block[]): string => {
		let html = '';
		for (const k of els(p)) {
			if (k.name === 'r') {
				const pr = child(k, 'rPr');
				let s = '';
				for (const r of els(k)) {
					if (r.name === 't') s += escape(text(r));
					else if (r.name === 'tab') s += ' ';
					else if (r.name === 'br' || r.name === 'cr') s += '<br>';
					else if (r.name === 'drawing' || r.name === 'pict')
						for (const blip of walk(r))
							if (blip.name === 'blip' || blip.name === 'imagedata') {
								const target = rel.get(blip.attrs['embed'] ?? blip.attrs['id'] ?? '');
								if (target) pics.push(...picture(zip, target, images, ''));
							}
				}
				html += inline(s, { strong: truthy(pr && child(pr, 'b')), em: truthy(pr && child(pr, 'i')) });
			} else if (['hyperlink', 'ins', 'smartTag', 'fldSimple', 'sdt', 'sdtContent'].includes(k.name))
				html += runs(k, pics);
		}
		return html;
	};
	const body = (x: X): Block[] => {
		const out: (Block | { t: 'li'; ordered: boolean; block: Block })[] = [];
		for (const k of els(x)) {
			if (k.name === 'p') {
				const pics: Block[] = [];
				const html = runs(k, pics).trim();
				const pr = child(k, 'pPr');
				const style = (pr && child(pr, 'pStyle')?.attrs['val']) ?? '';
				const heading = /^heading\s?([1-6])$/i.exec(style)?.[1] ?? (/^title$/i.test(style) ? '1' : undefined);
				const num = pr && child(pr, 'numPr');
				if (html) {
					if (heading) out.push({ t: 'h', level: Number(heading), html });
					else if (num)
						out.push({
							t: 'li',
							ordered: ordered(child(num, 'numId')?.attrs['val'] ?? '', child(num, 'ilvl')?.attrs['val'] ?? '0'),
							block: { t: 'p', html }
						});
					else out.push({ t: 'p', html });
				}
				out.push(...pics);
			} else if (k.name === 'tbl') out.push(docxTable(k));
			else if (k.name === 'sdt' || k.name === 'sdtContent' || k.name === 'customXml') out.push(...body(k));
		}
		return lists(out);
	};
	const docxTable = (tbl: X): Block => {
		const rows: Cell[][] = [];
		/** grid column → the cell a vertical merge continues */
		const open = new Map<number, Cell>();
		for (const tr of kids(tbl, 'tr')) {
			const row: Cell[] = [];
			let col = 0;
			for (const tc of kids(tr, 'tc')) {
				const pr = child(tc, 'tcPr');
				const span = int(pr && child(pr, 'gridSpan')?.attrs['val']);
				const vm = pr && child(pr, 'vMerge');
				if (vm && vm.attrs['val'] !== 'restart' && open.has(col)) {
					open.get(col)!.rowspan++;
				} else {
					const cell: Cell = { header: false, colspan: span, rowspan: 1, blocks: body(tc) };
					row.push(cell);
					if (vm) open.set(col, cell);
					else open.delete(col);
				}
				col += span;
			}
			rows.push(row);
		}
		return { t: 'table', rows };
	};
	const b = child(find(doc, 'document') ?? doc, 'body') ?? doc;
	return body(b);
}

// ---------- xlsx ----------
const cellRef = (ref: string) => {
	const m = /^([A-Z]+)(\d+)$/.exec(ref);
	if (!m) return undefined;
	let c = 0;
	for (const ch of m[1]!) c = c * 26 + ch.charCodeAt(0) - 64;
	return { r: Number(m[2]) - 1, c: c - 1 };
};
/** Excel's built-in date and time formats; a custom one is a date when it spells y, m, d, h or s outside quotes. */
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const dateCode = (code: string) => /[ymdhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ''));
/**
 * Each sheet's typed cells (numbers, booleans, dates as ISO, formulas' cached values), merges, and the pictures its
 * drawing anchors at a cell.
 */
export function xlsx(bytes: Uint8Array, images: Images): Sheets {
	const zip = unzip(bytes);
	const book = part(zip, 'xl/workbook.xml');
	const rel = rels(zip, 'xl/workbook.xml');
	const shared = zip.has('xl/sharedStrings.xml')
		? kids(find(part(zip, 'xl/sharedStrings.xml'), 'sst') ?? { name: '', attrs: {}, kids: [] }, 'si').map((si) =>
				[...walk(si)].filter((t) => t.name === 't' && !isPhonetic(si, t)).map(text).join('')
			)
		: [];
	const styles = zip.has('xl/styles.xml') ? part(zip, 'xl/styles.xml') : undefined;
	const codes = new Map([...(styles ? walk(styles) : [])].filter((n) => n.name === 'numFmt').map((n) => [Number(n.attrs['numFmtId']), n.attrs['formatCode'] ?? '']));
	const xfs = styles ? kids(find(styles, 'cellXfs') ?? styles, 'xf').map((x) => Number(x.attrs['numFmtId'] ?? 0)) : [];
	const isDate = (style: string | undefined) => {
		const id = xfs[Number(style ?? 0)] ?? 0;
		return DATE_IDS.has(id) || dateCode(codes.get(id) ?? '');
	};
	const pr = find(book, 'workbookPr');
	const date1904 = ['1', 'true'].includes(pr?.attrs['date1904'] ?? '');
	const sheets = [...walk(book)].filter((s) => s.name === 'sheet');
	return {
		sheets: sheets.map((s, i) => {
		const path = rel.get(s.attrs['id'] ?? '') ?? `xl/worksheets/sheet${i + 1}.xml`;
		const ws = part(zip, path);
		const cells: Value[][] = [];
		for (const c of walk(ws)) {
			if (c.name !== 'c') continue;
			const at = cellRef(c.attrs['r'] ?? '');
			if (!at) continue;
			const type = c.attrs['t'];
			const v = child(c, 'v');
			const raw = v ? text(v) : '';
			const date = (type === undefined || type === 'n') && raw !== '' && Number.isFinite(Number(raw)) && isDate(c.attrs['s']);
			const value: Value =
				type === 's'
					? (shared[Number(raw)] ?? '')
					: type === 'inlineStr'
						? text(child(c, 'is') ?? c)
						: type === 'b'
							? raw === '1'
							: type === 'e' || type === 'str' || type === 'd'
								? raw
								: raw === '' || !Number.isFinite(Number(raw))
									? null
									: date
										? serialDate(Number(raw), date1904)
										: Number(raw);
			if (value === null || value === '') continue;
			(cells[at.r] ??= [])[at.c] = value;
		}
		const merges = [...walk(ws)]
			.filter((m) => m.name === 'mergeCell')
			.flatMap((m) => {
				const [a, b] = (m.attrs['ref'] ?? '').split(':').map(cellRef);
				return a && b ? [{ row: a.r, col: a.c, rows: b.r - a.r + 1, cols: b.c - a.c + 1 }] : [];
			});
		const drawing = child(ws, 'drawing') ?? find(ws, 'drawing');
		const drawn = drawing && rels(zip, path).get(drawing.attrs['id'] ?? '');
		const anchors: Anchor[] = [];
		if (drawn && zip.has(drawn)) {
			const media = rels(zip, drawn);
			for (const a of walk(part(zip, drawn))) {
				if (a.name !== 'twoCellAnchor' && a.name !== 'oneCellAnchor') continue;
				const from = child(a, 'from');
				const blip = find(a, 'blip');
				const target = blip && media.get(blip.attrs['embed'] ?? '');
				const mime = target && IMAGE[target.split('.').pop()?.toLowerCase() ?? ''];
				const read = target && zip.get(target);
				if (from && mime && read)
					anchors.push({ name: images.add(read(), mime), row: Number(text(child(from, 'row') ?? from)), col: Number(text(child(from, 'col') ?? from)) });
			}
		}
		const grid = Array.from(cells, (r) => Array.from(r ?? [], (x) => x ?? null));
		return sheet(s.attrs['name'] ?? `Sheet ${i + 1}`, grid, merges, anchors);
		})
	};
}
const isPhonetic = (si: X, t: X) => kids(si, 'rPh').some((ph) => [...walk(ph)].includes(t));

// ---------- pptx ----------
export function pptx(bytes: Uint8Array, images: Images): Block[] {
	const zip = unzip(bytes);
	const pres = part(zip, 'ppt/presentation.xml');
	const rel = rels(zip, 'ppt/presentation.xml');
	const ids = [...walk(pres)].filter((s) => s.name === 'sldId').map((s) => rel.get(s.attrs['id'] ?? ''));
	return ids.flatMap((path, i): Block[] => {
		if (!path) return [];
		const slide = part(zip, path);
		const srel = rels(zip, path);
		const paras = (body: X): Block[] =>
			kids(body, 'p').flatMap((p): Block[] => {
				let html = '';
				for (const r of els(p))
					if (r.name === 'r' || r.name === 'fld') {
						const pr = child(r, 'rPr');
						html += inline(escape(text(child(r, 't') ?? r)), {
							strong: pr?.attrs['b'] === '1',
							em: pr?.attrs['i'] === '1'
						});
					} else if (r.name === 'br') html += '<br>';
				html = html.trim();
				return html ? [{ t: 'p', html }] : [];
			});
		const shapes = (tree: X): Block[] =>
			els(tree).flatMap((k): Block[] => {
				if (k.name === 'sp') {
					const body = child(k, 'txBody');
					if (!body) return [];
					const ph = find(k, 'ph')?.attrs['type'];
					const blocks = paras(body);
					return ph === 'title' || ph === 'ctrTitle'
						? blocks.map((b) => (b.t === 'p' ? { t: 'h', level: 2, html: b.html } : b))
						: blocks;
				}
				if (k.name === 'grpSp') return shapes(k);
				if (k.name === 'pic') {
					const blip = find(k, 'blip');
					const target = blip && srel.get(blip.attrs['embed'] ?? '');
					return target ? picture(zip, target, images, find(k, 'cNvPr')?.attrs['descr'] ?? '') : [];
				}
				if (k.name === 'graphicFrame') {
					const tbl = find(k, 'tbl');
					if (!tbl) return [];
					return [
						{
							t: 'table',
							rows: kids(tbl, 'tr').map((tr) =>
								kids(tr, 'tc')
									.filter((tc) => tc.attrs['hMerge'] !== '1' && tc.attrs['vMerge'] !== '1')
									.map((tc) => ({
										header: false,
										colspan: int(tc.attrs['gridSpan']),
										rowspan: int(tc.attrs['rowSpan']),
										blocks: paras(child(tc, 'txBody') ?? tc)
									}))
							)
						}
					];
				}
				return [];
			});
		return [{ t: 'section', kind: 'slide', n: i + 1, blocks: shapes(find(slide, 'spTree') ?? slide) }];
	});
}

// ---------- odt, ods, odp ----------
/** An ODF cell or row is "repeated" n times; trailing empty repeats (a sheet's million blank rows) are dropped. */
export function odf(bytes: Uint8Array, images: Images): Block[] {
	const zip = unzip(bytes);
	const content = part(zip, 'content.xml');
	const spans = (x: X): string =>
		x.kids
			.map((k) => {
				if (typeof k === 'string') return escape(k);
				if (k.name === 's') return ' '.repeat(int(k.attrs['c']));
				if (k.name === 'tab') return ' ';
				if (k.name === 'line-break') return '<br>';
				if (['span', 'a', 'bookmark-ref', 'reference-ref', 'date', 'time', 'page-number'].includes(k.name))
					return spans(k);
				return '';
			})
			.join('');
	const table = (t: X): Block => {
		const rows: Cell[][] = [];
		let pendingRows: Cell[][] = [];
		const rowEls = [...rowsOf(t)];
		for (const tr of rowEls) {
			const row: Cell[] = [];
			let pending: Cell[] = [];
			for (const tc of els(tr)) {
				if (tc.name !== 'table-cell' && tc.name !== 'covered-table-cell') continue;
				const reps = int(tc.attrs['number-columns-repeated']);
				if (tc.name === 'covered-table-cell') continue;
				const blocks = flow(tc);
				const make = (): Cell => ({
					header: false,
					colspan: int(tc.attrs['number-columns-spanned']),
					rowspan: int(tc.attrs['number-rows-spanned']),
					blocks
				});
				if (blocks.length === 0 && make().colspan === 1 && make().rowspan === 1) {
					for (let i = 0; i < Math.min(reps, 1024); i++) pending.push(make());
					continue;
				}
				row.push(...pending);
				pending = [];
				for (let i = 0; i < reps; i++) row.push(make());
			}
			const reps = int(tr.attrs['number-rows-repeated']);
			if (row.length === 0) {
				for (let i = 0; i < Math.min(reps, 1024); i++) pendingRows.push([]);
				continue;
			}
			rows.push(...pendingRows);
			pendingRows = [];
			for (let i = 0; i < reps; i++) rows.push(row);
		}
		return { t: 'table', rows };
	};
	const flow = (x: X): Block[] => {
		const out: Block[] = [];
		for (const k of els(x)) {
			if (k.name === 'h') {
				const html = spans(k).trim();
				if (html) out.push({ t: 'h', level: Math.min(int(k.attrs['outline-level']), 6), html });
			} else if (k.name === 'p') {
				const html = spans(k).trim();
				if (html) out.push({ t: 'p', html });
				for (const f of kids(k, 'frame')) out.push(...flow({ name: 'frame', attrs: {}, kids: [f] }));
			} else if (k.name === 'list') {
				const items = kids(k, 'list-item')
					.map(flow)
					.filter((b) => b.length > 0);
				if (items.length) out.push({ t: 'list', ordered: false, items });
			} else if (k.name === 'table') out.push(table(k));
			else if (k.name === 'frame') {
				const img = child(k, 'image');
				const href = img?.attrs['href'];
				if (href && !/^[a-z]+:/i.test(href)) out.push(...picture(zip, href.replace(/^\.\//, ''), images));
				const inner = flow({ name: 'box', attrs: {}, kids: els(k).filter((i) => i.name !== 'image') });
				// A slide's title frame (presentation:class="title") is its heading.
				out.push(...(k.attrs['class'] === 'title' ? inner.map((b): Block => (b.t === 'p' ? { t: 'h', level: 2, html: b.html } : b)) : inner));
			} else if (['section', 'text-box', 'box', 'g', 'custom-shape', 'index-body', 'table-of-content'].includes(k.name))
				out.push(...flow(k));
		}
		return out;
	};
	const body = find(content, 'body');
	const text = body && child(body, 'text');
	if (text) return flow(text);
	const pres = body && child(body, 'presentation');
	if (pres) return kids(pres, 'page').map((p, i) => ({ t: 'section', kind: 'slide', n: i + 1, blocks: flow(p) }));
	throw new Error('the package has no text or presentation body');
}

function* rowsOf(t: X): Generator<X> {
	for (const k of els(t))
		if (k.name === 'table-row') yield k;
		else if (['table-header-rows', 'table-rows', 'table-row-group'].includes(k.name)) yield* rowsOf(k);
}
/** An ODF cell's value by its type: numbers (float, percentage, currency), ISO dates, durations, booleans, else its text. */
const odsValue = (tc: X): Value => {
	const a = tc.attrs;
	switch (a['value-type']) {
		case 'float':
		case 'percentage':
		case 'currency':
			return Number(a['value']);
		case 'date':
			return a['date-value']?.replace(/T00:00:00$/, '') ?? null;
		case 'time':
			return a['time-value'] ?? null;
		case 'boolean':
			return a['boolean-value'] === 'true';
	}
	const t = kids(tc, 'p').map(text).join('\n');
	return t === '' ? null : t;
};
/**
 * An ods's sheets: typed cells, merges, and the pictures anchored in a cell. Repeated empties only advance the
 * cursor, so a sheet's million blank rows cost nothing.
 */
export function ods(bytes: Uint8Array, images: Images): Sheets {
	const zip = unzip(bytes);
	const body = find(part(zip, 'content.xml'), 'body');
	const book = body && child(body, 'spreadsheet');
	if (!book) throw new Error('the package has no spreadsheet body');
	return {
		sheets: kids(book, 'table').map((t, i) => {
			const grid: Value[][] = [];
			const merges: Merge[] = [];
			const anchors: Anchor[] = [];
			let r = 0;
			for (const tr of rowsOf(t)) {
				const row: Value[] = [];
				const spans: Merge[] = [];
				let c = 0;
				for (const tc of els(tr)) {
					if (tc.name !== 'table-cell' && tc.name !== 'covered-table-cell') continue;
					const n = int(tc.attrs['number-columns-repeated']);
					const v = tc.name === 'covered-table-cell' ? null : odsValue(tc);
					const [rows, cols] = [int(tc.attrs['number-rows-spanned']), int(tc.attrs['number-columns-spanned'])];
					for (let k = 0; k < n && (v !== null || rows > 1 || cols > 1); k++) {
						if (v !== null) row[c + k] = v;
						if (tc.name === 'table-cell' && (rows > 1 || cols > 1)) spans.push({ row: 0, col: c + k, rows, cols });
					}
					for (const f of kids(tc, 'frame')) {
						const href = child(f, 'image')?.attrs['href']?.replace(/^\.\//, '');
						const mime = href && IMAGE[href.split('.').pop()?.toLowerCase() ?? ''];
						const read = href && zip.get(href);
						if (mime && read) anchors.push({ name: images.add(read(), mime), row: r, col: c });
					}
					c += n;
				}
				const reps = int(tr.attrs['number-rows-repeated'], 1);
				if (row.length > 0 || spans.length > 0)
					for (let k = 0; k < Math.min(reps, 1024); k++) {
						grid[r + k] = [...row];
						merges.push(...spans.map((m) => ({ ...m, row: r + k })));
					}
				r += reps;
			}
			return sheet(t.attrs['name'] ?? `Sheet ${i + 1}`, Array.from(grid, (row) => Array.from(row ?? [], (x) => x ?? null)), merges, anchors);
		})
	};
}
