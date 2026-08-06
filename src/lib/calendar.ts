/**
 * Calendar-day derivation for this workspace.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, not the dispatch day, so a desk west of
 * Greenwich schedules against yesterday for part of every day. `dates-and-time.md` names that
 * expression as forbidden: derive the calendar day in a named timezone instead. Calendar arithmetic
 * then stays on the `YYYY-MM-DD` string and never round-trips through a `Date` in the server's
 * local zone.
 */

import { isCalendarDate } from '@norbital-ai/std/date';

/** The business timezone every dispatch-day default on this site resolves in. */
export const FIELD_TIME_ZONE = 'Asia/Singapore';

/** Calendar date for an instant in this workspace's business timezone, as `YYYY-MM-DD`. */
export function calendarDateInTimeZone(value: Date): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: FIELD_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(value);
	const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

/** Move an ISO calendar date without applying the browser's local timezone. */
export function shiftCalendarDate(value: string, days: number): string {
	if (!isCalendarDate(value)) {
		throw new Error('Calendar date must use YYYY-MM-DD.');
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}
