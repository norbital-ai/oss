import { Effect, Option } from 'effect';
import { getLocalTimeZone, parseAbsolute, parseDate } from '@internationalized/date';

export function calendarDateToInstant(value: string, timeZone = getLocalTimeZone()): string | null {
	return Option.getOrNull(
		Effect.runSync(
			Effect.try(() => parseDate(value).toDate(timeZone).toISOString()).pipe(Effect.option)
		)
	);
}

export function instantToCalendarDate(value: string, timeZone = getLocalTimeZone()): string | null {
	return Option.getOrNull(
		Effect.runSync(
			Effect.try(() => {
				const date = parseAbsolute(value, timeZone);
				const year = String(date.year).padStart(4, '0');
				const month = String(date.month).padStart(2, '0');
				const day = String(date.day).padStart(2, '0');
				return `${year}-${month}-${day}`;
			}).pipe(Effect.option)
		)
	);
}
