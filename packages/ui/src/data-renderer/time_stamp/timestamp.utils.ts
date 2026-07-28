import { getLocalTimeZone, parseAbsolute, parseDateTime } from '@internationalized/date';

export interface LocalDateTimeParts {
	date: string;
	time: string;
}

export function toLocalDateTimeParts(
	value: unknown,
	timeZone = getLocalTimeZone()
): LocalDateTimeParts | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	try {
		const instant = parseAbsolute(value, timeZone);
		const year = String(instant.year).padStart(4, '0');
		const month = String(instant.month).padStart(2, '0');
		const day = String(instant.day).padStart(2, '0');
		const hours = String(instant.hour).padStart(2, '0');
		const minutes = String(instant.minute).padStart(2, '0');
		return { date: `${year}-${month}-${day}`, time: `${hours}:${minutes}` };
	} catch {
		return null;
	}
}

export function fromLocalDateTimeParts(
	date: string,
	time: string,
	timeZone = getLocalTimeZone()
): string | null {
	const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
	if (!dateMatch || !timeMatch) return null;

	try {
		const instant = parseDateTime(`${date}T${time}`).toDate(timeZone).toISOString();
		const roundTrip = toLocalDateTimeParts(instant, timeZone);
		if (!roundTrip || roundTrip.date !== date || roundTrip.time !== time) return null;
		return instant;
	} catch {
		return null;
	}
}
