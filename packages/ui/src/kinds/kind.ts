import { Array as Arr } from 'effect';
// Field kinds as the ui sees them (§3.3.2): the literal a model or an input declares, structurally, so ui needs no bolt
// dependency. Pure functions only: display text, text parsing, advisory checks and empty values. The host decides; these
// only keep a form from sending what decode would refuse (rule 23), with the same messages.
import { Predicate } from 'effect';

import { Decimal } from '@norbital-ai/std/decimal';
import type { Fields, FileRef, Json, Kind, KindOf, Point, Value } from '@norbital-ai/std/kind';
import { inputSchema } from '@norbital-ai/std/kind';
import { Schema, Result } from 'effect';
import { KINDS, sortable } from './registry.js';
export type { Fields, FileRef, Json, Kind, KindOf, Point, Value };

/** The custom renderer registered for a built-in or tenant field. */
export function fieldName(kind: Kind): string | undefined {
	if (kind.kind === 'custom') return kind.of;
	if (kind.kind === 'money' || kind.kind === 'file' || kind.kind === 'point') return kind.kind;
	if (kind.kind === 'sum' && 'money' in kind && kind.money !== undefined) return 'money';
	return kind.kind === 'text' && kind.format === 'phone' && kind.many !== true
		? 'phone'
		: undefined;
}
export const isFile: (v: unknown) => v is FileRef = Schema.is(
	Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
);
export const isPoint: (v: unknown) => v is Point = Schema.is(
	Schema.Struct({ lat: Schema.Number, lng: Schema.Number })
);

// ── money ──
/** ISO 4217 minor digits from the platform's own table (JPY 0, SGD 2, BHD 3). */
export function minorDigits(currency: string): number {
	return Result.getOrElse(
		Result.try(
			() =>
				new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
					.maximumFractionDigits ?? 2
		),
		() => 2
	);
}
/** A money field's currency: the literal code, the named sibling field's value, or the workspace default (X-8). */
export function currencyOf(
	kind: KindOf<'money'>,
	row: { readonly [f: string]: unknown } = {},
	fallback?: string
): string | undefined {
	const c = kind.currency;
	if (c === undefined) return fallback;
	if (/^[A-Z]{3}$/.test(c)) return c;
	const v = row[c];
	return typeof v === 'string' ? v : fallback;
}

// ── durations: whole seconds, typed as `1h 30m`, `90m`, `45s` or a bare number of minutes ──
const UNITS: readonly [string, number][] = [
	['d', 86_400],
	['h', 3_600],
	['m', 60],
	['s', 1]
];
export function formatDuration(seconds: number): string {
	if (seconds === 0) return '0m';
	let rest = Math.abs(seconds);
	const parts: string[] = [];
	for (const [u, n] of UNITS)
		if (rest >= n) {
			parts.push(`${Math.floor(rest / n)}${u}`);
			rest %= n;
		}
	return (seconds < 0 ? '-' : '') + parts.join(' ');
}
function parseDuration(text: string): number | null {
	const t = text.trim().toLowerCase();
	if (/^-?\d+$/.test(t)) return Number(t) * 60;
	const re = /(\d+(?:\.\d+)?)\s*(d|h|min|m|s)/g;
	let total = 0,
		seen = '',
		m: RegExpExecArray | null;
	while ((m = re.exec(t)) !== null) {
		const symbol = m[2] === 'min' ? 'm' : m[2];
		const unit = UNITS.find(([name]) => name === symbol);
		if (unit === undefined) return null;
		total += Number(m[1]) * unit[1];
		seen += m[0];
	}
	return seen.replace(/\s/g, '') === t.replace(/\s/g, '') && seen !== '' ? Math.round(total) : null;
}

// ── points: "lat, lng" typed, or picked; never needs a provider (P19) ──
export function parsePoint(text: string): Point | null {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
	if (m === null) return null;
	const p = { lat: Number(m[1]), lng: Number(m[2]) };
	return validPoint(p) ? p : null;
}
const validPoint = (p: Point) =>
	Number.isFinite(p.lat) &&
	Number.isFinite(p.lng) &&
	Math.abs(p.lat) <= 90 &&
	Math.abs(p.lng) <= 180;
export const formatPoint = (p: Point) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

// ── files: `accept` and `max` are checked before bytes leave the browser (the host checks again) ──
export function sizeBytes(size: string): number {
	const m = /^(\d+)(KiB|MiB)$/.exec(size);
	return m === null ? Infinity : Number(m[1]) * (m[2] === 'KiB' ? 1024 : 1024 * 1024);
}
export function fileProblem(
	kind: KindOf<'file'>,
	file: { readonly type: string; readonly size: number; readonly name: string }
): string | null {
	const ok = kind.accept.some(
		(p) =>
			p === '*/*' || (p.endsWith('/*') ? file.type.startsWith(p.slice(0, -1)) : file.type === p)
	);
	if (!ok) return `${file.name}: expected ${kind.accept.join(', ')}`;
	if (file.size > sizeBytes(kind.max)) return `${file.name}: over ${kind.max}`;
	return null;
}
/** Rule 72: at most 20 files per field. */
export const MAX_FILES = 20;

// ── enum and state values: the catalog's words, else the value in words ──
/** Where an enum or state value's catalog key is: `models.<model>.fields.<field>.<value>`, read through `t`. */
export type EnumScope = { t?: (key: string) => string; model?: string; field?: string };
/**
 * An enum or state value as words: its catalog key, else humanized (`not_sent` → `Not sent`, `PENDING_REVIEW` →
 * `Pending review`). An upper-case word without a vowel or with a digit stays an acronym (`SG_CPF` → `SG CPF`), as does
 * an upper-case word inside a lower-case value (`sent_to_HR`).
 */
export function enumText(value: string, o: EnumScope = {}): string {
	if (o.t !== undefined && o.model && o.field) {
		const key = `models.${o.model}.fields.${o.field}.${value}`,
			s = o.t(key);
		if (s !== key) return s;
	}
	const caps = value === value.toUpperCase();
	const s = value
		.split(/[_\s.-]+/)
		.filter(Boolean)
		.map((w) =>
			w.length > 1 && /^[A-Z0-9]+$/.test(w) && (!caps || /\d/.test(w) || !/[AEIOUY]/.test(w))
				? w
				: w.toLowerCase()
		)
		.join(' ');
	return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── display ──
/** How `format` renders a value: the enum's model and field for catalog labels, the locale, the default currency and the zone. */
export type ShowOptions = EnumScope & { locale?: string; currency?: string; zone?: string };
/** Instants read as a medium date and a short time, never seconds. */
const AT = { dateStyle: 'medium', timeStyle: 'short' } as const;
/** A `sum` of a money field (`money`, set by the boot) reads as money in that currency, else the workspace's; any other kind is itself. */
export const shownKind = (kind: Kind): Kind =>
	kind.kind === 'sum' && kind.money !== undefined
		? {
				kind: 'money',
				...(kind.money.currency === undefined ? {} : { currency: kind.money.currency })
			}
		: kind;
/** A `Value` that is a plain object (not a list, not a `Decimal`): the one narrowing of the union's object arm. */
export const valueObject = (v: Value | undefined): v is { readonly [k: string]: Value } =>
	typeof v === 'object' && v !== null && !Arr.isArray<Value>(v) && !(v instanceof Decimal);
/**
 * The kind an undeclared JSON value shows as: scalars by their type, objects field by field, and a list of objects as
 * one object kind over every key its items hold (so it shows as a table).
 */
export function inferKind(v: Value): Kind {
	if (typeof v === 'string') return { kind: 'text' };
	if (typeof v === 'number') return { kind: 'number' };
	if (typeof v === 'boolean') return { kind: 'bool' };
	if (Arr.isArray<Value>(v)) {
		if (v.length === 0 || !v.every(valueObject)) return { kind: 'list', of: { kind: 'json' } };
		const fields: { [k: string]: Kind } = {};
		for (const item of v)
			for (const [k, held] of Object.entries(item))
				if (fields[k] === undefined || held !== null) fields[k] = inferKind(held);
		return { kind: 'list', of: { kind: 'object', fields } };
	}
	if (valueObject(v))
		return {
			kind: 'object',
			fields: Object.fromEntries(Object.entries(v).map(([k, held]) => [k, inferKind(held)]))
		};
	return { kind: 'json' };
}
/** Whether a value of this kind needs a whole row: structures, maps, code and long-form text. */
export const wideKind = (kind: Kind): boolean =>
	(kind.kind === 'list' && wideKind(kind.of)) ||
	['object', 'record', 'union', 'json', 'custom', 'point'].includes(kind.kind) ||
	(kind.kind === 'text' && (kind.format === 'cel' || kind.format === 'markdown'));

/** Named fields of a row as one line by kind (a record's title, a subtitle): `Q-1 · Jan 2, 2026 · On hold`; empties left out. */
export function fieldsText(
	fields: Fields,
	row: { readonly [f: string]: Value | undefined },
	names: readonly string[],
	o: ShowOptions = {}
): string {
	return names
		.map((f) => {
			const kind = shownKind(fields[f] ?? { kind: 'text' });
			const currency = kind.kind === 'money' ? currencyOf(kind, row, o.currency) : o.currency;
			return format(kind, row[f] ?? null, {
				...o,
				field: f,
				...(currency === undefined ? {} : { currency })
			});
		})
		.filter(Boolean)
		.join(' · ');
}
/** One value as text in the viewer's locale; '' for none. Structured values render through `Show`, this is their summary. */
export function format(kind: Kind, value: Value | undefined, o: ShowOptions = {}): string {
	const v = value ?? null;
	const locale = o.locale ?? 'en';
	if (v === null) return '';
	switch (kind.kind) {
		case 'int':
		case 'number':
		case 'count':
			return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : String(v);
		case 'decimal':
		case 'sum':
			return decimalText(String(v), locale);
		case 'money': {
			const c = o.currency;
			// a money with no currency (none on the row, none in the workspace) still reads at the common minor unit, 5,884.70
			return c === undefined ? decimalText(String(v), locale, 2) : moneyText(String(v), c, locale);
		}
		case 'bool':
			return v === true ? '✓' : '✗';
		// a year or a month shows as one (its stored first day would read as a day)
		case 'date':
			return kind.precision === 'year'
				? String(v).slice(0, 4)
				: kind.precision === 'month'
					? new Date(`${String(v).slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(locale, {
							timeZone: 'UTC',
							month: 'long',
							year: 'numeric'
						})
					: dateText(String(v), locale);
		case 'instant':
			return instantText(String(v), locale, o.zone, kind.precision);
		case 'time':
			return String(v).slice(0, kind.precision === 'hour' ? 2 : 5);
		case 'duration':
			return typeof v === 'number' ? formatDuration(v) : String(v);
		case 'period': {
			if (!valueObject(v)) return '';
			const temporal: Kind =
				kind.of === 'date'
					? { kind: 'date', ...(kind.precision === undefined ? {} : { precision: kind.precision }) }
					: {
							kind: 'instant',
							...(kind.precision === undefined ? {} : { precision: kind.precision })
						};
			const at = (x: Value | undefined) =>
				x === null || x === undefined ? '…' : format(temporal, x, o);
			const end = v[kind.of === 'date' ? 'to' : 'end'];
			// Instant periods exclude their end; coarse labels name the last covered unit.
			const last =
				kind.of === 'instant' &&
				kind.precision &&
				typeof end === 'string' &&
				Number.isFinite(Date.parse(end))
					? new Date(Date.parse(end) - 1).toISOString()
					: end;
			const from = at(v[kind.of === 'date' ? 'from' : 'start']),
				to = at(last);
			return (kind.precision === 'month' || kind.precision === 'year') &&
				from === to &&
				from !== '…'
				? from
				: `${from} – ${to}`;
		}
		case 'enum':
		case 'state':
			return (Arr.isArray(v) ? v : [v]).map((x) => enumText(String(x), o)).join(', ');
		case 'text':
			return Arr.isArray(v) ? v.join(', ') : String(v);
		case 'point':
			return isPoint(v) ? formatPoint(v) : '';
		case 'file':
			return (Arr.isArray(v) ? v : [v])
				.filter(isFile)
				.map((f) => f.name)
				.join(', ');
		case 'vector':
			return Arr.isArray(v) ? `[${v.length}]` : '';
		case 'list':
			return Arr.isArray<Value>(v) ? v.map((x) => format(kind.of, x, o)).join(', ') : '';
		case 'json':
		case 'custom':
		case 'object':
		case 'union':
		case 'record':
			return valueObject(v) && typeof v['label'] === 'string' ? v['label'] : JSON.stringify(v);
		default:
			return String(v);
	}
}
/** One native value as text, shared by views and kind renderers. */
export function formatValue(value: Value | undefined, locale = 'en'): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Decimal) return decimalText(String(value), locale);
	if (typeof value === 'boolean') return value ? '✓' : '✗';
	if (typeof value === 'number') return new Intl.NumberFormat(locale).format(value);
	if (typeof value === 'string')
		return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)
			? new Date(value).toLocaleString(locale, AT)
			: value;
	if (Arr.isArray<Value>(value)) return value.map((item) => formatValue(item, locale)).join(', ');
	if (!valueObject(value)) return String(value);
	if ('from' in value || 'start' in value)
		return `${formatValue(value['from'] ?? value['start'], locale)} – ${formatValue(value['to'] ?? value['end'], locale) || '…'}`;
	if (isPoint(value)) return `${value.lat}, ${value.lng}`;
	if (isFile(value)) return value.name;
	if ('model' in value && typeof value['id'] === 'string') return value['id'];
	return JSON.stringify(value);
}
function decimalText(s: string, locale: string, pad = 0): string {
	// exact: format the integer part through Intl, keep the fraction digits as written, trailing zeros trimmed (money pads to its minor digits)
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
	if (m === null) return s;
	const frac = (m[3] ?? '').replace(/0+$/, '').padEnd(pad, '0');
	const sep =
		new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ??
		'.';
	return `${m[1]}${new Intl.NumberFormat(locale).format(BigInt(m[2] ?? '0'))}${frac === '' ? '' : sep + frac}`;
}
/** Money reads the same everywhere: `SGD 1,234.50`, the code, a space, the amount at the currency's minor digits. */
const moneyText = (s: string, currency: string, locale: string) =>
	`${currency} ${decimalText(s, locale, minorDigits(currency))}`;
function instantText(s: string, locale: string, zone?: string, precision?: string): string {
	const options: Intl.DateTimeFormatOptions =
		precision === 'year'
			? { year: 'numeric' }
			: precision === 'month'
				? { year: 'numeric', month: 'long' }
				: precision === 'day' || precision === 'week'
					? { dateStyle: 'medium' }
					: precision === 'hour'
						? { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric' }
						: AT;
	return new Date(s).toLocaleString(locale, { ...options, ...(zone ? { timeZone: zone } : {}) });
}
function dateText(s: string, locale: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (m === null) return s;
	// a calendar date has no zone: format it at UTC so it never shifts a day
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
		locale,
		{ timeZone: 'UTC', dateStyle: 'medium' }
	);
}

// ── parsing typed text (text-shaped editors) ──
export type Parsed = { value: Value } | { error: string };
export function parse(kind: Kind, text: string): Parsed {
	const t = text.trim();
	if (t === '') return { value: null };
	switch (kind.kind) {
		case 'int':
			return /^-?\d+$/.test(t) ? { value: Number(t) } : { error: 'expected an integer' };
		case 'number':
			return Number.isFinite(Number(t)) ? { value: Number(t) } : { error: 'expected a number' };
		case 'decimal':
		case 'money': {
			const s = t.replace(/[,\s_]/g, '');
			if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: 'expected a decimal' };
			const scale = kind.kind === 'decimal' ? kind.scale : undefined;
			if (scale !== undefined && (s.split('.')[1]?.length ?? 0) > scale)
				return { error: `at most ${scale} decimal places` };
			return { value: Decimal.of(s) };
		}
		case 'duration': {
			const n = parseDuration(t);
			return n === null ? { error: 'expected a duration like 1h 30m' } : { value: n };
		}
		case 'point': {
			const p = parsePoint(t);
			return p === null ? { error: 'expected latitude, longitude' } : { value: p };
		}
		default:
			return { value: t };
	}
}
/** A money amount's minor-unit check, or its declared scale's (the column's CHECK, rule 68). */
export function moneyProblem(
	amount: string,
	currency: string | undefined,
	scale?: number
): string | null {
	const places = amount.split('.')[1]?.replace(/0+$/, '').length ?? 0;
	if (scale !== undefined) return places > scale ? `at most ${scale} decimal places` : null;
	if (currency === undefined) return null;
	const d = minorDigits(currency);
	return places > d ? `${currency} has ${d} decimal places` : null;
}

// ── advisory validation, same wording as decode ──
/** Whether a field must be given a value: not optional, no default fills it, and neither derived nor a state's. */
export const required = (kind: Kind): boolean =>
	kind.optional !== true &&
	kind.default === undefined &&
	!KINDS[kind.kind].derived &&
	kind.kind !== 'state';
export function problem(kind: Kind, value: Value | undefined): string | null {
	const v = value ?? null;
	if (
		v === null ||
		(Arr.isArray<Value>(v) && v.length === 0 && (kind.kind === 'file' || kind.kind === 'list'))
	) {
		if (!required(kind)) return null;
		return kind.kind === 'list' && (kind.min ?? 0) === 0 && v !== null ? null : 'is required';
	}
	const range = (n: number, k: { min?: number; max?: number }) =>
		(k.min !== undefined && n < k.min) || (k.max !== undefined && n > k.max)
			? 'is out of range'
			: null;
	switch (kind.kind) {
		case 'text':
			if (kind.many) return Arr.isArray<Value>(v) ? null : 'expected a list of text';
			if (typeof v !== 'string') return 'expected text';
			if (kind.max !== undefined && v.length > kind.max) return `is over ${kind.max} characters`;
			if (kind.format === 'email' && !/^[^@\s]+@[^@\s]+$/.test(v))
				return 'expected an email address';
			if (kind.format === 'url' && !URL.canParse(v)) return 'expected a URL';
			if (kind.format === 'phone' && !/^\+?[\d\s()-]{5,}$/.test(v))
				return 'expected a phone number';
			return null;
		case 'int':
			return typeof v !== 'number' || !Number.isInteger(v) ? 'expected an integer' : range(v, kind);
		case 'number':
			return typeof v !== 'number' || !Number.isFinite(v) ? 'expected a number' : range(v, kind);
		case 'decimal': {
			const p = parse(kind, String(v));
			return 'error' in p ? p.error : range(Number(String(v)), kind);
		}
		case 'money':
			return /^-?\d+(\.\d+)?$/.test(String(v)) ? null : 'expected a decimal';
		case 'date':
			return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? null : 'expected a date (YYYY-MM-DD)';
		case 'instant':
			return Number.isNaN(Date.parse(String(v))) ? 'expected an instant' : null;
		case 'enum': {
			const ok = (x: Value) => kind.values.includes(String(x));
			return (kind.many ? Arr.isArray<Value>(v) && v.every(ok) : ok(v))
				? null
				: `expected one of ${kind.values.join(', ')}`;
		}
		case 'period': {
			if (!valueObject(v)) return 'expected a period';
			const [a, b] = kind.of === 'date' ? [v['from'], v['to']] : [v['start'], v['end']];
			if (a === null || a === undefined) return 'needs a start';
			// empty or inverted periods are refused (rule 68): a date period is inclusive, an instant one closed-open
			if (
				b !== null &&
				b !== undefined &&
				(kind.of === 'date'
					? String(b) < String(a)
					: Date.parse(String(b)) <= Date.parse(String(a)))
			)
				return 'ends before it starts';
			return null;
		}
		case 'point':
			return isPoint(v) && validPoint(v) ? null : 'expected latitude, longitude';
		case 'file':
			return (Arr.isArray<Value>(v) ? v.length > MAX_FILES : false)
				? `at most ${MAX_FILES} files`
				: null;
		case 'list':
			if (!Arr.isArray<Value>(v)) return 'expected a list';
			return (kind.min !== undefined && v.length < kind.min) ||
				(kind.max !== undefined && v.length > kind.max)
				? 'has the wrong number of items'
				: null;
		default:
			return null;
	}
}
/** Every problem of a structured value by dotted path (`lines.0.amount`), as decode reports them. */
export function problems(kind: Kind, value: Value | undefined, at = ''): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (k: Kind, v: Value | undefined, path: string) => {
		const p = problem(k, v);
		if (p !== null) {
			out.set(path, p);
			return;
		}
		const x = v ?? null;
		if (x === null) return;
		const object = valueObject(x) ? x : null;
		const join = (key: string | number) => (path === '' ? String(key) : `${path}.${key}`);
		if (k.kind === 'object' && object !== null)
			for (const [f, fk] of Object.entries(k.fields)) walk(fk, object[f], join(f));
		else if (k.kind === 'json' && k.shape !== undefined) walk(k.shape, x, path);
		else if (k.kind === 'list' && Arr.isArray<Value>(x))
			x.forEach((item, i) => walk(k.of, item, join(i)));
		else if (k.kind === 'record' && object !== null)
			for (const [key, item] of Object.entries(object)) walk(k.of, item, join(key));
		else if (k.kind === 'union' && 'arms' in k && object !== null) {
			const arm = k.arms[String(object[k.by])];
			if (arm === undefined)
				out.set(join(k.by), `expected one of ${Object.keys(k.arms).join(', ')}`);
			else for (const [f, fk] of Object.entries(arm)) walk(fk, object[f], join(f));
		}
	};
	walk(kind, value, at);
	return out;
}

/** The value a new form starts from: the literal default, else empty (a clock `{ var }` default fails its kind's decode and stays to the host). */
export function initial(kind: Kind): Value {
	const d = kind.default;
	if (d !== undefined) {
		const schema = inputSchema(kind);
		if (Schema.is(schema)(d)) return d;
		const result = Schema.decodeUnknownResult(schema)(d);
		if (Result.isSuccess(result)) return result.success;
	}
	switch (kind.kind) {
		case 'state':
			return kind.initial;
		case 'list':
			return [];
		case 'text':
			return kind.many ? [] : null;
		case 'enum':
			return kind.many ? [] : null;
		case 'object':
			return kind.optional
				? null
				: Object.fromEntries(Object.entries(kind.fields).map(([f, k]) => [f, initial(k)]));
		case 'record':
			return kind.optional ? null : {};
		case 'bool':
			return kind.optional ? null : false;
		default:
			return null;
	}
}
/** A union value switched to another arm: the tag, then each of that arm's fields at its initial value. */
export function armValue(kind: Extract<KindOf<'union'>, { by: string }>, tag: string): Value {
	return {
		[kind.by]: tag,
		...Object.fromEntries(Object.entries(kind.arms[tag] ?? {}).map(([f, k]) => [f, initial(k)]))
	};
}

/** An arc's value (a polymorphic relation): `{ model, id }`, as the engine reads and writes it. */
export const arcOf = (x: Value | undefined): { model: string; id: string } | null =>
	valueObject(x) && typeof x['model'] === 'string' && typeof x['id'] === 'string'
		? { model: x['model'], id: x['id'] }
		: null;
/** State edges out of `from` (the state machine's `to`), for a badge's move menu. */
export const edgesFrom = (kind: KindOf<'state'>, from: string): readonly string[] =>
	kind.states[from]?.to ?? [];
/** Whether `field` may change while the row is in `state` (the state's `edit` list); advice, the host enforces it. */
export function editable(kind: KindOf<'state'>, state: string, field: string): boolean {
	const e = kind.states[state]?.edit ?? 'all';
	return e === 'all' ? true : e === 'none' ? false : e.includes(field);
}
/** A stable tone per state name, so the same state reads the same colour on every page. */
const SUCCESS = /^(approv|done|complet|paid|won|closed|activ|sealed|sent|accept|confirm|deliver)/;
export function tone(state: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
	const words = state
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	const any = (re: RegExp) => words.some((w) => re.test(w));
	// a negation first, so `inactive`, `unpaid` and `not_sent` never read as a success
	if (
		words.some(
			(w) =>
				w === 'not' ||
				w === 'non' ||
				(/^(un|in|non)/.test(w) && SUCCESS.test(w.replace(/^(un|in|non)/, '')))
		)
	)
		return 'neutral';
	if (any(/^(draft|new|open$|pending|queued|skip)/)) return 'neutral'; // `open`, never `opened` (an email read)
	if (any(/^(reject|cancel|void|fail|lost|declin|terminat|block|bounc|complain|undeliver)/))
		return 'danger';
	if (any(SUCCESS)) return 'success';
	if (any(/^(hold|review|wait|overdue|expir|chang|defer)/)) return 'warning';
	return 'info';
}

/** `like` over the label's text and patterned `seq` fields: the search of a model that declares no `search.text`; none when nothing is typed or searchable. */
export const likePattern = (text: string): string =>
	`%${text
		.trim()
		.split(/\s+/)
		.map((word) => word.replace(/[%_\\]/g, '\\$&'))
		.join('%')}%`;
export function likeWhere(
	target: { readonly fields: Fields } | undefined,
	labels: readonly string[],
	q: string
): Json | undefined {
	const text = q.trim();
	const searchable = labels.filter((f) => {
		const k = target?.fields[f];
		return k === undefined || k.kind === 'text' || (k.kind === 'seq' && k.pattern !== undefined);
	});
	return text === '' || searchable.length === 0
		? undefined
		: { or: searchable.map((f) => ({ [f]: { like: likePattern(text) } })) };
}
/**
 * A picker's read request root layer (`query({ [of]: pickerRead(…) })`, §3.6): the target's `search.text` when it declares one, else `like` over the label's text and
 * patterned `seq` fields; sorted by `orderBy`, else by the first sortable label field (a typed search ranks instead).
 */
export function pickerRead(
	target: { readonly search?: readonly string[]; readonly fields: Fields } | undefined,
	labels: readonly string[],
	o: { where?: Json | undefined; orderBy?: Json | undefined; limit: number },
	q: string
): { readonly [k: string]: Json } {
	const text = q.trim(),
		indexed = (target?.search?.length ?? 0) > 0;
	const w = indexed ? undefined : likeWhere(target, labels, q);
	const like = w === undefined ? [] : [w];
	const all: Json[] = [...(o.where === undefined ? [] : [o.where]), ...like];
	const label = labels.find((f) => {
		const k = target?.fields[f];
		return k !== undefined && sortable(k);
	});
	const orderBy =
		o.orderBy ?? ((indexed && text !== '') || label === undefined ? undefined : { [label]: 'asc' });
	return {
		fields: [...labels],
		limit: o.limit,
		...(all.length === 0 ? {} : { where: all.length === 1 ? (all[0] ?? {}) : { and: all } }),
		...(orderBy === undefined ? {} : { orderBy }),
		...(indexed && text !== '' ? { search: text } : {})
	};
}
