import {
	getLocalTimeZone,
	parseAbsolute,
	parseDate,
	toCalendarDate
} from '@internationalized/date';

/**
 * Day-precision instants: one canonical day per stored value.
 *
 * A `precision: 'day'` instant is still a UTC instant, but every platform reader resolves it by
 * its **date prefix**: `bolt_instant` and `bolt_daterange` both parse `value -> 'start'` as a
 * calendar day, and the workspace's `dateKey` resolves the same prefix in the business zone. The
 * pickers used to store the viewer's local day boundaries instead — `1 Sep` picked in Singapore
 * became `2026-08-31T16:00:00.000Z` — so a successor could collide with its predecessor in the
 * database exclusion while the engine read the days as adjacent. Storage is therefore the UTC day,
 * and the viewer's zone is used only to paint and read the calendar.
 */

const DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** The UTC calendar day a stored day-precision instant names, or null when it names none. */
export function utcDayOf(value: unknown): string | null {
	return typeof value === 'string' && DAY_PREFIX.test(value) ? value.slice(0, 10) : null;
}

/** The canonical stored instant of a UTC calendar day. */
export function asDayInstant(day: string): string {
	return `${day}T00:00:00.000Z`;
}

/** The viewer-local midnight a calendar should open on for a stored UTC day. */
export function dayToViewerInstant(day: string, timeZone: string = getLocalTimeZone()): string {
	return parseDate(day).toDate(timeZone).toISOString();
}

/** The calendar day a viewer-local instant names, or null when it is not one. */
export function viewerInstantToDay(
	instant: string,
	timeZone: string = getLocalTimeZone()
): string | null {
	try {
		return toCalendarDate(parseAbsolute(instant, timeZone)).toString();
	} catch {
		return null;
	}
}

/** A stored day-precision instant as the viewer-local midnight a picker should show. */
export function toViewerInstant(
	value: unknown,
	timeZone: string = getLocalTimeZone()
): string | null {
	const day = utcDayOf(value);
	return day == null ? null : dayToViewerInstant(day, timeZone);
}

/** A UTC calendar day in the display locale, independent of the viewer's zone. */
export function formatUtcDay(day: string, locale: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
		parseDate(day).toDate('UTC')
	);
}

/** A picker's emitted viewer-local instant as the canonical stored UTC day. */
export function toStoredInstant(
	value: unknown,
	timeZone: string = getLocalTimeZone()
): string | null {
	if (typeof value !== 'string' || value === '') return null;
	const day = viewerInstantToDay(value, timeZone);
	return day == null ? null : asDayInstant(day);
}
