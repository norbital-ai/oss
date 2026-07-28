/** Canonical UTC ISO instant: `2026-07-01T00:00:00.000Z`. */
const UTC_ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const ZONED_ISO_INSTANT =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export type DateRangeValue = {
	readonly start: string;
	readonly end: string;
};

/** Nullable wire shape for date-range columns and effective ranges. */
export type DateRangeWire = {
	readonly start?: string | null;
	readonly end?: string | null;
};

export type TemporalKind = 'calendar-date' | 'clock-time' | 'instant';

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

/** Temporal semantics carried by portable collection field kinds. */
export function temporalKindForFieldKind(fieldKind: string): TemporalKind | undefined {
	if (fieldKind === 'date') return 'calendar-date';
	if (fieldKind === 'clock_time') return 'clock-time';
	if (fieldKind === 'timestamp' || fieldKind === 'timestamptz') return 'instant';
	return undefined;
}

/** Validate a scalar or list operand against its declared temporal semantics. */
export function isTemporalOperand(kind: TemporalKind, operand: unknown): boolean {
	const values = Array.isArray(operand) ? operand : [operand];
	if (kind === 'calendar-date') {
		return values.every((value) => typeof value === 'string' && isCalendarDate(value));
	}
	if (kind === 'clock-time') {
		return values.every((value) => typeof value === 'string' && isClockTime(value));
	}
	return values.every(
		(value) =>
			(value instanceof Date && !Number.isNaN(value.getTime())) ||
			(typeof value === 'string' && isUtcIsoInstant(value))
	);
}

/** Normalize Postgres `+00` / `-05` offsets to RFC3339 `+00:00`. */
function normalizeIsoTimezoneOffset(isoLike: string): string {
	return isoLike.replace(/([+-]\d{2})$/, '$1:00');
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

/** Convert a timezone-qualified instant to canonical UTC ISO. Unzoned values are rejected. */
export function toUtcIsoInstant(value: string | Date): string {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) throw new Error('Invalid timestamp');
		return value.toISOString();
	}
	const isoLike = normalizeIsoTimezoneOffset(
		value.trim().includes('T') ? value.trim() : value.trim().replace(' ', 'T')
	);
	if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(isoLike)) {
		throw new Error(`Timestamp must include a timezone: ${value}`);
	}
	if (!hasValidInstantComponents(isoLike)) {
		throw new Error(`Invalid timestamp: ${value}`);
	}
	const parsed = Date.parse(isoLike);
	return new Date(parsed).toISOString();
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

/** Inclusive UTC calendar month as `{ start, end }` UTC ISO instants. */
export function utcMonthRange(year: number, month: number): DateRangeValue {
	const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0)).toISOString();
	const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
	return { start, end };
}
