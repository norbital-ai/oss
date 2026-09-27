// An xlsx workbook read on the host (`node:zlib`): the agent's `read_attachment` sheets and the sheets `sandbox_run`
// hands its programs as CSV.
import { inflateRawSync } from 'node:zlib';

/** std/sheet's cell (`@norbital-ai/std` sheet). */
export type Cell = string | number | boolean | null;
const ENTITY: { readonly [e: string]: string } = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
	e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITY[e] ?? all);
const texts = (xml: string) => unxml([...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(''));

/**
 * An xlsx worksheet as std/sheet's `Cell[][]` (row 1 first; gaps are `null`). A zip read with `node:zlib`:
 * stored and deflated entries, shared and inline strings, booleans and numbers.
 * ponytail: a date cell arrives as its serial number (styles are not read); read `xl/styles.xml` when an agent needs dates.
 */
function xlsxEntries(zip: Uint8Array): Map<string, () => string> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) throw new Error('the file is not an xlsx workbook');
	const entries = new Map<string, () => string>();
	for (let at = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); n > 0; n--) {
		const method = v.getUint16(at + 10, true), size = v.getUint32(at + 20, true), nameLen = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
		const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
		entries.set(name, () => {
			const data = zip.subarray(local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true)).subarray(0, size);
			return new TextDecoder().decode(method === 0 ? data : inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }));
		});
	}
	return entries;
}

function worksheetRefs(read: (name: string) => string): { name: string; path: string }[] {
	const attr = (xml: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(xml)?.[1];
	const rels = [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)]
		.map((m) => ({ id: attr(m[1]!, 'Id'), target: attr(m[1]!, 'Target') }));
	return [...read('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?\s*>/g)].map((m, i) => {
		const name = attr(m[1]!, 'name') ?? `Sheet ${i + 1}`;
		const target = rels.find((r) => r.id === attr(m[1]!, 'r:id'))?.target;
		return { name: unxml(name), path: target?.replace(/^\/?(xl\/)?/, 'xl/') ?? `xl/worksheets/sheet${i + 1}.xml` };
	});
}

export function xlsxSheets(zip: Uint8Array): string[] {
	const entries = xlsxEntries(zip);
	return worksheetRefs((name) => entries.get(name)?.() ?? '').map((sheet) => sheet.name);
}

export function xlsxCells(zip: Uint8Array, sheet = 0): Cell[][] {
	const entries = xlsxEntries(zip);
	const read = (name: string) => entries.get(name)?.() ?? '';
	const refs = worksheetRefs(read);
	if (!Number.isInteger(sheet) || sheet < 0 || sheet >= refs.length) throw new Error(`worksheet ${sheet} does not exist`);
	const path = refs[sheet]!.path;
	const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!));
	const out: Cell[][] = [];
	for (const row of read(path).matchAll(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
		const cells: Cell[] = [];
		for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
			const attrs = c[1]!, body = c[2] ?? '', ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
			const col = ref === '' ? cells.length : [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
			const t = /\bt="(\w+)"/.exec(attrs)?.[1], raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
			const value: Cell = t === 'inlineStr' ? texts(body) : raw === undefined ? null : t === 's' ? shared[Number(raw)] ?? null
				: t === 'b' ? raw === '1' : t === 'str' || t === 'e' ? unxml(raw) : Number(raw);
			while (cells.length < col) cells.push(null);
			cells[col] = value;
		}
		const at = Number(row[1]) - 1;
		while (out.length < at) out.push([]);
		out[at] = cells;
	}
	return out;
}

/** Cells as RFC 4180 CSV: a field with a comma, quote or line break is quoted, quotes doubled; `null` is empty. */
export const csvOf = (rows: readonly (readonly Cell[])[]): string =>
	rows.map((r) => r.map((c) => { const t = c === null ? '' : String(c); return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t; }).join(',')).join('\n') + '\n';
