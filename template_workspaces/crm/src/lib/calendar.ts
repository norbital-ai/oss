/**
 * Calendar-day derivation for this workspace.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, not the desk's day, so a server west of
 * Greenwich dates a purchase order or an activity against yesterday for part of every day.
 * `dates-and-time.md` names that expression as forbidden: derive the calendar day in a named
 * timezone instead. Calendar arithmetic then stays on the `YYYY-MM-DD` string and never round-trips
 * through a `Date` in the server's local zone.
 */

/** The business timezone every calendar-day default on this desk resolves in. */
export const DESK_TIME_ZONE = 'Asia/Singapore';

/** Today's calendar day on this desk, as `YYYY-MM-DD`. */
export function deskToday(): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: DESK_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date());
	const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

/**
 * Move an ISO calendar date without applying any local timezone.
 *
 * Anchoring at `T00:00:00.000Z` and stepping with `setUTCDate` keeps the arithmetic in one zone, so
 * the result is a pure day count. Parsing `${value}T00:00:00` instead would resolve in the server's
 * local zone and then re-serialise through UTC, which lands on the wrong day on any non-UTC host.
 */
export function shiftCalendarDate(value: string, days: number): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error('Calendar date must use YYYY-MM-DD.');
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) throw new Error('Calendar date is invalid.');
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}
