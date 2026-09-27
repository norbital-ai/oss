// Field kinds as the ui sees them (§3.3.2): the literal a model or an input declares, structurally, so ui needs no bolt
// dependency. Pure functions only: display text, text parsing, advisory checks and empty values. The host decides; these
// only keep a form from sending what decode would refuse (rule 23), with the same messages.
import type { Precision } from './precision.js';

/** A JSON value. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Common = { optional?: true; default?: unknown; unique?: true; label?: string; help?: string; hidden?: true };
/** A field kind literal as the ui reads it: every stored and input kind, structurally (no bolt dependency). */
export type Kind = Common & (
	| { kind: 'text'; format?: 'email' | 'phone' | 'url' | 'zone'; max?: number; many?: true }
	| { kind: 'int' | 'number'; min?: number; max?: number }
	| { kind: 'decimal'; scale: number; precision?: number; min?: number; max?: number }
	| { kind: 'money'; currency?: string }
	| { kind: 'currency' | 'bool' | 'duration' | 'point' }
	/** `precision`: the unit a picker offers and snaps to (`precision.ts`). */
	| { kind: 'date' | 'instant' | 'time'; precision?: Precision }
	| { kind: 'period'; of: 'date' | 'instant'; precision?: Precision }
	| { kind: 'enum'; values: readonly string[]; many?: true }
	| { kind: 'state'; initial: string; states: { readonly [s: string]: { to?: readonly string[]; edit?: 'all' | 'none' | readonly string[] } } }
	| { kind: 'seq'; pattern?: string; per?: readonly string[] }
	| { kind: 'sum'; of: string; where?: object } | { kind: 'count'; of: string; where?: object }
	| { kind: 'json'; shape?: Kind }
	| { kind: 'file'; accept: readonly string[]; max: string; multiple?: true }
	| { kind: 'vector'; dim: number; metric: 'l2' | 'cosine' | 'ip' }
	| { kind: 'custom'; of: string }
	| { kind: 'id'; of: string; where?: object }
	| { kind: 'list'; of: Kind; min?: number; max?: number }
	| { kind: 'object'; fields: Fields }
	| { kind: 'union'; by: string; arms: { readonly [tag: string]: Fields } }
	| { kind: 'record'; of: Kind });
/** Named field kinds: an object's or an input's fields. */
export type Fields = { readonly [name: string]: Kind };
/** The kind literal of one `kind` name. */
export type KindOf<K extends Kind['kind']> = Extract<Kind, { kind: K }>;
/** A stored file's reference: id, name, MIME type and size. */
export type FileRef = { readonly id: string; readonly name: string; readonly mime: string; readonly size?: number };
/** A latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };

/** Kinds shown as numbers: tabular figures, right-aligned in a table column. */
export const NUMERIC = new Set(['int', 'number', 'decimal', 'money', 'sum', 'count', 'duration']);
/**
 * The built-in custom field a stored kind renders as (`money`, `file`, `point`, `phone`), or a tenant custom field's own
 * name: the one key a renderer is looked up by, built-in or tenant alike.
 */
export function fieldName(kind: Kind): string | undefined {
	if (kind.kind === 'custom') return kind.of;
	if (kind.kind === 'money' || kind.kind === 'file' || kind.kind === 'point') return kind.kind;
	return kind.kind === 'text' && kind.format === 'phone' && kind.many !== true ? 'phone' : undefined;
}
/** Kinds a person never types: the platform derives or the transform writes them. */
export const DERIVED = new Set(['seq', 'sum', 'count', 'vector']);
/** Kinds the structural editor renders (object/list/union/record, and json/custom with a shape). */
export const STRUCTURED = new Set(['object', 'list', 'union', 'record']);

const isObj = (v: unknown): v is { readonly [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
const TAGS = ['$dec', '$d', '$t'] as const;
/**
 * A value as `$bolt` hands it (a row's value: JSON, std's `Decimal`, a masked marker) or as the wire tags it
 * (`{ $dec: '1.50' }` → `'1.50'`), as plain JSON: decimals stay exact text, never a float.
 */
export function untag(v: unknown): Json {
	if (v === undefined) return null;
	// hook:codec — `$bolt` hands std's `Decimal`: its exact text
	if (isObj(v) && Object.keys(v).length === 0 && typeof (v as { toJSON?: unknown }).toJSON === 'function') return (v as unknown as { toJSON(): string }).toJSON();
	if (Array.isArray(v)) return v.map(untag);
	if (!isObj(v)) return v as Json;
	const keys = Object.keys(v);
	if (keys.length === 1 && (TAGS as readonly string[]).includes(keys[0]!)) return v[keys[0]!]!;
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, untag(x)]));
}
export const isFile = (v: unknown): v is FileRef => isObj(v) && typeof v['id'] === 'string' && typeof v['name'] === 'string' && typeof v['mime'] === 'string';
export const isPoint = (v: unknown): v is Point => isObj(v) && typeof v['lat'] === 'number' && typeof v['lng'] === 'number';
export const isMasked = (v: unknown) => isObj(v) && v['$masked'] === true;

// ── money ──
/** ISO 4217 minor digits from the platform's own table (JPY 0, SGD 2, BHD 3). */
export function minorDigits(currency: string): number {
	try {
		return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
	} catch {
		return 2;
	}
}
/** A money field's currency: the literal code, the named sibling field's value, or the workspace default (X-8). */
export function currencyOf(kind: KindOf<'money'>, row: { readonly [f: string]: unknown } = {}, fallback?: string): string | undefined {
	const c = kind.currency;
	if (c === undefined) return fallback;
	if (/^[A-Z]{3}$/.test(c)) return c;
	const v = untag(row[c]);
	return typeof v === 'string' ? v : fallback;
}

// ── durations: whole seconds, typed as `1h 30m`, `90m`, `45s` or a bare number of minutes ──
const UNITS: readonly [string, number][] = [['d', 86_400], ['h', 3_600], ['m', 60], ['s', 1]];
export function formatDuration(seconds: number): string {
	if (seconds === 0) return '0m';
	let rest = Math.abs(seconds);
	const parts: string[] = [];
	for (const [u, n] of UNITS) if (rest >= n) { parts.push(`${Math.floor(rest / n)}${u}`); rest %= n; }
	return (seconds < 0 ? '-' : '') + parts.join(' ');
}
export function parseDuration(text: string): number | null {
	const t = text.trim().toLowerCase();
	if (/^-?\d+$/.test(t)) return Number(t) * 60;
	const re = /(\d+(?:\.\d+)?)\s*(d|h|min|m|s)/g;
	let total = 0, seen = '', m: RegExpExecArray | null;
	while ((m = re.exec(t)) !== null) { total += Number(m[1]) * UNITS.find(([u]) => u === (m![2] === 'min' ? 'm' : m![2]))![1]; seen += m[0]; }
	return seen.replace(/\s/g, '') === t.replace(/\s/g, '') && seen !== '' ? Math.round(total) : null;
}

// ── points: "lat, lng" typed, or picked; never needs a provider (P19) ──
export function parsePoint(text: string): Point | null {
	const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
	if (m === null) return null;
	const p = { lat: Number(m[1]), lng: Number(m[2]) };
	return validPoint(p) ? p : null;
}
export const validPoint = (p: Point) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export const formatPoint = (p: Point) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

// ── files: `accept` and `max` are checked before bytes leave the browser (the host checks again) ──
export function sizeBytes(size: string): number {
	const m = /^(\d+)(KiB|MiB)$/.exec(size);
	return m === null ? Infinity : Number(m[1]) * (m[2] === 'KiB' ? 1024 : 1024 * 1024);
}
export function fileProblem(kind: KindOf<'file'>, file: { readonly type: string; readonly size: number; readonly name: string }): string | null {
	const ok = kind.accept.some((p) => p === '*/*' || (p.endsWith('/*') ? file.type.startsWith(p.slice(0, -1)) : file.type === p));
	if (!ok) return `${file.name}: expected ${kind.accept.join(', ')}`;
	if (file.size > sizeBytes(kind.max)) return `${file.name}: over ${kind.max}`;
	return null;
}
/** Rule 72: at most 20 files per field. */
export const MAX_FILES = 20;

// ── display ──
export type ShowOptions = { locale?: string; currency?: string; zone?: string };
/** One value as text in the viewer's locale; '' for none. Structured values render through `Show`, this is their summary. */
export function format(kind: Kind, value: unknown, o: ShowOptions = {}): string {
	const v = untag(value);
	const locale = o.locale ?? 'en';
	if (v === null) return '';
	if (isMasked(value)) return '•••';
	switch (kind.kind) {
		case 'int': case 'number': case 'count': return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : String(v);
		case 'decimal': case 'sum': return decimalText(String(v), locale, kind.kind === 'decimal' ? kind.scale : undefined);
		case 'money': {
			const c = o.currency;
			return c === undefined ? decimalText(String(v), locale) : moneyText(String(v), c, locale);
		}
		case 'bool': return v === true ? '✓' : '✗';
		// a year or a month shows as one (its stored first day would read as a day)
		case 'date': return kind.precision === 'year' ? String(v).slice(0, 4) : kind.precision === 'month'
			? new Date(`${String(v).slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' }) : dateText(String(v), locale);
		case 'instant': return new Date(String(v)).toLocaleString(locale, o.zone === undefined ? {} : { timeZone: o.zone });
		case 'time': return String(v).slice(0, 5);
		case 'duration': return typeof v === 'number' ? formatDuration(v) : String(v);
		case 'period': {
			if (!isObj(v)) return '';
			const at = (x: Json | undefined) => x === null || x === undefined ? '…' : kind.of === 'date' ? dateText(String(x), locale) : new Date(String(x)).toLocaleString(locale);
			return kind.of === 'date' ? `${at(v['from'])} – ${at(v['to'])}` : `${at(v['start'])} – ${at(v['end'])}`;
		}
		case 'enum': case 'text': return Array.isArray(v) ? v.join(', ') : String(v);
		case 'point': return isPoint(v) ? formatPoint(v) : '';
		case 'file': return (Array.isArray(v) ? v : [v]).filter(isFile).map((f) => f.name).join(', ');
		case 'vector': return Array.isArray(v) ? `[${v.length}]` : '';
		case 'list': return Array.isArray(v) ? v.map((x) => format(kind.of, x, o)).join(', ') : '';
		case 'json': case 'custom': case 'object': case 'union': case 'record':
			return isObj(v) && typeof v['label'] === 'string' ? v['label'] : JSON.stringify(v);
		default: return String(v);
	}
}
function decimalText(s: string, locale: string, scale?: number): string {
	// exact: format the integer part through Intl, keep the fraction digits as written
	const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
	if (m === null) return s;
	const frac = scale === undefined ? (m[3] ?? '') : (m[3] ?? '').padEnd(scale, '0').slice(0, Math.max(scale, (m[3] ?? '').replace(/0+$/, '').length));
	const sep = new Intl.NumberFormat(locale).formatToParts(1.1).find((p) => p.type === 'decimal')?.value ?? '.';
	return `${m[1]}${new Intl.NumberFormat(locale).format(BigInt(m[2]!))}${frac === '' ? '' : sep + frac}`;
}
function moneyText(s: string, currency: string, locale: string): string {
	const digits = minorDigits(currency);
	const parts = new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0);
	const symbol = parts.filter((p) => p.type === 'currency').map((p) => p.value).join('');
	const before = parts.findIndex((p) => p.type === 'currency') < parts.findIndex((p) => p.type === 'integer');
	const n = decimalText(padScale(s, digits), locale);
	return before ? `${symbol}${n}` : `${n} ${symbol}`;
}
const padScale = (s: string, scale: number) => {
	const [i, f = ''] = s.split('.');
	return scale === 0 ? i! : `${i}.${f.padEnd(scale, '0')}`;
};
function dateText(s: string, locale: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
	if (m === null) return s;
	// a calendar date has no zone: format it at UTC so it never shifts a day
	return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(locale, { timeZone: 'UTC', dateStyle: 'medium' });
}

// ── parsing typed text (text-shaped editors) ──
export type Parsed = { value: Json } | { error: string };
export function parse(kind: Kind, text: string): Parsed {
	const t = text.trim();
	if (t === '') return { value: null };
	switch (kind.kind) {
		case 'int': return /^-?\d+$/.test(t) ? { value: Number(t) } : { error: 'expected an integer' };
		case 'number': return Number.isFinite(Number(t)) ? { value: Number(t) } : { error: 'expected a number' };
		case 'decimal': case 'money': {
			const s = t.replace(/[,\s_]/g, '');
			if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: 'expected a decimal' };
			const scale = kind.kind === 'decimal' ? kind.scale : undefined;
			if (scale !== undefined && (s.split('.')[1]?.length ?? 0) > scale) return { error: `at most ${scale} decimal places` };
			return { value: s };
		}
		case 'duration': { const n = parseDuration(t); return n === null ? { error: 'expected a duration like 1h 30m' } : { value: n }; }
		case 'point': { const p = parsePoint(t); return p === null ? { error: 'expected latitude, longitude' } : { value: p }; }
		default: return { value: t };
	}
}
/** A money amount's minor-unit check (the column's CHECK, rule 68). */
export function moneyProblem(amount: string, currency: string | undefined): string | null {
	if (currency === undefined) return null;
	const d = minorDigits(currency);
	return (amount.split('.')[1]?.replace(/0+$/, '').length ?? 0) > d ? `${currency} has ${d} decimal places` : null;
}

// ── advisory validation, same wording as decode ──
export function problem(kind: Kind, value: Json | undefined): string | null {
	const v = untag(value);
	if (v === null || (Array.isArray(v) && v.length === 0 && (kind.kind === 'file' || kind.kind === 'list'))) {
		if (kind.optional === true || kind.default !== undefined || DERIVED.has(kind.kind) || kind.kind === 'state') return null;
		return kind.kind === 'list' && (kind.min ?? 0) === 0 && v !== null ? null : 'is required';
	}
	const range = (n: number, k: { min?: number; max?: number }) => (k.min !== undefined && n < k.min) || (k.max !== undefined && n > k.max) ? 'is out of range' : null;
	switch (kind.kind) {
		case 'text':
			if (kind.many) return Array.isArray(v) ? null : 'expected a list of text';
			if (typeof v !== 'string') return 'expected text';
			if (kind.max !== undefined && v.length > kind.max) return `is over ${kind.max} characters`;
			if (kind.format === 'email' && !/^[^@\s]+@[^@\s]+$/.test(v)) return 'expected an email address';
			if (kind.format === 'url' && !URL.canParse(v)) return 'expected a URL';
			if (kind.format === 'phone' && !/^\+?[\d\s()-]{5,}$/.test(v)) return 'expected a phone number';
			return null;
		case 'int': return typeof v !== 'number' || !Number.isInteger(v) ? 'expected an integer' : range(v, kind);
		case 'number': return typeof v !== 'number' || !Number.isFinite(v) ? 'expected a number' : range(v, kind);
		case 'decimal': {
			const p = parse(kind, String(v));
			return 'error' in p ? p.error : range(Number(v), kind);
		}
		case 'money': return /^-?\d+(\.\d+)?$/.test(String(v)) ? null : 'expected a decimal';
		case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? null : 'expected a date (YYYY-MM-DD)';
		case 'instant': return Number.isNaN(Date.parse(String(v))) ? 'expected an instant' : null;
		case 'enum': {
			const ok = (x: Json) => kind.values.includes(String(x));
			return (kind.many ? Array.isArray(v) && v.every(ok) : ok(v)) ? null : `expected one of ${kind.values.join(', ')}`;
		}
		case 'period': {
			if (!isObj(v)) return 'expected a period';
			const [a, b] = kind.of === 'date' ? [v['from'], v['to']] : [v['start'], v['end']];
			if (a === null || a === undefined) return 'needs a start';
			// empty or inverted periods are refused (rule 68): a date period is inclusive, an instant one closed-open
			if (b !== null && b !== undefined && (kind.of === 'date' ? String(b) < String(a) : Date.parse(String(b)) <= Date.parse(String(a)))) return 'ends before it starts';
			return null;
		}
		case 'point': return isPoint(v) && validPoint(v) ? null : 'expected latitude, longitude';
		case 'file': return (Array.isArray(v) ? v.length > MAX_FILES : false) ? `at most ${MAX_FILES} files` : null;
		case 'list':
			if (!Array.isArray(v)) return 'expected a list';
			return (kind.min !== undefined && v.length < kind.min) || (kind.max !== undefined && v.length > kind.max) ? 'has the wrong number of items' : null;
		default: return null;
	}
}
/** Every problem of a structured value by dotted path (`lines.0.amount`), as decode reports them. */
export function problems(kind: Kind, value: Json | undefined, at = ''): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (k: Kind, v: Json | undefined, path: string) => {
		const p = problem(k, v);
		if (p !== null) { out.set(path, p); return; }
		const x = untag(v);
		if (x === null) return;
		const join = (key: string | number) => (path === '' ? String(key) : `${path}.${key}`);
		if (k.kind === 'object' && isObj(x)) for (const [f, fk] of Object.entries(k.fields)) walk(fk, x[f], join(f));
		else if ((k.kind === 'json') && k.shape !== undefined) walk(k.shape, x, path);
		else if (k.kind === 'list' && Array.isArray(x)) x.forEach((item, i) => walk(k.of, item, join(i)));
		else if (k.kind === 'record' && isObj(x)) for (const [key, item] of Object.entries(x)) walk(k.of, item, join(key));
		else if (k.kind === 'union' && isObj(x)) {
			const arm = k.arms[String(x[k.by])];
			if (arm === undefined) out.set(join(k.by), `expected one of ${Object.keys(k.arms).join(', ')}`);
			else for (const [f, fk] of Object.entries(arm)) walk(fk, x[f], join(f));
		}
	};
	walk(kind, value, at);
	return out;
}

/** The value a new form starts from: the literal default, else empty (`{ today }`/`{ now }` defaults stay to the host). */
export function initial(kind: Kind): Json {
	const d = kind.default;
	if (d !== undefined && !(isObj(d) && ('today' in d || 'now' in d))) return d as Json;
	switch (kind.kind) {
		case 'state': return kind.initial;
		case 'list': return [];
		case 'text': return kind.many ? [] : null;
		case 'enum': return kind.many ? [] : null;
		case 'object': return kind.optional ? null : Object.fromEntries(Object.entries(kind.fields).map(([f, k]) => [f, initial(k)]));
		case 'record': return kind.optional ? null : {};
		case 'bool': return kind.optional ? null : false;
		default: return null;
	}
}
/** A union value switched to another arm: the tag, then each of that arm's fields at its initial value. */
export function armValue(kind: KindOf<'union'>, tag: string): Json {
	return { [kind.by]: tag, ...Object.fromEntries(Object.entries(kind.arms[tag] ?? {}).map(([f, k]) => [f, initial(k)])) };
}

/** State edges out of `from` (the state machine's `to`), for a badge's move menu. */
export const edgesFrom = (kind: KindOf<'state'>, from: string): readonly string[] => kind.states[from]?.to ?? [];
/** Whether `field` may change while the row is in `state` (the state's `edit` list); advice, the host enforces it. */
export function editable(kind: KindOf<'state'>, state: string, field: string): boolean {
	const e = kind.states[state]?.edit ?? 'all';
	return e === 'all' ? true : e === 'none' ? false : e.includes(field);
}
/** A stable tone per state name, so the same state reads the same colour on every page. */
export function tone(state: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
	const s = state.toLowerCase();
	if (/(draft|new|open|pending|queued)/.test(s)) return 'neutral';
	if (/(reject|cancel|void|fail|lost|declin|terminat|block)/.test(s)) return 'danger';
	if (/(approv|done|complete|paid|won|closed|active|sealed|sent|accept|confirm|deliver)/.test(s)) return 'success';
	if (/(hold|review|wait|overdue|expir|chang)/.test(s)) return 'warning';
	return 'info';
}

const UNSORTED = new Set(['json', 'file', 'custom', 'vector', 'point', 'period', 'object', 'list', 'union', 'record']);
/**
 * A picker's page read (§3.6): the target's `search.text` when it declares one, else `like` over the label's text and
 * patterned `seq` fields; sorted by `orderBy`, else by the first sortable label field (a typed search ranks instead).
 */
export function pickerRead(target: { readonly search?: readonly string[]; readonly fields: Fields } | undefined, labels: readonly string[],
	o: { where?: Json | undefined; orderBy?: Json | undefined; limit: number }, q: string): { readonly [k: string]: Json } {
	const text = q.trim(), indexed = (target?.search?.length ?? 0) > 0;
	const searchable = labels.filter((f) => { const k = target?.fields[f]; return k === undefined || k.kind === 'text' || (k.kind === 'seq' && k.pattern !== undefined); });
	const like = text === '' || indexed || searchable.length === 0 ? [] : [{ or: searchable.map((f) => ({ [f]: { like: `%${text.replace(/[%_\\]/g, '\\$&')}%` } })) }];
	const all: Json[] = [...(o.where === undefined ? [] : [o.where]), ...like];
	const label = labels.find((f) => { const k = target?.fields[f]; return k !== undefined && !UNSORTED.has(k.kind) && !('many' in k && k.many === true); });
	const orderBy = o.orderBy ?? (indexed && text !== '' || label === undefined ? undefined : { [label]: 'asc' });
	return { select: Object.fromEntries([['id', true], ...labels.map((f) => [f, true])]), limit: o.limit,
		...(all.length === 0 ? {} : { where: all.length === 1 ? all[0]! : { and: all } }), ...(orderBy === undefined ? {} : { orderBy }),
		...(indexed && text !== '' ? { search: text } : {}) };
}
