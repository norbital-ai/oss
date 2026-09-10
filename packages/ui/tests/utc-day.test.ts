// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
/**
 * Day-precision instants store one canonical UTC day, the prefix `bolt_instant`/`bolt_daterange`
 * read. A `1 Sep` picked in an east-of-UTC viewer zone used to store `2026-08-31T16:00:00.000Z`,
 * which the database then read as 31 Aug while the engine read 1 Sep — a successor could collide
 * with its predecessor in the exclusion while both sides called the days adjacent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	asDayInstant,
	dayToViewerInstant,
	formatUtcDay,
	toStoredInstant,
	toViewerInstant,
	utcDayOf,
	viewerInstantToDay
} from '../src/data-renderer/utc-day.ts';

test('a day picked east of UTC stores its own UTC day, not the previous one', () => {
	assert.equal(viewerInstantToDay('2026-08-31T16:00:00.000Z', 'Asia/Kuala_Lumpur'), '2026-09-01');
	assert.equal(
		toStoredInstant('2026-08-31T16:00:00.000Z', 'Asia/Kuala_Lumpur'),
		'2026-09-01T00:00:00.000Z'
	);
	// The picker opens on the viewer's local midnight of the canonical day.
	assert.equal(
		toViewerInstant('2026-09-01T00:00:00.000Z', 'Asia/Kuala_Lumpur'),
		'2026-08-31T16:00:00.000Z'
	);
});

test('a day picked west of UTC stores the same UTC day as an east-of-UTC pick', () => {
	assert.equal(
		toStoredInstant('2026-09-01T04:00:00.000Z', 'America/New_York'),
		asDayInstant('2026-09-01')
	);
	assert.equal(dayToViewerInstant('2026-09-01', 'America/New_York'), '2026-09-01T04:00:00.000Z');
});

test('the canonical day prints the same for every viewer, and unreadable input passes through', () => {
	assert.equal(utcDayOf('2026-09-01T00:00:00.000Z'), '2026-09-01');
	assert.equal(utcDayOf('2026-09-01'), '2026-09-01');
	assert.equal(utcDayOf(null), null);
	assert.equal(toStoredInstant('not a date'), null);
	assert.equal(formatUtcDay('2026-09-01', 'en-US'), 'Sep 1, 2026');
});
