// A file sync's built-in parsers (spec §3.3), run on the host: an uploaded file's bytes as records of the sync's columns
// (its `schema`, else the model's writable fields), each with `$at` (its sheet row or line) so findings point at it. A
// header or key matches a column's name or `label`, any case; an unknown one is ignored. A custom parser runs in the guest
// (`sync/file.ts`); this module only says which parser an upload is read with.
import { Array as EffectArray, Result, Schema } from 'effect';
import { csvDelimiter, csvRows, csvText } from '@norbital-ai/std/csv';
import { isPlainDate } from '@norbital-ai/std/date';
import { utcOf } from '@norbital-ai/std/zone';
import type { InputFields, InputKind } from '../../decl/fields.ts';
import type { SyncEntry } from '../../decl/model.ts';
import type { BuiltinParser, Finding } from '../../decl/runtime/sync.ts';
import type { Json } from '../../decl/values.ts';
import { xlsxCells, type Cell } from './xlsx.ts';

/** One entry of a file sync's `parser` list: a built-in's name, or a custom parser's media type and extensions. */
export type Parser = NonNullable<SyncEntry['parser']>[number];
type Obj = { readonly [field: string]: Json };
/** Parsed records (each carries `$at`) and what kept a file from parsing (a missing column, a file that is no such format). */
export type Parsed = { readonly records: readonly Obj[]; readonly findings: readonly Finding[] };

/** Each built-in's media type and extension: what the upload accepts for it, and what an export of it is stored as. */
export const BUILTIN: {
	readonly [P in BuiltinParser]: { readonly mime: string; readonly extension: `.${string}` };
} = {
	xlsx: {
		mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		extension: '.xlsx'
	},
	csv: { mime: 'text/csv', extension: '.csv' },
	tsv: { mime: 'text/tab-separated-values', extension: '.tsv' },
	json: { mime: 'application/json', extension: '.json' },
	ics: { mime: 'text/calendar', extension: '.ics' }
};
export const isBuiltin = (p: Parser): p is BuiltinParser =>
	typeof p === 'string' && Object.hasOwn(BUILTIN, p);
/** A file sync's parsers: its `parser` list, `['xlsx', 'csv']` when it declares none. */
export const parsersOf = (entry: Pick<SyncEntry, 'parser'>): readonly Parser[] =>
	entry.parser ?? ['xlsx', 'csv'];
const accepted = (p: Parser): { types: readonly string[]; extensions: readonly string[] } =>
	typeof p !== 'string'
		? { types: [p.type], extensions: p.extensions }
		: isBuiltin(p)
			? { types: [BUILTIN[p].mime], extensions: [BUILTIN[p].extension] }
			: { types: [], extensions: [] };
/**
 * The parser an upload is read with: the first whose extension ends the file's name, else the first whose media type it
 * was sent as (browsers send none, or a wrong one, for many extensions); `undefined` is a file the sync does not accept.
 */
export function parserFor(
	parsers: readonly Parser[],
	name: string,
	mime: string
): Parser | undefined {
	const file = name.toLowerCase(),
		type = (mime.split(';')[0] ?? '').trim().toLowerCase();
	return (
		parsers.find((p) => accepted(p).extensions.some((e) => file.endsWith(e.toLowerCase()))) ??
		parsers.find((p) => accepted(p).types.some((t) => t.toLowerCase() === type))
	);
}
/** What a file sync's upload accepts, as an `<input accept>` list: extensions, then media types. */
export const acceptOf = (parsers: readonly Parser[]): string =>
	[
		...new Set(
			parsers.flatMap((p) => {
				const a = accepted(p);
				return [...a.extensions, ...a.types];
			})
		)
	].join(',');

/** A column's header: its label, else its name. */
export const headerOf = (field: string, kind: InputKind): string => kind.label ?? field;
/** A header or key's column, by name or label, any case (a name wins over another column's label). */
function columnOf(columns: InputFields): (header: string) => string | undefined {
	const names = new Map<string, string>();
	for (const [f, k] of Object.entries(columns))
		if (k.label !== undefined) names.set(k.label.trim().toLowerCase(), f);
	for (const f of Object.keys(columns)) names.set(f.toLowerCase(), f);
	return (header) => names.get(header.trim().toLowerCase());
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30),
	DAY = 86_400_000;
const ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/i;
/**
 * A sheet cell as its column's kind takes it: numbers and booleans as such (from text too), an Excel date, time or
 * date-time serial as its date, time or instant (a serial is wall time in `tz`), the rest as trimmed text.
 */
function valueOf(k: InputKind, c: Exclude<Cell, null>, tz: string): Json {
	const text = typeof c === 'string' ? c.trim() : String(c);
	if (k.kind === 'int' || k.kind === 'number')
		return typeof c === 'number'
			? c
			: text !== '' && Number.isFinite(Number(text))
				? Number(text)
				: text;
	if (k.kind === 'bool')
		return typeof c === 'boolean'
			? c
			: /^(true|yes|y|1)$/i.test(text)
				? true
				: /^(false|no|n|0)$/i.test(text)
					? false
					: text;
	if (k.kind === 'date' && typeof c === 'number')
		return new Date(EXCEL_EPOCH + Math.floor(c) * DAY).toISOString().slice(0, 10);
	if (k.kind === 'date' && isPlainDate(text.slice(0, 10)) && ISO_INSTANT.test(text))
		return text.slice(0, 10);
	if (k.kind === 'time' && typeof c === 'number') {
		const m = Math.round((c % 1) * 1440);
		return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
	}
	if (k.kind === 'instant' && typeof c === 'number') {
		const date = new Date(EXCEL_EPOCH + Math.floor(c) * DAY).toISOString().slice(0, 10);
		return new Date(utcOf(date, Math.round((c % 1) * 86_400) * 1000, tz)).toISOString();
	}
	return text;
}

/** Row 1 is the header; each later row with a value is a record whose `$at` is its row. */
function fromTable(
	cells: readonly (readonly Cell[])[],
	columns: InputFields,
	required: readonly string[],
	tz: string
): Parsed {
	const column = columnOf(columns);
	const header = (cells[0] ?? []).map((h) => (h === null ? undefined : column(String(h))));
	const missing = required.filter((f) => !header.includes(f));
	if (missing.length > 0)
		return {
			records: [],
			findings: missing.flatMap((f) => {
				const k = columns[f];
				return k === undefined
					? []
					: [
							{
								at: 1,
								field: headerOf(f, k),
								message: 'The file has no such column.',
								severity: 'refuse' as const
							}
						];
			})
		};
	const records: Obj[] = [];
	cells.forEach((line, i) => {
		if (i === 0) return;
		const r: { [f: string]: Json } = {};
		header.forEach((f, x) => {
			const c = line[x],
				k = f === undefined ? undefined : columns[f];
			if (f === undefined || k === undefined || c === null || c === undefined) return;
			if (typeof c === 'string' && c.trim() === '') return;
			r[f] = valueOf(k, c, tz);
		});
		if (Object.keys(r).length > 0) records.push({ ...r, $at: i + 1 });
	});
	return { records, findings: [] };
}

const isObj = (v: Json): v is Obj => v !== null && typeof v === 'object' && !EffectArray.isArray(v);
const notParsed = (message: string): Parsed => ({
	records: [],
	findings: [{ at: 0, message, severity: 'refuse' }]
});
/** An array of records, or `{ "records": [...] }`; a record's `$at` is its place in the list (from 1). */
function fromJson(text: string, columns: InputFields): Parsed {
	const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(text);
	if (Result.isFailure(decoded)) return notParsed('The file is not JSON.');
	const value: Json = decoded.success;
	const list = EffectArray.isArray<typeof value>(value)
		? value
		: isObj(value) && EffectArray.isArray<Json | undefined>(value['records'])
			? value['records']
			: null;
	if (list === null)
		return notParsed('A JSON file holds a list of records, or { "records": [...] }.');
	const column = columnOf(columns),
		records: Obj[] = [],
		findings: Finding[] = [];
	list.forEach((item, i) => {
		if (!isObj(item)) {
			findings.push({ at: i + 1, message: 'This is not a record.', severity: 'refuse' });
			return;
		}
		const r: { [f: string]: Json } = {};
		for (const [key, v] of Object.entries(item)) {
			const f = column(key);
			if (f !== undefined) r[f] = v;
		}
		records.push({ ...r, $at: i + 1 });
	});
	return { records, findings };
}

const ICS_DATE = /^(\d{4})(\d{2})(\d{2})$/,
	ICS_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
/** One content line: `NAME;PARAM=V;…:VALUE` (a quoted parameter may hold `:`). */
function icsProperty(
	line: string
): { name: string; params: ReadonlyMap<string, string>; value: string } | null {
	let quoted = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') quoted = !quoted;
		else if (ch === ':' && !quoted) {
			// ponytail: a quoted parameter value holding ';' splits; none of the parameters read here (TZID, VALUE) do
			const [name = '', ...params] = line.slice(0, i).split(';');
			return {
				name,
				params: new Map(
					params.map((p) => {
						const eq = p.indexOf('=');
						return [p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, '')] as const;
					})
				),
				value: line.slice(i + 1)
			};
		}
	}
	return null;
}
/** A date as `YYYY-MM-DD`; a date-time as an instant (UTC with `Z`, else in its `TZID`, else floating in `tz`); text unescaped. */
function icsValue(p: { params: ReadonlyMap<string, string>; value: string }, tz: string): Json {
	const d = ICS_DATE.exec(p.value);
	if (d !== null) return `${d[1]}-${d[2]}-${d[3]}`;
	const t = ICS_TIME.exec(p.value);
	if (t !== null) {
		const date = `${t[1]}-${t[2]}-${t[3]}`,
			ms = ((Number(t[4]) * 60 + Number(t[5])) * 60 + Number(t[6])) * 1000;
		return new Date(
			t[7] === 'Z'
				? Date.parse(`${date}T00:00:00Z`) + ms
				: utcOf(date, ms, p.params.get('TZID') ?? tz)
		).toISOString();
	}
	return p.value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}
/**
 * iCalendar (RFC 5545): each `VEVENT` is a record of its properties (named in lower case: `uid`, `summary`, `dtstart`,
 * `dtend`, `location`, …) whose `$at` is its `BEGIN:VEVENT` line; nested components (alarms) are skipped.
 * ponytail: a repeated property (ATTENDEE, CATEGORIES) keeps its last value; a schema field needing all of them needs a custom parser.
 */
function fromIcs(text: string, columns: InputFields, tz: string): Parsed {
	const column = columnOf(columns),
		lines: { text: string; at: number }[] = [];
	text.split(/\r\n|\n|\r/).forEach((l, i) => {
		const last = lines.at(-1);
		if ((l.startsWith(' ') || l.startsWith('\t')) && last !== undefined) last.text += l.slice(1);
		else lines.push({ text: l, at: i + 1 });
	});
	const records: Obj[] = [];
	let event: { [f: string]: Json } | null = null,
		at = 0,
		depth = 0;
	for (const line of lines) {
		const upper = line.text.trim().toUpperCase();
		if (upper === 'BEGIN:VEVENT') {
			event = {};
			at = line.at;
			depth = 0;
		} else if (event === null) continue;
		else if (upper.startsWith('BEGIN:')) depth++;
		else if (upper.startsWith('END:') && depth > 0) depth--;
		else if (upper === 'END:VEVENT') {
			if (Object.keys(event).length > 0) records.push({ ...event, $at: at });
			event = null;
		} else if (depth === 0) {
			const p = icsProperty(line.text),
				f = p === null ? undefined : column(p.name);
			if (p !== null && f !== undefined) event[f] = icsValue(p, tz);
		}
	}
	return { records, findings: [] };
}

/**
 * A file's records by a built-in parser, against `columns`: `required` columns a sheet's header must name, `tz` the zone
 * a sheet's date-time serial or an iCalendar floating time is read in. A file that is no such format is one `refuse`
 * finding at 0 (the file as a whole).
 */
export function parseBuiltin(
	parser: BuiltinParser,
	bytes: Uint8Array,
	columns: InputFields,
	options: { readonly required: readonly string[]; readonly tz: string }
): Parsed {
	const parsed = Result.try(() => {
		switch (parser) {
			case 'xlsx':
				return fromTable(xlsxCells(bytes), columns, options.required, options.tz);
			case 'csv':
			case 'tsv': {
				const text = csvText(bytes);
				return fromTable(
					csvRows(text, parser === 'tsv' ? '\t' : csvDelimiter(text)),
					columns,
					options.required,
					options.tz
				);
			}
			case 'json':
				return fromJson(csvText(bytes), columns);
			case 'ics':
				return fromIcs(csvText(bytes), columns, options.tz);
		}
	});
	return Result.isSuccess(parsed)
		? parsed.success
		: notParsed(
				`The file is not a readable ${parser} file${parsed.failure instanceof Error ? `: ${parsed.failure.message}` : ''}.`
			);
}
