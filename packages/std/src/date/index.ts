import { isCalendarDate, parseUtcInstant } from './wire.js';

export type { DateRangeWire } from './wire.js';
export { isCalendarDate, isClockTime, isUtcIsoInstant, parseUtcInstant } from './wire.js';
export {
	formatDateRangeLocal,
	formatUtcInstantLocal,
	type FormatInstantOptions
} from './display.js';

/** UTC calendar day `YYYY-MM-DD` from a stored instant or calendar string. */
export function formatDateISO(value: string | Date): string {
	if (typeof value === 'string' && isCalendarDate(value)) return value;
	const date = typeof value === 'string' ? parseUtcInstant(value) : value;
	return date.toISOString().slice(0, 10);
}
