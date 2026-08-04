/**
 * Whether a month's roster is lawful and coherent, decided before it is published.
 *
 * Publication is the gate on purpose. A roster is drafted a day at a time, and a half-built month
 * breaks every weekly rule while it is being built, so validating each write would make the tool
 * unusable. Validating at publication asks the question once, when the answer is meaningful.
 *
 * The weekly rest test is the statutory one: EA 1955 s.59 requires one whole day of rest in each
 * week. `week_starts_on` decides where a week begins, so a crew whose week runs Tuesday to Monday is
 * judged over its own week rather than a calendar one — measuring a Tuesday week against Monday
 * boundaries would split every rest day across two windows and fail a lawful roster.
 */

import type { Weekday } from '../../../custom-types/work_pattern_variant/+definition.js';

/**
 * The weekday order, Monday first.
 *
 * Spelled out here rather than imported so this module stays free of runtime dependencies and can be
 * exercised directly by the test runner. `Weekday` above is a type-only import and is erased, so the
 * vocabulary is still checked against the custom type that defines it.
 */
const WEEKDAYS = [
	'MON',
	'TUE',
	'WED',
	'THU',
	'FRI',
	'SAT',
	'SUN'
] as const satisfies readonly Weekday[];

const MINUTES_PER_DAY = 1440;
const MILLISECONDS_PER_DAY = 86_400_000;

export type Designation = 'WORK' | 'REST' | 'OFF';

export type ValidationShift = {
	readonly code: string;
	readonly start_time: string;
	readonly end_time: string;
	readonly break_minutes: number;
};

export type ValidationDay = {
	readonly employment_id: string;
	/** `YYYY-MM-DD`. */
	readonly work_date: string;
	readonly designation: Designation;
	/** The shift governing a WORK day. `null` is itself a fault on a working day. */
	readonly shift: ValidationShift | null;
};

export type SchedulingLimits = {
	readonly week_starts_on: Weekday;
	readonly min_rest_days_per_week: number;
	readonly max_consecutive_work_days: number | null;
	readonly max_daily_work_minutes: number | null;
	readonly min_minutes_between_shifts: number | null;
};

export type ViolationCode =
	| 'WEEKLY_REST_SHORTFALL'
	| 'CONSECUTIVE_WORK_DAYS'
	| 'DAILY_HOURS_EXCEEDED'
	| 'INSUFFICIENT_REST_BETWEEN_SHIFTS'
	| 'WORK_DAY_WITHOUT_SHIFT';

export type ScheduleViolation = {
	readonly code: ViolationCode;
	readonly employment_id: string;
	readonly dates: readonly string[];
	readonly message: string;
};

function clockMinutes(value: string, what: string): number {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (match == null) throw new Error(`${what} is not an HH:mm clock time: "${value}".`);
	return Number(match[1]) * 60 + Number(match[2]);
}

function dayNumber(date: string): number {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	if (Number.isNaN(parsed)) throw new Error(`Not a calendar date: "${date}".`);
	return Math.round(parsed / MILLISECONDS_PER_DAY);
}

/** `MON`…`SUN` for a calendar date, read in UTC so it never shifts with the viewer. */
export function weekdayOf(date: string): Weekday {
	// 1970-01-01 was a Thursday, which sits at index 3 of a Monday-first week.
	return WEEKDAYS[(((dayNumber(date) + 3) % 7) + 7) % 7]!;
}

/** The first day of the week containing `date`, for a week anchored on `weekStartsOn`. */
function weekStartNumber(date: string, weekStartsOn: Weekday): number {
	const anchor = WEEKDAYS.indexOf(weekStartsOn);
	const current = WEEKDAYS.indexOf(weekdayOf(date));
	const offsetIntoWeek = (((current - anchor) % 7) + 7) % 7;
	return dayNumber(date) - offsetIntoWeek;
}

/** Paid minutes and the absolute start/end of a working day, in minutes since the epoch. */
function workedWindow(day: ValidationDay, shift: ValidationShift) {
	const start = clockMinutes(shift.start_time, `shift ${shift.code} start_time`);
	const rawEnd = clockMinutes(shift.end_time, `shift ${shift.code} end_time`);
	// An end at or before the start means the shift runs past midnight into the next day.
	const end = rawEnd <= start ? rawEnd + MINUTES_PER_DAY : rawEnd;
	const base = dayNumber(day.work_date) * MINUTES_PER_DAY;
	return {
		date: day.work_date,
		start: base + start,
		end: base + end,
		paid: end - start - shift.break_minutes
	};
}

/**
 * Judge every employment in `days`.
 *
 * A week is only judged when all seven of its days are present, so callers pad the month they are
 * publishing with the surrounding days. Without the padding the first and last weeks of every month
 * would look like rest-day shortfalls purely because their remaining days sit in another roster.
 */
export function validateRosterSchedule(input: {
	readonly days: readonly ValidationDay[];
	readonly limits: SchedulingLimits;
}): ScheduleViolation[] {
	const violations: ScheduleViolation[] = [];
	const byEmployment = new Map<string, ValidationDay[]>();
	for (const day of input.days) {
		const bucket = byEmployment.get(day.employment_id);
		if (bucket) bucket.push(day);
		else byEmployment.set(day.employment_id, [day]);
	}

	for (const [employmentId, unsorted] of byEmployment) {
		const days = unsorted.toSorted(
			(left, right) => dayNumber(left.work_date) - dayNumber(right.work_date)
		);

		const windows: ReturnType<typeof workedWindow>[] = [];
		for (const day of days) {
			if (day.designation !== 'WORK') continue;
			if (day.shift == null) {
				violations.push({
					code: 'WORK_DAY_WITHOUT_SHIFT',
					employment_id: employmentId,
					dates: [day.work_date],
					message: `${day.work_date} is rostered as a working day but names no shift, so its hours cannot be measured.`
				});
				continue;
			}
			windows.push(workedWindow(day, day.shift));
		}

		if (input.limits.max_daily_work_minutes != null) {
			for (const window of windows) {
				if (window.paid > input.limits.max_daily_work_minutes) {
					violations.push({
						code: 'DAILY_HOURS_EXCEEDED',
						employment_id: employmentId,
						dates: [window.date],
						message: `${window.date} schedules ${(window.paid / 60).toFixed(2)} paid hours, above the pattern's daily limit of ${(input.limits.max_daily_work_minutes / 60).toFixed(2)}.`
					});
				}
			}
		}

		if (input.limits.min_minutes_between_shifts != null) {
			for (let index = 1; index < windows.length; index += 1) {
				const previous = windows[index - 1]!;
				const current = windows[index]!;
				const gap = current.start - previous.end;
				if (gap < input.limits.min_minutes_between_shifts) {
					violations.push({
						code: 'INSUFFICIENT_REST_BETWEEN_SHIFTS',
						employment_id: employmentId,
						dates: [previous.date, current.date],
						message:
							gap < 0
								? `The shifts on ${previous.date} and ${current.date} overlap.`
								: `Only ${(gap / 60).toFixed(2)} hours separate the shifts on ${previous.date} and ${current.date}, below the pattern's minimum of ${(input.limits.min_minutes_between_shifts / 60).toFixed(2)}.`
					});
				}
			}
		}

		if (input.limits.max_consecutive_work_days != null) {
			let run: string[] = [];
			const flush = (): void => {
				if (run.length > input.limits.max_consecutive_work_days!) {
					violations.push({
						code: 'CONSECUTIVE_WORK_DAYS',
						employment_id: employmentId,
						dates: [...run],
						message: `${run.length} consecutive working days from ${run[0]} to ${run.at(-1)}, above the pattern's limit of ${input.limits.max_consecutive_work_days}.`
					});
				}
				run = [];
			};
			for (const day of days) {
				if (day.designation !== 'WORK') {
					flush();
					continue;
				}
				const previous = run.at(-1);
				if (previous != null && dayNumber(day.work_date) - dayNumber(previous) !== 1) flush();
				run.push(day.work_date);
			}
			flush();
		}

		// Weekly rest, judged only over weeks whose seven days are all present in the input.
		const weeks = new Map<number, ValidationDay[]>();
		for (const day of days) {
			const key = weekStartNumber(day.work_date, input.limits.week_starts_on);
			const bucket = weeks.get(key);
			if (bucket) bucket.push(day);
			else weeks.set(key, [day]);
		}
		for (const weekDays of weeks.values()) {
			if (weekDays.length < 7) continue;
			const restDays = weekDays.filter((day) => day.designation === 'REST');
			if (restDays.length >= input.limits.min_rest_days_per_week) continue;
			const from = weekDays[0]!.work_date;
			const to = weekDays.at(-1)!.work_date;
			violations.push({
				code: 'WEEKLY_REST_SHORTFALL',
				employment_id: employmentId,
				dates: weekDays.map((day) => day.work_date),
				message: `The week of ${from} to ${to} grants ${restDays.length} rest day(s) but at least ${input.limits.min_rest_days_per_week} is required. A rest day is a statutory entitlement under EA 1955 s.59, not an off day.`
			});
		}
	}

	return violations;
}
