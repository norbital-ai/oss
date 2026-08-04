/**
 * Calendar helpers used by the app pages for *display* only.
 *
 * Nothing here decides payroll: the period window, cutoff handling and pay-date shifting that a
 * run is actually built with belong to the payroll engine and reach the UI as stored
 * `payroll_runs.pay_date` / `attendance_from` / `attendance_to` columns. These functions only put
 * a company's `pay_day` on a calendar so an operator can see which cycles are still open.
 */

import { formatDateISO } from '@norbital-ai/std/date';

/** The business timezone every calendar-day default and `contains_date` filter resolves in. */
export const PAYROLL_TIME_ZONE = 'Asia/Kuala_Lumpur';

/** Calendar date for an instant in an IANA timezone, formatted as YYYY-MM-DD. */
export function calendarDateInTimeZone(value: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(value);
	const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

/**
 * Calendar day of "now" in the payroll timezone — the reference every board on these pages is drawn
 * against, and the operand every `effective_range: { contains_date: … }` filter is prefilled with.
 *
 * This used to be `new Date().toISOString().slice(0, 10)`, which is the *UTC* day.
 * `dates-and-time.md` names that expression as forbidden for exactly this use: for eight hours of
 * every day it selects yesterday's rate row, so a server hook could price against a different day
 * than the client had displayed.
 */
export function todayKey(): string {
	return calendarDateInTimeZone(new Date(), PAYROLL_TIME_ZONE);
}

/** How far `timeZone` is ahead of UTC at `at`, in milliseconds. */
function timeZoneOffsetMs(at: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(at);
	const field = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((part) => part.type === type)?.value ?? '0');
	const wallClockAsUtc = Date.UTC(
		field('year'),
		field('month') - 1,
		field('day'),
		field('hour'),
		field('minute'),
		field('second')
	);
	return wallClockAsUtc - at.getTime();
}

/**
 * The canonical UTC instant at which `calendarDate` begins in `timeZone`.
 *
 * A `dateRange()` bound is an instant, and its picker offers a calendar day. Appending `Z` to that
 * day — `` `${date}T00:00:00.000Z` `` — labels local wall time as UTC, which
 * [dates-and-time.md](../../../../skills/authoring-tenant-workspace/references/dates-and-time.md)
 * forbids: east of Greenwich it places the boundary eight hours into the previous local day.
 *
 * The offset is resolved twice because the zone's offset at UTC midnight and at the corrected
 * instant can differ across a daylight-saving transition; the second pass settles on the offset
 * actually in force at the answer.
 */
export function startOfDayInstant(calendarDate: string, timeZone: string): string {
	const utcMidnight = new Date(`${calendarDate}T00:00:00.000Z`);
	if (Number.isNaN(utcMidnight.getTime())) {
		throw new Error(`"${calendarDate}" is not a YYYY-MM-DD calendar date.`);
	}
	const firstPass = new Date(utcMidnight.getTime() - timeZoneOffsetMs(utcMidnight, timeZone));
	return new Date(utcMidnight.getTime() - timeZoneOffsetMs(firstPass, timeZone)).toISOString();
}

/**
 * `YYYY-MM-DD` from a Pod `date()` column value. Local PGlite reads yield `Date`; wire payloads
 * yield calendar or ISO strings — both are accepted.
 */
export function calendarDayKey(value: string | Date): string {
	return formatDateISO(value);
}

/** `YYYY-MM` of a UTC calendar day (string key or live `date()` column value). */
export function monthKey(date: string | Date): string {
	return calendarDayKey(date).slice(0, 7);
}

/** `YYYY-MM` offset by whole months. */
export function shiftMonthKey(period: string, months: number): string {
	const year = Number(period.slice(0, 4));
	const month = Number(period.slice(5, 7));
	const shifted = new Date(Date.UTC(year, month - 1 + months, 1));
	return shifted.toISOString().slice(0, 7);
}

/** Number of days in the `YYYY-MM` month. */
export function daysInMonth(period: string): number {
	const year = Number(period.slice(0, 4));
	const month = Number(period.slice(5, 7));
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The calendar day a `pay_day`-of-month falls on for one period, clamped to the month's length so
 * a 31st pay day still resolves in February.
 */
export function payDateFor(period: string, payDay: number): string {
	const day = Math.min(Math.max(payDay, 1), daysInMonth(period));
	return `${period}-${String(day).padStart(2, '0')}`;
}

/** Whole days from `from` to `to`, negative when `to` is in the past. */
export function daysBetweenKeys(from: string, to: string): number {
	return Math.ceil(
		(Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000
	);
}

/** The Monday of the ISO week containing `date`, as `YYYY-MM-DD`. */
export function startOfIsoWeekDate(date: unknown): string | null {
	if (typeof date !== 'string' && !(date instanceof Date)) return null;
	let day: string;
	try {
		day = calendarDayKey(date);
	} catch {
		return null;
	}
	if (day.length < 10) return null;
	const parsed = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	const weekday = (parsed.getUTCDay() + 6) % 7;
	parsed.setUTCDate(parsed.getUTCDate() - weekday);
	return parsed.toISOString().slice(0, 10);
}

/** The `YYYY-MM` periods spanning `count` months, ending `ahead` months after the current month. */
export function periodWindow(count: number, ahead: number): string[] {
	const current = monthKey(todayKey());
	return Array.from({ length: count }, (_value, index) =>
		shiftMonthKey(current, ahead - count + 1 + index)
	);
}
