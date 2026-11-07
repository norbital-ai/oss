// xlsx and xls by Calamine: typed cells and merges, past what a JavaScript XML reader holds. Its cells carry no drawings,
// so a picture on a sheet is read from the package's own drawing parts.
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { read } from 'calamine-node';
import { Effect, Schema } from 'effect';
import type { Images } from '../blocks.ts';
import { sheet, type Anchor, type Sheets, type Value } from '../sheets.ts';

const IMAGE: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp'
};
/** A zip bomb stops here, whatever size the entry declares. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const CENTRAL = 0x06054b50;
function unzip(zip: Uint8Array): Map<string, () => Buffer> {
	const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let end = zip.length - 22;
	while (end >= 0 && v.getUint32(end, true) !== CENTRAL) end--;
	const entries = new Map<string, () => Buffer>();
	if (end < 0) return entries;
	for (let at = v.getUint32(end + 16, true), n = v.getUint16(end + 10, true); n > 0; n--) {
		const method = v.getUint16(at + 10, true),
			size = v.getUint32(at + 20, true),
			nameLength = v.getUint16(at + 28, true),
			local = v.getUint32(at + 42, true);
		const name = Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString('utf8');
		at += 46 + nameLength + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
		entries.set(name, () => {
			const data = zip
				.subarray(local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true))
				.subarray(0, size);
			return method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
		});
	}
	return entries;
}
const posix = (base: string, relative: string) => {
	const parts = relative.startsWith('/') ? [] : base.split('/').slice(0, -1);
	for (const part of relative.replace(/^\//, '').split('/'))
		if (part === '..') parts.pop();
		else if (part !== '.') parts.push(part);
	return parts.join('/');
};
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)(?:\\w+:)?${name}="([^"]*)"`).exec(tag)?.[1];
const tags = (xml: string, name: string) => xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>`, 'g')) ?? [];
/** A part's relationships: id to package path. */
const relations = (zip: Map<string, () => Buffer>, part: string) => {
	const file = posix(part, `_rels/${part.split('/').pop()}.rels`);
	return new Map(
		tags(zip.get(file)?.().toString('utf8') ?? '', 'Relationship').flatMap((tag) =>
			attr(tag, 'TargetMode') === 'External' ? [] : [[attr(tag, 'Id') ?? '', posix(part, attr(tag, 'Target') ?? '')]]
		)
	);
};
/** Each sheet's pictures, by the sheet's name: stored as images, anchored at their top-left cell. */
function pictures(bytes: Uint8Array, images: Images) {
	const zip = unzip(bytes),
		found = new Map<string, Anchor[]>(),
		book = zip.get('xl/workbook.xml')?.().toString('utf8') ?? '',
		sheets = relations(zip, 'xl/workbook.xml');
	for (const tag of tags(book, 'sheet')) {
		const path = sheets.get(attr(tag, 'id') ?? ''),
			ws = path === undefined ? '' : (zip.get(path)?.().toString('utf8') ?? ''),
			drawing = tags(ws, 'drawing')[0],
			part = path === undefined || drawing === undefined ? undefined : relations(zip, path).get(attr(drawing, 'id') ?? ''),
			drawn = part === undefined ? undefined : zip.get(part)?.().toString('utf8');
		if (drawn === undefined || part === undefined) continue;
		const media = relations(zip, part),
			anchors: Anchor[] = [];
		for (const [anchor] of drawn.matchAll(/<(?:\w+:)?(twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:\w+:)?\1>/g)) {
			const blip = tags(anchor, 'blip')[0],
				target = blip === undefined ? undefined : media.get(attr(blip, 'embed') ?? ''),
				mime = IMAGE[target?.split('.').pop()?.toLowerCase() ?? ''],
				image = target === undefined ? undefined : zip.get(target),
				at = /<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?col>(\d+)<[\s\S]*?<(?:\w+:)?row>(\d+)</.exec(anchor);
			if (mime !== undefined && image !== undefined && at !== null)
				anchors.push({ name: images.add(image(), mime), row: Number(at[2]), col: Number(at[1]) });
		}
		found.set(attr(tag, 'name')?.replace(/&amp;/g, '&') ?? '', anchors);
	}
	return found;
}
const Special = Schema.Struct({ kind: Schema.String, value: Schema.Union([Schema.String, Schema.Number]) });
const pad = (n: number | undefined, width = 2) => String(n ?? 0).padStart(width, '0');
/** A datetime as ISO: a date, a date and time, or a time alone (a serial below one day). */
const iso = (serial: number, calendar: readonly number[]) => {
	const [year, month, day, hour, minute, second] = calendar,
		date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
		time = `${pad(hour)}:${pad(minute)}:${pad(second)}`;
	return serial < 1 ? time : Number.isInteger(serial) ? date : `${date}T${time}`;
};
const Calendar = Schema.Struct({ value: Schema.Number, calendar: Schema.Array(Schema.Number) });
/** A cell as the model's value: an empty string is an empty cell; an integer past a double stays exact, as text. */
const value = (cell: unknown): Value => {
	if (cell === '' || cell === null || cell === undefined) return null;
	if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') return cell;
	if (!Schema.is(Special)(cell)) return null;
	if (cell.kind === 'datetime' && Schema.is(Calendar)(cell)) return iso(cell.value, cell.calendar);
	return cell.value;
};
/** `bytes` the file's own, `path` where it lies under its format's extension. */
export const workbook = (path: string, images: Images) =>
	Effect.gen(function* () {
		const book = yield* Effect.tryPromise(() => read(path)),
			anchored = path.endsWith('.xlsx')
				? pictures(new Uint8Array(yield* Effect.tryPromise(() => readFile(path))), images)
				: undefined;
		const sheets = book.sheets
			.filter((one) => one.kind === 'worksheet')
			.map((one) => {
				const { row, column } = one.origin ?? { row: 0, column: 0 },
					grid: Value[][] = Array.from({ length: row }, (): Value[] => []);
				for (const cells of one.rows) grid.push([...Array.from({ length: column }, (): Value => null), ...cells.map(value)]);
				while (grid.length > 0 && (grid.at(-1) ?? []).every((cell) => cell === null)) grid.pop();
				return sheet(
					one.name,
					grid,
					(one.mergedCells ?? []).map((m) => ({
						row: m.start.row,
						col: m.start.column,
						rows: m.end.row - m.start.row + 1,
						cols: m.end.column - m.start.column + 1
					})),
					anchored?.get(one.name) ?? []
				);
			});
		return { sheets } satisfies Sheets;
	});
