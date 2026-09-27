// std/sheet (§3.7, §5.4, D15): the one `Cell[][]` ⇄ rows codec. The host turns xlsx/csv bytes into cells
// (`ctx.files.table`) and cells back into a file (`ctx.files.sheet`, which also applies a `SheetStyle`); this module
// only maps cells to typed rows and back. The first row is the header; a header matches a column name, a date
// period is two columns `<name>.from` / `<name>.to` (inclusive, blank `to` = open), and an unknown header is an error.
import { Decimal } from './decimal.ts';
import { addDays, PlainDate, type DatePeriod } from './date.ts';

/** One spreadsheet cell's value. */
export type Cell = string | number | boolean | null;
/**
 * How a sheet column decodes to a typed value: a scalar kind, an enum, or a date period over two columns (`<name>.from`, `<name>.to`).
 */
export type ColumnSpec =
	| 'text' | 'int' | 'decimal' | 'date' | 'time' | 'bool'
	| { readonly enum: readonly string[] }
	| { readonly period: 'date' }
	| { readonly optional: ColumnSpec };
/** Presentation hints the host applies when it writes the file; rows and columns are 0-based cell indexes. */
export type SheetStyle = {
	readonly bold?: readonly number[];                                   // rows (the header row is bold by default)
	readonly merge?: readonly (readonly [row: number, col: number, toRow: number, toCol: number])[];
	readonly band?: { readonly fill: string; readonly every?: number };  // fill every n-th data row (default 2)
	readonly numFmt?: { readonly [column: string]: string };            // by header, e.g. { amount: '#,##0.00' }
};

type Spec = { readonly [name: string]: ColumnSpec };
type ValueOf<C> =
	C extends { optional: infer I } ? ValueOf<I> | null
	: C extends 'text' | 'time' ? string : C extends 'int' ? number : C extends 'decimal' ? Decimal
	: C extends 'date' ? PlainDate : C extends 'bool' ? boolean : C extends { enum: readonly (infer E)[] } ? E
	: C extends { period: 'date' } ? DatePeriod : never;
type RowOf<C extends Spec> = { -readonly [K in keyof C]: ValueOf<C[K]> };
type SheetError = { readonly row: number; readonly column: string; readonly message: string };

/** Declares a sheet's columns; the value is the spec itself, typed for `decode`'s rows. */
export const columns = <const C extends Spec>(c: C): C => c;

const EXCEL_EPOCH = '1899-12-30';
const blank = (c: Cell | undefined) => c === null || c === undefined || (typeof c === 'string' && c.trim() === '');
const inner = (s: ColumnSpec): ColumnSpec => typeof s === 'object' && 'optional' in s ? inner(s.optional) : s;

function cell(spec: ColumnSpec, c: Cell): unknown {
	const s = inner(spec), text = typeof c === 'string' ? c.trim() : String(c);
	if (s === 'text') return text;
	if (s === 'int') { const n = Number(text); if (!Number.isSafeInteger(n)) throw new Error('expected a whole number'); return n; }
	// A number cell is a double: its shortest digits are what the sheet shows (an exponent form is rounded to 10 places).
	if (s === 'decimal') return typeof c === 'number' && /e/i.test(text) ? Decimal.fromNumber(c, 10) : Decimal.of(text);
	if (s === 'date') return typeof c === 'number' ? addDays(EXCEL_EPOCH, Math.floor(c)) : PlainDate(text.slice(0, 10));
	if (s === 'time') {
		if (typeof c === 'number') { const m = Math.round((c % 1) * 1440); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
		const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(text);
		if (m === null || Number(m[1]) > 23) throw new Error('expected a time HH:MM');
		return `${m[1]!.padStart(2, '0')}:${m[2]}`;
	}
	if (s === 'bool') {
		if (typeof c === 'boolean') return c;
		const t = text.toLowerCase();
		if (['true', 'yes', 'y', '1'].includes(t)) return true;
		if (['false', 'no', 'n', '0'].includes(t)) return false;
		throw new Error('expected yes or no');
	}
	if ('enum' in s) { if (!s.enum.includes(text)) throw new Error(`expected one of ${s.enum.join(', ')}`); return text; }
	throw new Error('a period is two columns');
}

/** Rows from cells; every bad cell, missing column and unknown header is an error, and no row with an error is returned. */
export function decode<const C extends Spec>(cells: readonly (readonly Cell[])[], cols: C): { rows: RowOf<C>[]; errors: SheetError[] } {
	const errors: SheetError[] = [], rows: RowOf<C>[] = [];
	const header = (cells[0] ?? []).map((h) => (blank(h) ? '' : String(h).trim()));
	const at = new Map<string, number>();
	header.forEach((h, i) => { if (h !== '') at.set(h, i); });
	const known = new Set<string>();
	for (const [name, spec] of Object.entries(cols)) {
		const s = inner(spec), keys = typeof s === 'object' && 'period' in s ? [`${name}.from`, `${name}.to`] : [name];
		for (const k of keys) {
			known.add(k);
			if (!at.has(k) && !(typeof spec === 'object' && 'optional' in spec) && !k.endsWith('.to')) errors.push({ row: 1, column: k, message: 'missing column' });
		}
	}
	for (const h of at.keys()) if (!known.has(h)) errors.push({ row: 1, column: h, message: 'unknown column' });
	if (errors.length > 0) return { rows, errors };
	cells.slice(1).forEach((line, i) => {
		if (line.every(blank)) return;
		const row: Record<string, unknown> = {}, before = errors.length;
		const read = (column: string, spec: ColumnSpec, optional: boolean) => {
			const c = line[at.get(column) ?? -1];
			if (blank(c)) { if (!optional) errors.push({ row: i + 2, column, message: 'required' }); return null; }
			try { return cell(spec, c!); } catch (e) { errors.push({ row: i + 2, column, message: e instanceof Error ? e.message : String(e) }); return null; }
		};
		for (const [name, spec] of Object.entries(cols)) {
			const optional = typeof spec === 'object' && 'optional' in spec, s = inner(spec);
			if (typeof s === 'object' && 'period' in s) {
				const from = read(`${name}.from`, 'date', optional), to = read(`${name}.to`, 'date', true) as PlainDate | null;
				if (from !== null && to !== null && to < (from as string)) errors.push({ row: i + 2, column: `${name}.to`, message: 'ends before it starts' });
				row[name] = from === null ? null : { from, to };
			} else row[name] = read(name, spec, optional);
		}
		if (errors.length === before) rows.push(row as RowOf<C>);
	});
	return { rows, errors };
}

/** Cells from rows: the header, then one line per row (a period as its two cells, a decimal as its exact text). */
export function encode<const C extends Spec>(rows: readonly NoInfer<RowOf<C>>[], cols: C): Cell[][] {
	const header: string[] = [];
	for (const [name, spec] of Object.entries(cols)) {
		const s = inner(spec);
		header.push(...(typeof s === 'object' && 'period' in s ? [`${name}.from`, `${name}.to`] : [name]));
	}
	const out = (v: unknown): Cell => v === null || v === undefined ? null : v instanceof Decimal ? v.toString() : v as Cell;
	return [header, ...rows.map((r) => Object.entries(cols).flatMap(([name, spec]): Cell[] => {
		const s = inner(spec), v = (r as Record<string, unknown>)[name];
		if (typeof s === 'object' && 'period' in s) { const p = v as DatePeriod | null; return [p?.from ?? null, p?.to ?? null]; }
		return [out(v)];
	}))];
}
