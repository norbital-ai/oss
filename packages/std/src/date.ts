// std/date (§3.7, rule 68, X-11): a `date` is a zone-free calendar day, an `instant` is UTC, and a date period is
// inclusive `{ from, to | null }` (null = open). Values are branded strings, so they are their own wire form.
import { DAY_MS, utcOf } from './zone.ts';

export type PlainDate = string & { readonly __date: unique symbol };
export type Instant = string & { readonly __instant: unique symbol };
export type Zone = string & { readonly __zone: unique symbol };
/** An inclusive period of dates; `to: null` is open-ended. */
export type DatePeriod = { readonly from: PlainDate; readonly to: PlainDate | null };
/** `Intl.DateTimeFormat` options plus the `locale` to format in. */
export type DateFormatOptions = Intl.DateTimeFormatOptions & { locale?: string };
type DateIn = PlainDate | string;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const untag = (v: unknown, tag: string): unknown => typeof v === 'object' && v !== null && tag in v ? (v as Record<string, unknown>)[tag] : v;

/** A calendar day `YYYY-MM-DD` (or a tagged `{ $d }`); anything else throws. */
export function PlainDate(v: string | { readonly $d: string }): PlainDate {
	const s = untag(v, '$d');
	if (typeof s !== 'string' || !DATE.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s)
		throw new RangeError(`'${String(s)}' is not a calendar date (YYYY-MM-DD)`);
	return s as PlainDate;
}
/** An ISO instant with `Z` or an offset (or a `Date`, or a tagged `{ $t }`), as canonical UTC `…Z`. */
export function Instant(v: string | Date | { readonly $t: string }): Instant {
	const s = untag(v, '$t');
	const ms = s instanceof Date ? s.getTime() : typeof s === 'string' && ISO.test(s) ? Date.parse(s) : Number.NaN;
	if (Number.isNaN(ms)) throw new RangeError(`'${String(s)}' is not an ISO instant with a zone`);
	return new Date(ms).toISOString() as Instant;
}
/** An IANA zone id the runtime knows. */
export function Zone(v: string): Zone {
	try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { throw new RangeError(`'${v}' is not an IANA time zone`); }
	return v as Zone;
}

const toDays = (d: DateIn) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;
const fromDays = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10) as PlainDate;

/** An inclusive period; `to < from` throws. */
export function datePeriod(from: DateIn, to: DateIn | null): DatePeriod {
	const p = { from: PlainDate(from), to: to === null ? null : PlainDate(to) };
	if (p.to !== null && p.to < p.from) throw new RangeError(`period ends (${p.to}) before it starts (${p.from})`);
	return p;
}
/** Whether day `d` is inside period `p` (ends included). */
export const contains = (p: DatePeriod, d: DateIn): boolean => p.from <= d && (p.to === null || d <= p.to);
/** Whether two periods share at least one day. */
export const overlaps = (a: DatePeriod, b: DatePeriod): boolean =>
	(a.to === null || b.from <= a.to) && (b.to === null || a.from <= b.to);
/** The days two periods share, or `null` when they do not overlap. */
export function intersect(a: DatePeriod, b: DatePeriod): DatePeriod | null {
	if (!overlaps(a, b)) return null;
	const to = a.to === null ? b.to : b.to === null ? a.to : a.to < b.to ? a.to : b.to;
	return { from: a.from > b.from ? a.from : b.from, to };
}
/** Inclusive day count; an open period throws. */
export function days(p: DatePeriod): number {
	if (p.to === null) throw new RangeError('an open period has no day count');
	return toDays(p.to) - toDays(p.from) + 1;
}
/** Every day of a closed period, in order; an open period throws. */
export function eachDay(p: DatePeriod): PlainDate[] {
	const n = days(p), start = toDays(p.from);
	return Array.from({ length: n }, (_, i) => fromDays(start + i));
}
/**
 * The day `n` days after `d` (before, when negative).
 * @example
 * addDays('2026-02-27', 2) // '2026-03-01'
 */
export const addDays = (d: DateIn, n: number): PlainDate => fromDays(toDays(PlainDate(d)) + n);
/** Calendar months; the day is clamped to the target month's last day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: DateIn, n: number): PlainDate {
	const [y, m, day] = PlainDate(d).split('-').map(Number) as [number, number, number];
	const first = new Date(Date.UTC(y, m - 1 + n, 1));
	const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
	first.setUTCDate(Math.min(day, last));
	return first.toISOString().slice(0, 10) as PlainDate;
}
/** The calendar month containing `d`, as a closed period. */
export function monthOf(d: DateIn): DatePeriod {
	const from = PlainDate(`${PlainDate(d).slice(0, 7)}-01`);
	return { from, to: addDays(addMonths(from, 1), -1) };
}
/** The calendar year containing `d`, as a closed period. */
export const yearOf = (d: DateIn): DatePeriod => ({ from: PlainDate(`${PlainDate(d).slice(0, 4)}-01-01`), to: PlainDate(`${d.slice(0, 4)}-12-31`) });

function formatter(defaults: Intl.DateTimeFormatOptions, opts: DateFormatOptions, zone?: string) {
	const { locale, ...rest } = opts;
	const parts = Object.keys(rest).some((k) => k !== 'timeZone');
	return new Intl.DateTimeFormat(locale ?? 'en-US', { ...(parts ? {} : defaults), ...rest, ...(zone ? { timeZone: zone } : {}) });
}
/** A calendar day for people (`Jan 5, 2026` by default); never shifted by a zone. */
export const formatDate = (d: DateIn, opts: DateFormatOptions = {}): string =>
	formatter({ dateStyle: 'medium' }, opts, 'UTC').format(Date.parse(`${PlainDate(d)}T00:00:00Z`));
/** An instant in `opts.timeZone` (default the runtime's). */
export const formatInstant = (i: Instant | string, opts: DateFormatOptions = {}): string =>
	formatter({ dateStyle: 'medium', timeStyle: 'short' }, opts).format(Date.parse(Instant(i)));
/** `Jan 5, 2026 – Feb 1, 2026`; an open end is `…`, no period is `—`. */
export const formatPeriod = (p: DatePeriod | null | undefined, opts: DateFormatOptions = {}): string =>
	p == null ? '—' : `${formatDate(p.from, opts)} – ${p.to === null ? '…' : formatDate(p.to, opts)}`;

/**
 * An ISO instant with a zone, or a wall time `YYYY-MM-DD HH:MM[:SS]` read in `zone`; null when the text is neither
 * (never a throw: the caller decides whether a blank or bad cell refuses).
 */
export function parseInstant(text: string, zone?: Zone | string): Instant | null {
	const s = text.trim();
	if (ISO.test(s)) { const ms = Date.parse(s); return Number.isNaN(ms) ? null : new Date(ms).toISOString() as Instant; }
	const m = zone === undefined ? null : LOCAL.exec(s);
	if (m === null || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null;
	try { PlainDate(m[1]!); } catch { return null; }
	return new Date(utcOf(m[1]!, ((Number(m[2]) * 60 + Number(m[3])) * 60 + Number(m[4] ?? 0)) * 1000, zone!)).toISOString() as Instant;
}
