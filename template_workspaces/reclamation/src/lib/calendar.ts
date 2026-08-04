/**
 * Calendar-day derivation for this workspace.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, not the site's day, so any site west of
 * Greenwich prices and filters against yesterday for part of every day. `dates-and-time.md` names
 * that expression as forbidden: derive the calendar day in a named timezone instead.
 */

/** The business timezone every calendar-day filter and "today" default on this site resolves in. */
export const PROJECT_TIME_ZONE = 'Asia/Singapore';

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
