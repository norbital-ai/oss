/** Canonical UTC ISO instant: `2026-07-01T00:00:00.000Z`. */
const UTC_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ZONED_ISO_INSTANT =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Nullable wire shape for date-range columns and effective ranges. */
export type DateRangeWire = {
	readonly start?: string | null;
	readonly end?: string | null;
};

export function isUtcIsoInstant(value: string): boolean {
	return UTC_ISO_INSTANT.test(value) && hasValidInstantComponents(value);
}

export function isCalendarDate(value: string): boolean {
	if (!CALENDAR_DATE.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Local wall-clock time with minute precision and no date or timezone. */
export function isClockTime(value: string): boolean {
	return CLOCK_TIME.test(value);
}

function hasValidInstantComponents(value: string): boolean {
	const match = ZONED_ISO_INSTANT.exec(value);
	if (!match) return false;
	const [, date, hour, minute, second] = match;
	return (
		isCalendarDate(date) &&
		Number(hour) <= 23 &&
		Number(minute) <= 59 &&
		Number(second) <= 59 &&
		!Number.isNaN(Date.parse(value))
	);
}

export function parseUtcInstant(value: string): Date {
	if (!isUtcIsoInstant(value)) {
		throw new Error(`Expected a UTC ISO instant ending in Z: ${value}`);
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid UTC instant: ${value}`);
	}
	return date;
}
