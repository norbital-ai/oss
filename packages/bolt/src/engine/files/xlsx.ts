// Shared xlsx workbook reads and writes in the engine (raw DEFLATE by `fflate`): the agent's `read_attachment` sheets,
// `ctx.files.sheet`, and a file sync's upload, template and export.
import { deflateSync, Inflate } from 'fflate';

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
	for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
	return n;
});
const crc32 = (bytes: Uint8Array): number => {
	let c = ~0;
	for (const b of bytes) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
	return ~c >>> 0;
};
/** A zip bomb stops here, whatever size the entry declares (writers may declare none). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const inflated = (name: string, data: Uint8Array): Uint8Array => {
	const parts: Uint8Array[] = [];
	let total = 0;
	const inflate = new Inflate((chunk) => {
		total += chunk.length;
		if (total > MAX_ENTRY_BYTES) throw new Error(`${name} is over 64 MiB unpacked`);
		parts.push(chunk);
	});
	inflate.push(data, true);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

/** std/sheet's cell (`@norbital-ai/std` sheet). */
export type Cell = string | number | boolean | null;
const ENTITY: { readonly [e: string]: string } = {
	lt: '<',
	gt: '>',
	amp: '&',
	quot: '"',
	apos: "'"
};
const unxml = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e: string) =>
		e[0] === '#'
			? String.fromCodePoint(
					e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
				)
			: (ENTITY[e] ?? all)
	);
const texts = (xml: string) =>
	unxml(
		[...xml.matchAll(/<(?:[\w.-]+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?t>/g)]
			.map((t) => t[1])
			.join('')
	);

/**
 * An xlsx worksheet as std/sheet's `Cell[][]` (row 1 first; gaps are `null`). A zip read with `fflate`:
 * stored and deflated entries, shared and inline strings, booleans and numbers.
 * ponytail: styled dates arrive as serials (styles are not read); ISO date cells retain their text and zone.
 */
function xlsxEntries(zip: Uint8Array): Map<string, () => string> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
	if (end < 0) throw new Error('the file is not an xlsx workbook');
	const entries = new Map<string, () => string>();
	for (let at = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); n > 0; n--) {
		const method = v.getUint16(at + 10, true),
			size = v.getUint32(at + 20, true),
			nameLen = v.getUint16(at + 28, true),
			local = v.getUint32(at + 42, true);
		const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
		at += 46 + nameLen + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
		entries.set(name, () => {
			const data = zip
				.subarray(local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true))
				.subarray(0, size);
			return new TextDecoder().decode(method === 0 ? data : inflated(name, data));
		});
	}
	return entries;
}

function worksheetRefs(read: (name: string) => string): { name: string; path: string }[] {
	const attr = (xml: string, name: string) =>
		new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(xml)?.[1];
	const rels = [
		...read('xl/_rels/workbook.xml.rels').matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*?)\/?\s*>/g)
	].map((m) => ({ id: attr(m[1]!, 'Id'), target: attr(m[1]!, 'Target') }));
	return [...read('xl/workbook.xml').matchAll(/<(?:[\w.-]+:)?sheet\b([^>]*?)\/?\s*>/g)].map(
		(m, i) => {
			const name = attr(m[1]!, 'name') ?? `Sheet ${i + 1}`;
			const target = rels.find((r) => r.id === attr(m[1]!, '[\\w.-]+:id'))?.target;
			return {
				name: unxml(name),
				path: target?.replace(/^\/?(xl\/)?/, 'xl/') ?? `xl/worksheets/sheet${i + 1}.xml`
			};
		}
	);
}

export function xlsxSheets(zip: Uint8Array): string[] {
	const entries = xlsxEntries(zip);
	return worksheetRefs((name) => entries.get(name)?.() ?? '').map((sheet) => sheet.name);
}

export function xlsxCells(zip: Uint8Array, sheet = 0): Cell[][] {
	const entries = xlsxEntries(zip);
	const read = (name: string) => entries.get(name)?.() ?? '';
	const refs = worksheetRefs(read);
	if (!Number.isInteger(sheet) || sheet < 0 || sheet >= refs.length)
		throw new Error(`worksheet ${sheet} does not exist`);
	const path = refs[sheet]!.path;
	const shared = [
		...read('xl/sharedStrings.xml').matchAll(
			/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/g
		)
	].map((m) => texts(m[1]!));
	const out: Cell[][] = [];
	for (const row of read(path).matchAll(
		/<(?:[\w.-]+:)?row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?row>)/g
	)) {
		const cells: Cell[] = [];
		for (const c of (row[2] ?? '').matchAll(
			/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g
		)) {
			const attrs = c[1]!,
				body = c[2] ?? '',
				ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '';
			const col =
				ref === ''
					? cells.length
					: [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
			const t = /\bt="(\w+)"/.exec(attrs)?.[1],
				raw = /<(?:[\w.-]+:)?v(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?v>/.exec(body)?.[1];
			const value: Cell =
				t === 'inlineStr'
					? texts(body)
					: raw === undefined
						? null
						: t === 's'
							? (shared[Number(raw)] ?? null)
							: t === 'b'
								? raw === '1'
								: t === 'str' || t === 'e' || t === 'd'
									? unxml(raw)
									: Number(raw);
			while (cells.length < col) cells.push(null);
			cells[col] = value;
		}
		const at = Number(row[1]) - 1;
		while (out.length < at) out.push([]);
		out[at] = cells;
	}
	return out;
}

const xml = (s: string) =>
	s.replace(
		/[<>&"]/g,
		(c) => `&${({ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot' } as const)[c as '<']};`
	);
const column = (i: number): string =>
	(i >= 26 ? column(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26));

/** One worksheet of cells as an xlsx workbook (strings inline, row 1 first): what `xlsxCells` reads back. */
export function xlsxOf(rows: readonly (readonly Cell[])[], sheet = 'Sheet1'): Uint8Array {
	const cells = rows
		.map(
			(r, y) =>
				`<row r="${y + 1}">${r
					.map((c, x) => {
						const at = `${column(x)}${y + 1}`;
						return c === null
							? ''
							: typeof c === 'number'
								? `<c r="${at}"><v>${c}</v></c>`
								: typeof c === 'boolean'
									? `<c r="${at}" t="b"><v>${c ? 1 : 0}</v></c>`
									: `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${xml(c)}</t></is></c>`;
					})
					.join('')}</row>`
		)
		.join('');
	const files: [string, string][] = [
		[
			'[Content_Types].xml',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
		],
		[
			'_rels/.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
		],
		[
			'xl/workbook.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
		],
		[
			'xl/_rels/workbook.xml.rels',
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
		],
		[
			'xl/worksheets/sheet1.xml',
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`
		]
	];
	// a zip of deflated entries: local headers, then the central directory and its end record
	const parts: Uint8Array[] = [],
		central: Uint8Array[] = [];
	let offset = 0;
	for (const [name, text] of files) {
		const raw = new TextEncoder().encode(text),
			data = deflateSync(raw),
			path = new TextEncoder().encode(name),
			crc = crc32(raw);
		const head = (sig: number, extra: number) => {
			const b = new Uint8Array(extra + path.length),
				v = new DataView(b.buffer);
			v.setUint32(0, sig, true);
			const at = sig === 0x02014b50 ? 2 : 0; // the central record carries a "made by" version first
			v.setUint16(4 + at, 20, true);
			v.setUint16(8 + at, 8, true);
			v.setUint32(14 + at, crc, true);
			v.setUint32(18 + at, data.length, true);
			v.setUint32(22 + at, raw.length, true);
			v.setUint16(26 + at, path.length, true);
			if (at === 2) v.setUint32(42, offset, true);
			b.set(path, extra);
			return b;
		};
		const local = head(0x04034b50, 30);
		central.push(head(0x02014b50, 46));
		parts.push(local, data);
		offset += local.length + data.length;
	}
	const size = central.reduce((n, b) => n + b.length, 0),
		end = new Uint8Array(22),
		v = new DataView(end.buffer);
	v.setUint32(0, 0x06054b50, true);
	v.setUint16(8, files.length, true);
	v.setUint16(10, files.length, true);
	v.setUint32(12, size, true);
	v.setUint32(16, offset, true);
	const out = new Uint8Array(offset + size + 22);
	let at = 0;
	for (const b of [...parts, ...central, end]) {
		out.set(b, at);
		at += b.length;
	}
	return out;
}
