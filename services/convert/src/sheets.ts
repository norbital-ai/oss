// A spreadsheet as typed JSON (xlsx, ods, xls, csv, tsv): the ingest result's `json`, for code to compute over.
export type Value = string | number | boolean | null;
export type Merge = { row: number; col: number; rows: number; cols: number };
/** A picture drawn on the sheet: its image file, anchored at its top-left cell (indexed like `rows`). */
export type Anchor = { name: string; row: number; col: number };
export type Sheet = { name: string; columns: string[]; rows: Value[][]; merges?: Merge[]; images?: Anchor[] };
export type Sheets = { sheets: Sheet[] };

/** A, B, … Z, AA, AB, … */
export const letters = (i: number): string => (i < 26 ? '' : letters(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

/**
 * A sheet from its grid (row-major, sheet coordinates). The first row is the header when it is all distinct text,
 * another row follows, and no merge touches it; its columns are then those names, else A, B, …. Merges and image
 * anchors index `rows`.
 */
export function sheet(name: string, grid: Value[][], merges: Merge[] = [], images: Anchor[] = []): Sheet {
	const width = Math.max(0, ...grid.map((r) => r.length), ...merges.map((m) => m.col + m.cols));
	const rows = grid.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? null));
	const first = rows[0] ?? [];
	const header =
		rows.length > 1 &&
		first.length > 0 &&
		first.every((v) => typeof v === 'string' && v.trim() !== '') &&
		new Set(first).size === first.length &&
		!merges.some((m) => m.row === 0);
	const shift = header ? 1 : 0;
	return {
		name,
		columns: header ? first.map(String) : Array.from({ length: width }, (_, c) => letters(c)),
		rows: header ? rows.slice(1) : rows,
		...(merges.length > 0 ? { merges: merges.map((m) => ({ ...m, row: m.row - shift })) } : {}),
		...(images.length > 0 ? { images: images.map((i) => ({ ...i, row: i.row - shift })) } : {})
	};
}

/** Text as the value it spells: a plain number (not one with a leading zero, an id), true/false, or the text; empty is null. */
export const typed = (text: string): Value => {
	const t = text.trim();
	if (t === '') return null;
	if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t);
	if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
	return text;
};

/** RFC 4180 with the delimiter sniffed (comma, semicolon, tab or pipe): quoted fields hold delimiters, "" and newlines. */
export function parseCsv(source: string): string[][] {
	const sample = source.split(/\r?\n/, 20).filter((l) => l.trim() !== '');
	const counts = (d: string) => sample.map((l) => l.replace(/"[^"]*"/g, '').split(d).length - 1);
	const score = (d: string) => {
		const c = counts(d);
		return Math.min(...c) > 0 ? Math.min(...c) + (c.every((n) => n === c[0]) ? 1000 : 0) : 0;
	};
	const delim = [',', ';', '\t', '|'].reduce((best, d) => (score(d) > score(best) ? d : best), ',');
	const rows: string[][] = [[]];
	let field = '',
		quoted = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (quoted) {
			if (c === '"' && source[i + 1] === '"') field += source[++i];
			else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === delim) rows.at(-1)!.push(field), (field = '');
		else if (c === '\n' || c === '\r') {
			if (c === '\r' && source[i + 1] === '\n') i++;
			rows.at(-1)!.push(field);
			field = '';
			rows.push([]);
		} else field += c;
	}
	if (field !== '' || rows.at(-1)!.length > 0) rows.at(-1)!.push(field);
	if (rows.at(-1)!.length === 0) rows.pop();
	return rows;
}

/** A spreadsheet serial day as ISO: a date, a date and time, or a time of day. */
export function serialDate(serial: number, date1904: boolean): string {
	const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
	const iso = new Date(ms).toISOString().slice(0, 19);
	if (serial < 1) return iso.slice(11);
	return Number.isInteger(serial) ? iso.slice(0, 10) : iso;
}
