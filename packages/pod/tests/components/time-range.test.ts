import { describe, expect, it } from 'vitest';
import { compareTimeValues } from '../../../ui/src/time-range/compare.ts';
import { parseAbsolute, parseTime } from '@internationalized/date';

describe('time range ordering', () => {
	it('compares the complete date for absolute ranges', () => {
		const start = parseAbsolute('2026-06-30T23:00:00Z', 'UTC');
		const overnightEnd = parseAbsolute('2026-07-01T07:00:00Z', 'UTC');
		const multiDayEnd = parseAbsolute('2026-07-03T07:00:00Z', 'UTC');

		expect(compareTimeValues(start, overnightEnd)).toBeLessThan(0);
		expect(compareTimeValues(start, multiDayEnd)).toBeLessThan(0);
	});

	it('retains clock-time ordering for civil shift times', () => {
		expect(compareTimeValues(parseTime('20:30'), parseTime('05:00'))).toBeGreaterThan(0);
	});
});
