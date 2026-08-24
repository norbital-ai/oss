import { Effect, Option } from 'effect';
import { getLocalTimeZone, parseDate } from '@internationalized/date';

export function calendarDateToInstant(value: string, timeZone = getLocalTimeZone()): string | null {
	return Option.getOrNull(
		Effect.runSync(
			Effect.try(() => parseDate(value).toDate(timeZone).toISOString()).pipe(Effect.option)
		)
	);
}
