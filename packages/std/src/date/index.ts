import type { DateRangeValue, DateRangeWire } from './wire.js';
import { isCalendarDate, parseUtcInstant } from './wire.js';

export type { DateRangeValue, DateRangeWire, TemporalKind } from './wire.js';
export {
	isCalendarDate,
	isClockTime,
	isTemporalOperand,
	isUtcIsoInstant,
	parseUtcInstant,
	temporalKindForFieldKind,
	toUtcIsoInstant,
	utcMonthRange
} from './wire.js';
export {
	formatDateRangeLocal,
	formatUtcInstantLocal,
	type FormatInstantOptions
} from './display.js';

export type WeekdayName = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type TimeOfDayRange = {
	readonly start: string;
	readonly end: string;
};

/** UTC calendar day `YYYY-MM-DD` from a stored instant or calendar string. */
export function formatDateISO(value: string | Date): string {
	if (typeof value === 'string' && isCalendarDate(value)) return value;
	const date = typeof value === 'string' ? parseUtcInstant(value) : value;
	return date.toISOString().slice(0, 10);
}

export function parseDateRange(range: DateRangeValue): { start: Date; end: Date } {
	return {
		start: parseUtcInstant(range.start),
		end: parseUtcInstant(range.end)
	};
}

export function effectiveWithin(
	range: DateRangeWire | null | undefined,
	isoTimestamp: string
): boolean {
	if (range?.start == null) return false;
	return dateWithinRange(parseUtcInstant(isoTimestamp), range);
}

/** Inclusive range check for stored UTC instants. */
export function dateWithinRange(date: Date, range: DateRangeWire | null | undefined): boolean {
	if (range?.start == null) return true;
	const point = date.getTime();
	const start = parseUtcInstant(range.start).getTime();
	if (point < start) return false;
	if (range.end != null && point > parseUtcInstant(range.end).getTime()) return false;
	return true;
}

export function weekdayForDate(date: Date): WeekdayName {
	const days: WeekdayName[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
	return days[date.getUTCDay()];
}

function parseTimeOfDayMinutes(value: string): number | null {
	const match = value.trim().match(/^(\d{1,2}):(\d{2})/);
	if (!match) return null;
	const [, hours, minutes] = match;
	return Number(hours) * 60 + Number(minutes);
}

/** Hours between same-day time-of-day strings; wraps past midnight when end is before start. */
export function hoursFromTimeRange(
	timeRange: TimeOfDayRange,
	breakMinutes: number | null | undefined = 0
): number {
	const start = parseTimeOfDayMinutes(timeRange.start);
	const end = parseTimeOfDayMinutes(timeRange.end);
	if (start == null || end == null) return 0;
	let diff = end - start;
	if (diff < 0) diff += 24 * 60;
	const breakMin = breakMinutes ?? 0;
	return Math.max(0, (diff - breakMin) / 60);
}

export function daysBetween(start: string, end: string): number {
	const startDate = parseUtcInstant(start);
	const endDate = parseUtcInstant(end);
	return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;
}
