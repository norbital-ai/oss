// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRosterSchedule, weekdayOf } from './workforce-validation.ts';

const SHIFT = { code: 'D', start_time: '09:00', end_time: '18:00', break_minutes: 60 };
const NIGHT = { code: 'N', start_time: '22:00', end_time: '06:00', break_minutes: 60 };

const LIMITS = {
	week_starts_on: 'MON',
	min_rest_days_per_week: 1,
	max_consecutive_work_days: null,
	max_daily_work_minutes: null,
	min_minutes_between_shifts: null
};

/** `days` from a compact string: one character per day from `from`. W = work, R = rest, O = off. */
function days(from, plan, employment = 'e1', shift = SHIFT) {
	const start = Date.parse(`${from}T00:00:00.000Z`);
	return [...plan].map((mark, index) => {
		const date = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
		const designation = mark === 'W' ? 'WORK' : mark === 'R' ? 'REST' : 'OFF';
		return {
			employment_id: employment,
			work_date: date,
			designation,
			shift: designation === 'WORK' ? shift : null
		};
	});
}

function codesOf(violations) {
	return violations.map((violation) => violation.code);
}

test('weekdayOf reads a calendar date without drifting by timezone', () => {
	// 2026-05-01 was a Friday; the whole week is checked so an off-by-one cannot hide.
	assert.equal(weekdayOf('2026-05-01'), 'FRI');
	assert.equal(weekdayOf('2026-05-02'), 'SAT');
	assert.equal(weekdayOf('2026-05-03'), 'SUN');
	assert.equal(weekdayOf('2026-05-04'), 'MON');
});

test('a Monday week with one rest day passes', () => {
	// 2026-05-04 is a Monday: five working days, Saturday off, Sunday rest.
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWWWOR'),
		limits: LIMITS
	});
	assert.deepEqual(violations, []);
});

test('a full week with no rest day is refused', () => {
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWWWWO'),
		limits: LIMITS
	});
	assert.deepEqual(codesOf(violations), ['WEEKLY_REST_SHORTFALL']);
	assert.match(violations[0].message, /at least 1 is required/);
});

test('an off day does not satisfy the rest-day entitlement', () => {
	// Six working days and one off day: the week is fully covered, but nothing is a rest day.
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWWWWO'),
		limits: LIMITS
	});
	assert.equal(violations.length, 1);
	assert.equal(violations[0].code, 'WEEKLY_REST_SHORTFALL');
});

test('a week is only judged once all seven of its days are present', () => {
	// Four days with no rest day at all: not enough to conclude the week is short.
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWW'),
		limits: LIMITS
	});
	assert.deepEqual(violations, []);
});

test('the week anchor decides which days form a week', () => {
	/*
	 * A rest day that recurs every seven days falls inside every seven-day window, so any anchor
	 * accepts it and the anchor cannot be observed. It becomes observable when the rest days are
	 * unevenly spaced.
	 *
	 * This fortnight begins Tuesday 2026-05-05 and rests on its first and last day — the opening
	 * Tuesday and the closing Monday. Read as Tuesday weeks that is one rest day in each week, which
	 * is what the crew agreed. Read as Monday weeks, the complete window from Monday the 11th to
	 * Sunday the 17th contains no rest day at all. Judging a Tuesday roster against a Monday week
	 * therefore condemns a lawful roster, which is why the anchor is configurable.
	 */
	const plan = days('2026-05-05', 'RWWWWWWWWWWWWR');

	const tuesdayAnchored = validateRosterSchedule({
		days: plan,
		limits: { ...LIMITS, week_starts_on: 'TUE' }
	});
	assert.deepEqual(tuesdayAnchored, []);

	const mondayAnchored = validateRosterSchedule({
		days: plan,
		limits: { ...LIMITS, week_starts_on: 'MON' }
	});
	assert.deepEqual(codesOf(mondayAnchored), ['WEEKLY_REST_SHORTFALL']);
	assert.match(mondayAnchored[0].message, /2026-05-11 to 2026-05-17/);
});

test('a more generous rest promise is enforced as written', () => {
	const oneRestDay = days('2026-05-04', 'WWWWWOR');
	assert.deepEqual(
		codesOf(
			validateRosterSchedule({ days: oneRestDay, limits: { ...LIMITS, min_rest_days_per_week: 2 } })
		),
		['WEEKLY_REST_SHORTFALL']
	);

	const twoRestDays = days('2026-05-04', 'WWWWWRR');
	assert.deepEqual(
		validateRosterSchedule({ days: twoRestDays, limits: { ...LIMITS, min_rest_days_per_week: 2 } }),
		[]
	);
});

test('consecutive working days are counted across week boundaries', () => {
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWWWWWWR'),
		limits: { ...LIMITS, max_consecutive_work_days: 6 }
	});
	const consecutive = violations.filter((violation) => violation.code === 'CONSECUTIVE_WORK_DAYS');
	assert.equal(consecutive.length, 1);
	assert.equal(consecutive[0].dates.length, 8);
});

test('a rest day breaks a run of consecutive working days', () => {
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWWRWWW'),
		limits: { ...LIMITS, max_consecutive_work_days: 3 }
	});
	assert.deepEqual(
		codesOf(violations).filter((code) => code === 'CONSECUTIVE_WORK_DAYS'),
		[]
	);
});

test('a working day naming no shift cannot be measured', () => {
	const plan = days('2026-05-04', 'WWWWWOR');
	plan[0].shift = null;
	const violations = validateRosterSchedule({ days: plan, limits: LIMITS });
	assert.deepEqual(codesOf(violations), ['WORK_DAY_WITHOUT_SHIFT']);
});

test('the daily hours ceiling measures paid time, not the spread', () => {
	// 09:00–18:00 less a 60-minute break is 480 paid minutes.
	assert.deepEqual(
		validateRosterSchedule({
			days: days('2026-05-04', 'WOR'),
			limits: { ...LIMITS, max_daily_work_minutes: 480 }
		}),
		[]
	);
	assert.deepEqual(
		codesOf(
			validateRosterSchedule({
				days: days('2026-05-04', 'WOR'),
				limits: { ...LIMITS, max_daily_work_minutes: 479 }
			})
		),
		['DAILY_HOURS_EXCEEDED']
	);
});

test('a night shift crossing midnight is measured into the next day', () => {
	// 22:00–06:00 less a 60-minute break is 420 paid minutes, not a negative span.
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WOR', 'e1', NIGHT),
		limits: { ...LIMITS, max_daily_work_minutes: 419 }
	});
	assert.deepEqual(codesOf(violations), ['DAILY_HOURS_EXCEEDED']);
	assert.match(violations[0].message, /7\.00 paid hours/);
});

test('back-to-back night shifts leave too little rest between them', () => {
	// Each night runs 22:00 to 06:00, so consecutive nights are 16 hours apart.
	const violations = validateRosterSchedule({
		days: days('2026-05-04', 'WWR', 'e1', NIGHT),
		limits: { ...LIMITS, min_minutes_between_shifts: 16 * 60 + 1 }
	});
	assert.deepEqual(codesOf(violations), ['INSUFFICIENT_REST_BETWEEN_SHIFTS']);
});

test('each employment is judged on its own week', () => {
	const violations = validateRosterSchedule({
		days: [...days('2026-05-04', 'WWWWWOR', 'lawful'), ...days('2026-05-04', 'WWWWWWO', 'short')],
		limits: LIMITS
	});
	assert.deepEqual(codesOf(violations), ['WEEKLY_REST_SHORTFALL']);
	assert.equal(violations[0].employment_id, 'short');
});
