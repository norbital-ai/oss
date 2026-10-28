// std/sheet (§3.7, §5.4, D15): the one `Cell[][]` ⇄ rows codec. The host reads file references through
// `ctx.files.table` (a string-cell table) or `ctx.files.sheet` (worksheets with typed cells); this module
// only maps cells to typed rows and back. The first row is the header; a header matches a column name, a date
// period is two columns `<name>.from` / `<name>.to` (inclusive, blank `to` = open), and an unknown header is an error.
import { Decimal } from './decimal.ts';
import * as Result from 'effect/Result';
import { addDays, PlainDate, type DatePeriod } from './date.ts';

/** One spreadsheet cell's value. */
export type Cell = string | number | boolean | null;
/**
 * How a sheet column decodes to a typed value: a scalar kind, an enum, or a date period over two columns (`<name>.from`, `<name>.to`).
 */
export type ColumnSpec =
	| 'text'
	| 'int'
	| 'decimal'
	| 'date'
	| 'time'
	| 'bool'
	| { readonly enum: readonly string[] }
	| { readonly period: 'date' }
	| { readonly optional: ColumnSpec };

type Spec = { readonly [name: string]: ColumnSpec };
type ValueOf<C> = C extends { optional: infer I }
	? ValueOf<I> | null
	: C extends 'text' | 'time'
		? string
		: C extends 'int'
			? number
			: C extends 'decimal'
				? Decimal
				: C extends 'date'
					? PlainDate
					: C extends 'bool'
						? boolean
						: C extends { enum: readonly (infer E)[] }
							? E
							: C extends { period: 'date' }
								? DatePeriod
								: never;
type RowOf<C extends Spec> = { -readonly [K in keyof C]: ValueOf<C[K]> };
type SheetError = { readonly row: number; readonly column: string; readonly message: string };

/** Declares a sheet's columns; the value is the spec itself, typed for `decode`'s rows. */
export const columns = <const C extends Spec>(c: C): C => c;

const EXCEL_EPOCH = '1899-12-30';
const blank = (c: Cell | undefined) =>
	c === null || c === undefined || (typeof c === 'string' && c.trim() === '');

/** A column spec normalised once: its kind (enum values, or a date period over two columns) and whether it may be blank. */
type Column =
	| {
			readonly name: string;
			readonly kind: 'text' | 'int' | 'decimal' | 'date' | 'time' | 'bool';
			readonly optional: boolean;
	  }
	| {
			readonly name: string;
			readonly kind: 'enum';
			readonly values: readonly string[];
			readonly optional: boolean;
	  }
	| { readonly name: string; readonly kind: 'period'; readonly optional: boolean };
type Scalar = Exclude<Column, { readonly kind: 'period' }>;
const normalise = (name: string, spec: ColumnSpec, optional = false): Column =>
	typeof spec === 'string'
		? { name, kind: spec, optional }
		: 'optional' in spec
			? normalise(name, spec.optional, true)
			: 'enum' in spec
				? { name, kind: 'enum', values: spec.enum, optional }
				: { name, kind: 'period', optional };
const columnsOf = (cols: Spec): Column[] =>
	Object.entries(cols).map(([name, spec]) => normalise(name, spec));
const headersOf = (c: Column): string[] =>
	c.kind === 'period' ? [`${c.name}.from`, `${c.name}.to`] : [c.name];

function cell(c: Scalar, v: Cell): unknown {
	const text = typeof v === 'string' ? v.trim() : String(v);
	switch (c.kind) {
		case 'text':
			return text;
		case 'int': {
			const n = Number(text);
			if (!Number.isSafeInteger(n)) throw new Error('expected a whole number');
			return n;
		}
		// A number cell is a double: its shortest digits are what the sheet shows (an exponent form is rounded to 10 places).
		case 'decimal':
			return typeof v === 'number' && /e/i.test(text)
				? Decimal.fromNumber(v, 10)
				: Decimal.of(text);
		case 'date':
			return typeof v === 'number'
				? addDays(EXCEL_EPOCH, Math.floor(v))
				: PlainDate(text.slice(0, 10));
		case 'time': {
			if (typeof v === 'number') {
				const m = Math.round((v % 1) * 1440);
				return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
			}
			const m = /^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/.exec(text);
			if (m === null || Number(m[1]) > 23) throw new Error('expected a time HH:MM');
			return `${m[1]!.padStart(2, '0')}:${m[2]}`;
		}
		case 'bool': {
			if (typeof v === 'boolean') return v;
			const t = text.toLowerCase();
			if (['true', 'yes', 'y', '1'].includes(t)) return true;
			if (['false', 'no', 'n', '0'].includes(t)) return false;
			throw new Error('expected yes or no');
		}
		case 'enum': {
			if (!c.values.includes(text)) throw new Error(`expected one of ${c.values.join(', ')}`);
			return text;
		}
	}
}

/** Rows from cells; every bad cell, missing column and unknown header is an error, and no row with an error is returned. */
export function decode<const C extends Spec>(
	cells: readonly (readonly Cell[])[],
	cols: C
): { rows: RowOf<C>[]; errors: SheetError[] } {
	const errors: SheetError[] = [],
		rows: RowOf<C>[] = [],
		columns = columnsOf(cols);
	const header = (cells[0] ?? []).map((h) => (blank(h) ? '' : String(h).trim()));
	const at = new Map<string, number>();
	header.forEach((h, i) => {
		if (h !== '') at.set(h, i);
	});
	const known = new Set<string>();
	for (const c of columns)
		for (const k of headersOf(c)) {
			known.add(k);
			if (!at.has(k) && !c.optional && !k.endsWith('.to'))
				errors.push({ row: 1, column: k, message: 'missing column' });
		}
	for (const h of at.keys())
		if (!known.has(h)) errors.push({ row: 1, column: h, message: 'unknown column' });
	if (errors.length > 0) return { rows, errors };
	cells.slice(1).forEach((line, i) => {
		if (line.every(blank)) return;
		const row: Record<string, unknown> = {},
			before = errors.length;
		const read = (column: string, c: Scalar, optional: boolean) => {
			const v = line[at.get(column) ?? -1];
			if (blank(v)) {
				if (!optional) errors.push({ row: i + 2, column, message: 'required' });
				return null;
			}
			const decoded = Result.try(() => cell(c, v!));
			if (Result.isSuccess(decoded)) return decoded.success;
			errors.push({
				row: i + 2,
				column,
				message:
					decoded.failure instanceof Error ? decoded.failure.message : String(decoded.failure)
			});
			return null;
		};
		for (const c of columns) {
			if (c.kind === 'period') {
				const day = { name: c.name, kind: 'date', optional: c.optional } as const;
				const from = read(`${c.name}.from`, day, c.optional),
					to = read(`${c.name}.to`, day, true) as PlainDate | null;
				if (from !== null && to !== null && to < (from as string))
					errors.push({ row: i + 2, column: `${c.name}.to`, message: 'ends before it starts' });
				row[c.name] = from === null ? null : { from, to };
			} else row[c.name] = read(c.name, c, c.optional);
		}
		if (errors.length === before) rows.push(row as RowOf<C>);
	});
	return { rows, errors };
}

/** Cells from rows: the header, then one line per row (a period as its two cells, a decimal as its exact text). */
export function encode<const C extends Spec>(
	rows: readonly NoInfer<RowOf<C>>[],
	cols: C
): Cell[][] {
	const columns = columnsOf(cols);
	const out = (v: unknown): Cell =>
		v === null || v === undefined ? null : v instanceof Decimal ? v.toString() : (v as Cell);
	return [
		columns.flatMap(headersOf),
		...rows.map((r) =>
			columns.flatMap((c): Cell[] => {
				const v = (r as Record<string, unknown>)[c.name];
				if (c.kind === 'period') {
					const p = v as DatePeriod | null;
					return [p?.from ?? null, p?.to ?? null];
				}
				return [out(v)];
			})
		)
	];
}
