/**
 * Date-only arithmetic for the payroll engine.
 *
 * Every date the engine reasons about is a calendar day, never an instant: an attendance window,
 * a work date, an employment range. They are handled as `YYYY-MM-DD` strings anchored to UTC, so
 * that no host timezone can move a day across a period boundary. `effective_range` columns hold
 * ISO instants and are sliced to ten characters before comparison.
 */

/** A calendar day, `YYYY-MM-DD`. */
export type IsoDate = string;

const DAY_MS = 86_400_000;

/**
 * Narrow any stored date-ish value to its calendar day.
 *
 * A `date` column carries no time zone, and it reaches the engine as the `YYYY-MM-DD` text the
 * driver read off the wire — which is the only representation of a calendar day that no host can
 * move. Slicing it is therefore the whole conversion, and it is exact.
 *
 * A `Date` is something else: an instant, and an instant is only a calendar day once a zone has
 * been chosen. This module's zone is UTC, as stated above, so the UTC components are read. Do not
 * be tempted into local ones — a value like `new Date('2026-01-01')` is anchored at UTC midnight,
 * and reading it locally moves the day backwards everywhere west of Greenwich.
 *
 * (This is the shape of a bug that reached production once: the driver used to hand `date` columns
 * over as a `Date` at the **host's** local midnight, an instant that means a different day in the
 * tenant runtime's zone. A hire date of 2026-01-01 arrived as 2025-12-31, which put the employment
 * in the previous month — deferred out of a December that had no terms covering it. That is fixed
 * where it happened, at the driver's type parser, so a calendar day is never an instant again.)
 */
export function dateKey(value: string | Date | null | undefined): IsoDate | null {
	if (value == null) return null;
	if (value instanceof Date) return iso(value);
	return value.slice(0, 10);
}

/** Same as `dateKey`, for a value that must be present. */
export function requiredDateKey(value: string | Date, what: string): IsoDate {
	const key = dateKey(value);
	if (key == null || key.length !== 10) throw new Error(`${what} is not a calendar date.`);
	return key;
}

function utc(year: number, monthIndex: number, day: number): Date {
	return new Date(Date.UTC(year, monthIndex, day));
}

function iso(value: Date): IsoDate {
	return value.toISOString().slice(0, 10);
}

/** The `YYYY-MM` a day belongs to. */
export function monthKey(date: IsoDate): string {
	return date.slice(0, 7);
}

/** Day of month, 1-31. */
export function dayOfMonth(date: IsoDate): number {
	return Number(date.slice(8, 10));
}

/**
 * The `day`th day of a month, clamped to the month's length — so a cutoff of 31 resolves to the
 * 28th or 29th in February rather than wrapping into March. `monthIndex` may be out of range and
 * rolls into the neighbouring year, which is how the previous month of January is addressed.
 */
export function monthDay(year: number, monthIndex: number, day: number): IsoDate {
	const lastDay = utc(year, monthIndex + 1, 0).getUTCDate();
	return iso(utc(year, monthIndex, Math.min(Math.max(1, day), lastDay)));
}

export function addDays(date: IsoDate, days: number): IsoDate {
	return iso(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS));
}

/** Number of calendar days in the month a date falls in. */
export function monthDays(date: IsoDate): number {
	const year = Number(date.slice(0, 4));
	const monthIndex = Number(date.slice(5, 7)) - 1;
	return utc(year, monthIndex + 1, 0).getUTCDate();
}

/** Days from `start` to `end` counting both ends; 1 when they are the same day. */
export function inclusiveDays(start: IsoDate, end: IsoDate): number {
	const span = Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`);
	return Math.floor(span / DAY_MS) + 1;
}

/** Every calendar day in `[start, end]`. */
export function daysBetween(start: IsoDate, end: IsoDate): IsoDate[] {
	if (end < start) return [];
	const days: IsoDate[] = [];
	for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
	return days;
}

/** `0` = Sunday … `6` = Saturday, matching `Date.getUTCDay`. */
export function weekdayIndex(date: IsoDate): number {
	return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** The three-letter weekday code used by `employment_terms.rest_day`. */
export const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export function weekdayCode(date: IsoDate): (typeof WEEKDAY_CODES)[number] {
	return WEEKDAY_CODES[weekdayIndex(date)]!;
}

/**
 * Completed calendar months between two days, anniversary-exact: someone hired on 14 July 2024 has
 * 24 completed months on 14 July 2026 and 23 on the 13th (decision L4).
 */
export function completedMonths(start: IsoDate, end: IsoDate): number {
	const startYear = Number(start.slice(0, 4));
	const startMonth = Number(start.slice(5, 7));
	const endYear = Number(end.slice(0, 4));
	const endMonth = Number(end.slice(5, 7));
	let months = (endYear - startYear) * 12 + (endMonth - startMonth);
	if (dayOfMonth(end) < dayOfMonth(start)) months -= 1;
	return Math.max(0, months);
}

/** Whole years between two days, on the same anniversary-exact basis. */
export function completedYears(start: IsoDate, end: IsoDate): number {
	return Math.floor(completedMonths(start, end) / 12);
}

/** The overlap of two inclusive day ranges, or `null` when they are disjoint. */
export function intersectDays(
	a: { start: IsoDate; end: IsoDate },
	b: { start: IsoDate; end: IsoDate }
): { start: IsoDate; end: IsoDate } | null {
	const start = a.start > b.start ? a.start : b.start;
	const end = a.end < b.end ? a.end : b.end;
	return start > end ? null : { start, end };
}

/** First and last calendar day of a `YYYY-MM` period. */
export function monthBounds(period: string): { start: IsoDate; end: IsoDate } {
	if (!/^\d{4}-\d{2}$/.test(period))
		throw new Error(`Period must be YYYY-MM, received "${period}".`);
	const year = Number(period.slice(0, 4));
	const monthIndex = Number(period.slice(5, 7)) - 1;
	return { start: iso(utc(year, monthIndex, 1)), end: iso(utc(year, monthIndex + 1, 0)) };
}

/** The `YYYY-MM` `offset` months after `period`. */
export function shiftPeriod(period: string, offset: number): string {
	const year = Number(period.slice(0, 4));
	const monthIndex = Number(period.slice(5, 7)) - 1 + offset;
	return iso(utc(year, monthIndex, 1)).slice(0, 7);
}
