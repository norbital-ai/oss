import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTimeValues } from '../../../ui/src/time-range/compare.ts';
import { parseAbsolute, parseTime } from '@internationalized/date';

test('absolute ranges compare the complete date instead of only the clock', () => {
	const start = parseAbsolute('2026-06-30T23:00:00Z', 'UTC');
	const overnightEnd = parseAbsolute('2026-07-01T07:00:00Z', 'UTC');
	const multiDayEnd = parseAbsolute('2026-07-03T07:00:00Z', 'UTC');

	assert.ok(compareTimeValues(start, overnightEnd) < 0);
	assert.ok(compareTimeValues(start, multiDayEnd) < 0);
});

test('civil shift times retain clock-time ordering', () => {
	assert.ok(compareTimeValues(parseTime('20:30'), parseTime('05:00')) > 0);
});
