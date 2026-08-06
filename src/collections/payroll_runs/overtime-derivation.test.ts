// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
/**
 * Overtime is computed here, from clocks — it is never read off a time entry.
 *
 * `time_entries` used to carry `overtime_authorized` and five `approved_ot_*_hours` buckets, and
 * `deriveDailyOvertime` branched on both: a recorded refusal suppressed the whole day, and a bucket
 * breakdown replaced the clock as the payable duration. Both are gone. A time entry states what
 * happened on the clock; what those punches are worth is decided here, against the statutory day
 * type and the effective terms.
 *
 * These are the behaviours that decision is made of. They are pinned because the same punches
 * priced two different ways is precisely how someone gets quietly underpaid — and because until the
 * TS source resolver existed nothing could drive these modules from a test at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOvertimeByCalendarMonth, deriveDailyOvertime, priceDay } from './lib/overtime.ts';

/** 08:30–17:30 with an hour's break, and half an hour unpaid before overtime may start. */
const DAY_SHIFT = {
	norbital_id: 'shift-day',
	code: 'D',
	start_time: '08:30',
	end_time: '17:30',
	break_minutes: 60,
	overtime_break_minutes: 30,
	crosses_midnight: false,
	pays_overtime: true
};

/** Attendance is recorded at UTC+8; `+08:00` instants are what the clocks actually hold. */
const at = (date, time) => `${date}T${time}:00.000+08:00`;

const entry = (overrides = {}) => ({
	norbital_id: 'time-entry',
	work_date: '2026-03-10',
	clock_in: at('2026-03-10', '08:30'),
	clock_out: at('2026-03-10', '17:30'),
	break_minutes: 60,
	state: 'CLOSED',
	overtime_in: null,
	overtime_out: null,
	...overrides
});

const scheduled = (overrides = {}) => ({
	date: '2026-03-10',
	dayType: 'ORDINARY',
	shift: DAY_SHIFT,
	clampStart: '08:30',
	normalHours: 8,
	...overrides
});

test('a day worked to its scheduled end earns no overtime at all', () => {
	assert.equal(deriveDailyOvertime(entry(), scheduled()), null);
});

test('an ordinary day is the overrun past the shift end, less the unpaid overtime break', () => {
	// Out at 20:45 — 3h15m past 17:30, less the 30-minute overtime break is 2h45m, floored to 2.5.
	const day = deriveDailyOvertime(entry({ clock_out: at('2026-03-10', '20:45') }), scheduled());
	assert.equal(day.hours, 2.5);
	assert.equal(day.dayType, 'ORDINARY');
	assert.equal(day.date, '2026-03-10');
	assert.equal(day.timeEntryId, 'time-entry');
});

test('overtime floors to the half hour below, with no one-hour minimum', () => {
	// 25 minutes past the shift end is entirely consumed by the 30-minute overtime break.
	assert.equal(
		deriveDailyOvertime(entry({ clock_out: at('2026-03-10', '17:55') }), scheduled()),
		null
	);
	// 45 minutes past, less the break, is 15 — which floors to nothing payable.
	assert.equal(
		deriveDailyOvertime(entry({ clock_out: at('2026-03-10', '18:15') }), scheduled()),
		null
	);
	// 1h05m past, less the break, is 35 minutes: half an hour is earned and the rest is not.
	assert.equal(
		deriveDailyOvertime(entry({ clock_out: at('2026-03-10', '18:35') }), scheduled()).hours,
		0.5
	);
});

test('a dedicated overtime punch is the overtime, and the clock overrun is not added to it', () => {
	const day = deriveDailyOvertime(
		entry({
			// Stayed on the main clock until 21:00, but only punched overtime for two hours of it.
			clock_out: at('2026-03-10', '21:00'),
			overtime_in: at('2026-03-10', '18:00'),
			overtime_out: at('2026-03-10', '20:00')
		}),
		scheduled()
	);
	assert.equal(day.hours, 2, 'the punch decides the duration, not the longer clock');
});

test('a rest day is overtime from the first minute, less the unpaid break', () => {
	// 08:30–14:30 is six hours; an hour of break leaves five.
	const day = deriveDailyOvertime(
		entry({ clock_out: at('2026-03-10', '14:30') }),
		scheduled({ dayType: 'REST_DAY' })
	);
	assert.equal(day.hours, 5);
	assert.equal(day.normalHours, 8, 'the contracted day is still the band boundary');
});

test('arriving early is not working: the clock-in is clamped to the scheduled start', () => {
	const early = deriveDailyOvertime(
		entry({ clock_in: at('2026-03-10', '06:00'), clock_out: at('2026-03-10', '14:30') }),
		scheduled({ dayType: 'REST_DAY' })
	);
	assert.equal(early.hours, 5, 'the two hours before 08:30 earn nothing');
});

test('a shift that does not pay overtime earns nothing, whatever the clock says', () => {
	assert.equal(
		deriveDailyOvertime(
			entry({ clock_out: at('2026-03-10', '23:00') }),
			scheduled({ shift: { ...DAY_SHIFT, pays_overtime: false } })
		),
		null
	);
});

test('an entry still carrying the retired approval columns is priced from its clock regardless', () => {
	/*
	 * The regression this exists for. A row imported before the columns were dropped — or one an
	 * old integration still sends — must not be able to suppress or replace the calculation. Under
	 * the previous engine the first of these earned nothing and the second earned five hours; both
	 * now earn what the clock says, because nothing reads those names any more.
	 */
	const clocked = entry({ clock_out: at('2026-03-10', '20:45') });
	const expected = deriveDailyOvertime(clocked, scheduled()).hours;

	const refused = deriveDailyOvertime({ ...clocked, overtime_authorized: false }, scheduled());
	assert.equal(refused.hours, expected, 'a stale refusal cannot withhold pay for hours worked');

	const bucketed = deriveDailyOvertime(
		{
			...clocked,
			overtime_authorized: true,
			approved_ot_1x_hours: 0,
			approved_ot_15x_hours: 5,
			approved_ot_2x_hours: 0,
			approved_ot_3x_hours: 0,
			approved_ot_flat_hours: 0
		},
		scheduled()
	);
	assert.equal(bucketed.hours, expected, 'a stale bucket total cannot outrank the clock');
});

test('an open clock is refused rather than priced as if it had stopped', () => {
	assert.throws(
		() => deriveDailyOvertime(entry({ clock_out: null, state: 'OPEN' }), scheduled()),
		/still open/
	);
});

// ── the hours, once derived, are priced by the seeded statutory ladder ──────────────────────────

const rule = (overrides) => ({
	norbital_id: `rule-${overrides.day_type}-${overrides.band.measure}`,
	authority: 'EA 1955',
	...overrides
});

const ORDINARY_OT = rule({
	day_type: 'ORDINARY',
	band: { measure: 'BEYOND_NORMAL', from_hours: 0, to_hours: null },
	award: { kind: 'HOURLY_MULTIPLE', multiple: 1.5 }
});

const REST_DAY_WAGE = rule({
	day_type: 'REST_DAY',
	band: { measure: 'FROM_START_OF_DAY', from_fraction: 0.5, to_fraction: null },
	award: { kind: 'DAY_WAGE_MULTIPLE', multiple: 1 }
});

const REST_DAY_BEYOND = rule({
	day_type: 'REST_DAY',
	band: { measure: 'BEYOND_NORMAL', from_hours: 0, to_hours: null },
	award: { kind: 'HOURLY_MULTIPLE', multiple: 2 }
});

test('a full rest day pays one day s wages, and only the hours beyond the normal day run the ladder', () => {
	const day = {
		date: '2026-03-08',
		timeEntryId: 'time-entry',
		dayType: 'REST_DAY',
		hours: 10,
		normalHours: 8,
		totalWorkHours: 10
	};
	const { segments } = priceDay({
		day,
		rules: [ORDINARY_OT, REST_DAY_WAGE, REST_DAY_BEYOND],
		retainedHours: 10
	});
	const dayWage = segments.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE');
	const hourly = segments.find((segment) => segment.award === 'HOURLY_MULTIPLE');
	assert.equal(dayWage.hours, 8, 'the normal day is valued once, as a day s wages');
	assert.equal(dayWage.multiple, 1);
	assert.equal(hourly.hours, 2, 'only the two hours beyond the normal day are paid hourly');
	assert.equal(hourly.multiple, 2);
});

test('a rest-day rule with no pay component behind it would still be priced — which is why the run refuses', () => {
	// Pricing does not know about pay components: it produces the segment either way, and `measure`
	// silently finds nobody to pay it. Validation is the only thing standing between that segment
	// and an unpaid day, so this pins that the segment really is produced.
	const { segments } = priceDay({
		day: {
			date: '2026-03-08',
			timeEntryId: 'time-entry',
			dayType: 'REST_DAY',
			hours: 6,
			normalHours: 8,
			totalWorkHours: 6
		},
		rules: [REST_DAY_WAGE, REST_DAY_BEYOND],
		retainedHours: 6
	});
	assert.equal(segments.length, 1);
	assert.equal(segments[0].measure, 'FROM_START_OF_DAY');
});

test('hours past the daily work limit are reclassified, never dropped', () => {
	const [classified] = classifyOvertimeByCalendarMonth({
		days: [
			{
				date: '2026-03-10',
				timeEntryId: 'time-entry',
				dayType: 'ORDINARY',
				hours: 4.5,
				normalHours: 8,
				totalWorkHours: 13
			}
		],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: 104
	});
	assert.equal(classified.retainedHours + classified.excessHours, 4.5);
	assert.equal(classified.excessHours, 1);
});
