import { getLocalTimeZone, parseAbsolute, parseDate } from '@internationalized/date';

export function calendarDateToInstant(value: string, timeZone = getLocalTimeZone()): string | null {
	try {
		return parseDate(value).toDate(timeZone).toISOString();
	} catch {
		return null;
	}
}

export function instantToCalendarDate(value: string, timeZone = getLocalTimeZone()): string | null {
	try {
		const date = parseAbsolute(value, timeZone);
		const year = String(date.year).padStart(4, '0');
		const month = String(date.month).padStart(2, '0');
		const day = String(date.day).padStart(2, '0');
		return `${year}-${month}-${day}`;
	} catch {
		return null;
	}
}
