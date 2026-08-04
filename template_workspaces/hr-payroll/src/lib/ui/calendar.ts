/**
 * Calendar helpers used by the app pages for *display* only.
 *
 * Nothing here decides payroll: the period window, cutoff handling and pay-date shifting that a
 * run is actually built with belong to the payroll engine and reach the UI as stored
 * `payroll_runs.pay_date` / `attendance_from` / `attendance_to` columns. These functions only put
 * a company's `pay_day` on a calendar so an operator can see which cycles are still open.
 */

import { formatDateISO } from '@norbital-ai/std/date';

/** UTC calendar day of "now", the reference every board on these pages is drawn against. */
export function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
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
