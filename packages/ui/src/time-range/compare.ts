import type { TimeValue } from 'bits-ui';
import { Time } from '@internationalized/date';

/**
 * Compare values without discarding calendar or zone information.
 *
 * `TimeValue` is intentionally polymorphic: civil `Time` values compare by clock time, while
 * `CalendarDateTime` and `ZonedDateTime` compare their complete instant. Flattening all three to
 * hour/minute/second makes a valid overnight attendance interval look reversed.
 */
export function compareTimeValues<T extends TimeValue>(
	left: T | undefined,
	right: T | undefined
): number {
	if (left == null || right == null) return 0;
	if (left instanceof Time && right instanceof Time) return left.compare(right);
	if (!(left instanceof Time) && !(right instanceof Time)) return left.compare(right);

	// A generic caller should not mix civil and calendar-bearing values. Keep the comparison
	// deterministic if it does, without erasing the dates when both values carry them.
	const leftClock = left.hour * 3_600 + left.minute * 60 + left.second;
	const rightClock = right.hour * 3_600 + right.minute * 60 + right.second;
	return leftClock - rightClock;
}
