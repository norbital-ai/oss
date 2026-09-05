/** Canonical UTC ISO instant: `2026-07-01T00:00:00.000Z`. */
const UTC_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ZONED_ISO_INSTANT =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

import { Schema } from 'effect';

const isString = Schema.is(Schema.String);

/**
 * An inclusive date range over UTC calendar days, as it travels between client and server.
 *
 * Both bounds may be absent (an open-ended range) and both may be null (shown as `…`), so the
 * schema keeps the wire shape explicit; `formatDateRangeLocal` is the one renderer of it.
 */
export const DateRangeWireSchema = Schema.Struct({
	start: Schema.optional(Schema.NullishOr(Schema.String)),
	end: Schema.optional(Schema.NullishOr(Schema.String))
});

export type DateRangeWire = Schema.Schema.Type<typeof DateRangeWireSchema>;

export type FormatInstantOptions = Intl.DateTimeFormatOptions & { locale?: string };

export function isUtcIsoInstant(value: string): boolean {
	return UTC_ISO_INSTANT.test(value) && hasValidInstantComponents(value);
}

export function isCalendarDate(value: string): boolean {
	if (!CALENDAR_DATE.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isClockTime(value: string): boolean {
	return CLOCK_TIME.test(value);
}

function hasValidInstantComponents(value: string): boolean {
	const match = ZONED_ISO_INSTANT.exec(value);
	if (!match) return false;
	const [, date, hour, minute, second] = match;
	return (
		date !== undefined &&
		isCalendarDate(date) &&
		Number(hour) <= 23 &&
		Number(minute) <= 59 &&
		Number(second) <= 59 &&
		!Number.isNaN(Date.parse(value))
	);
}

export function parseUtcInstant(value: string): Date {
	if (!isUtcIsoInstant(value)) throw new Error(`Expected a UTC ISO instant ending in Z: ${value}`);
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid UTC instant: ${value}`);
	return date;
}

export function formatUtcInstantLocal(value: string, options: FormatInstantOptions = {}): string {
	const { locale = 'en-US', ...intlOptions } = options;
	return new Intl.DateTimeFormat(locale, intlOptions).format(parseUtcInstant(value));
}

export function formatDateRangeLocal(
	range: DateRangeWire | null | undefined,
	options: FormatInstantOptions = {}
): string {
	if (!range?.start && !range?.end) return '—';
	const { locale = 'en-US', dateStyle = 'medium', ...intlOptions } = options;
	const formatter = new Intl.DateTimeFormat(locale, { dateStyle, ...intlOptions });
	const formatBound = (value?: string | null) =>
		value ? formatter.format(parseUtcInstant(value)) : '...';
	return `${formatBound(range.start)} – ${formatBound(range.end)}`;
}

/** UTC calendar day `YYYY-MM-DD` from a stored instant or calendar string. */
export function formatDateISO(value: string | Date): string {
	if (isString(value) && isCalendarDate(value)) return value;
	const date = isString(value) ? parseUtcInstant(value) : value;
	return date.toISOString().slice(0, 10);
}
