/**
 * Calendar-day derivation for this workspace.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC day, not the site's day, so any site west of
 * Greenwich prices and filters against yesterday for part of every day. `dates-and-time.md` names
 * that expression as forbidden: derive the calendar day in a named timezone instead.
 */

/** The business timezone every calendar-day filter and "today" default on this site resolves in. */
export const PROJECT_TIME_ZONE = 'Asia/Singapore';

/** Calendar date for an instant in this workspace's business timezone, as `YYYY-MM-DD`. */
export function calendarDateInTimeZone(value: Date): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone: PROJECT_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(value);
	const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

/** Midnight of `calendarDate` in the business timezone, as the UTC instant that moment actually is. */
export function startOfDayInstant(calendarDate: string): string {
	const naive = Date.parse(`${calendarDate}T00:00:00Z`);
	if (Number.isNaN(naive)) throw new Error(`Not a calendar date: ${calendarDate}`);
	// Resolve twice: the offset at the guessed instant can differ from the offset at the real one
	// across a daylight-saving boundary.
	let instant = naive;
	for (let pass = 0; pass < 2; pass += 1) {
		const shown = Date.parse(`${calendarDateInTimeZone(new Date(instant))}T00:00:00Z`);
		instant += naive - shown;
	}
	return new Date(instant).toISOString();
}

/**
 * "Now", as the instant a `contains_date` filter wants. A calendar day is not an instant, and the
 * server refuses one rather than guessing which timezone turns it into a moment.
 */
export function todayInstant(): string {
	return startOfDayInstant(calendarDateInTimeZone(new Date()));
}
