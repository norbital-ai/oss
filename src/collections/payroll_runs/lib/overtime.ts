/**
 * Clocks become hours; hours become money.
 *
 * Overtime is the one place payroll depends on what actually happened rather than what was agreed,
 * and it is where a rebuild is most likely to silently change someone's pay. Overtime is **computed
 * here, never stored**: a time entry records punches, and every hour of overtime on this payslip is
 * derived from those punches, the statutory day type and the effective employment terms. Nothing
 * upstream may hand payroll a duration it did not derive, because a stored duration and the clock it
 * came from can disagree, and only one of them is what the employee actually worked.
 *
 * Five independent facts decide whether a clocked hour earns anything, and every one of them exists
 * because a population needed it:
 *
 * 1. `shift_definitions.pays_overtime` — a fixed office shift never pays overtime, whatever the
 *    clock says. Without it, office staff start earning for staying late.
 * 2. `time_entries.overtime_in` / `overtime_out` — where a jurisdiction punches overtime
 *    separately, **that punch is the overtime** and a regular-clock overrun earns nothing.
 * 3. `shift_definitions.overtime_break_minutes` — unpaid rest between the shift ending and overtime
 *    starting, deducted from the overtime.
 * 4. the clock-in is clamped forward to the shift start — arriving early is not working.
 * 5. hours are floored to the half hour below, with no one-hour minimum.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * REST-DAY AND PUBLIC-HOLIDAY WORK IS PRICED BY STATUTE, FROM THE SEEDED RULES.
 *
 * Hours up to the normal day pay the highest `FROM_START_OF_DAY` band entered — a day's wages is
 * never paid twice — and only hours beyond the normal day run through the `BEYOND_NORMAL` ladder.
 * That is EA s.60(3) and s.60D(3), and for every other jurisdiction it is whatever that
 * jurisdiction's `overtime_rules` rows say.
 *
 * This deliberately differs from the pre-refactor engine, which paid every clocked hour at a flat
 * multiple of the hourly rate — roughly RM88 per rest day per employee more, and routed to an
 * EPF-liable component where statutory overtime is EPF-exempt. That reading reconciled against the
 * customer's workbook; it is not what the Act says, and the customer's workbook is not the law.
 * The divergence is expected and accounted for (decision E27 / risk register #3).
 *
 * There is no switch. The ladder is data: change `overtime_rules`, not this file.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import type { OvertimeRule } from './configuration.js';
import { monthKey, requiredDateKey, type IsoDate } from './dates.js';
import { floorHalfHour } from './rounding.js';
import { ruleDayType, type DayType, type RuleDayType, type ScheduledDay } from './schedule.js';

/**
 * The wall-clock frame attendance is recorded in, in minutes east of UTC.
 *
 * A shift start is a wall-clock time and a punch is an instant, so pairing them needs an offset.
 * Nothing in the schema carries one today — neither `companies` nor `jurisdictions` has a timezone
 * column — so it is stated here, as the pre-refactor engine also did (`ATTENDANCE_TZ_OFFSET`).
 *
 * **This must match the frame the attendance clocks are stored in.** The seed writes them as
 * `+08:00` instants (`2025-12-31T08:17:00.000+08:00`), and both populations — Malaysia and the
 * Philippines — are fixed UTC+8 with no daylight saving, so a single constant is exact for them.
 * Left at 0 it would anchor each work date to UTC midnight and throw the early-clock-in clamp and
 * the shift-end comparison out by eight hours, silently mispricing every overtime hour.
 *
 * This constant is the single place a real timezone column would be consumed once one exists; a
 * third jurisdiction off UTC+8 requires that column rather than a change here.
 */
export const ATTENDANCE_UTC_OFFSET_MINUTES = 8 * 60;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type TimeEntryLike = {
	readonly norbital_id: string;
	readonly work_date: string | Date;
	readonly clock_in: Date | string | null;
	readonly clock_out: Date | string | null;
	readonly break_minutes: number;
	/** Widened: a generated enum column is nullable, so `OPEN` is tested for rather than assumed. */
	readonly state: string | null;
	readonly overtime_in: Date | string | null;
	readonly overtime_out: Date | string | null;
};

/** Minutes since midnight of a `HH:MM[:SS]` wall-clock time. */
export function clockMinutes(value: string): number {
	const [hours, minutes] = value.split(':').map(Number);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes))
		throw new Error(`"${value}" is not a wall-clock time.`);
	return hours! * 60 + minutes!;
}

function instant(value: Date | string): number {
	return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Midnight starting `date`, in the frame attendance is recorded in. */
function midnight(date: IsoDate): number {
	return Date.parse(`${date}T00:00:00.000Z`) - ATTENDANCE_UTC_OFFSET_MINUTES * MINUTE_MS;
}

/**
 * Hours actually worked on a day, from the clocks.
 *
 * Time clocked before the scheduled start is discarded: an employee who arrives early is not
 * working, and not paid, until their shift begins. The unpaid break is deducted from what remains,
 * never below zero — the schema records a flat `break_minutes` rather than break windows, so an
 * overlap test is not available here (see the note in the module report).
 */
export function clockedWorkHours(options: {
	readonly clockIn: Date | string | null;
	readonly clockOut: Date | string | null;
	readonly workDate: IsoDate;
	readonly clampStart: string | null;
	readonly breakMinutes: number;
}): number {
	if (options.clockIn == null || options.clockOut == null) return 0;
	let startMs = instant(options.clockIn);
	const endMs = instant(options.clockOut);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
	if (options.clampStart != null) {
		const scheduledStartMs =
			midnight(options.workDate) + clockMinutes(options.clampStart) * MINUTE_MS;
		if (scheduledStartMs > startMs) startMs = scheduledStartMs;
		if (endMs <= startMs) return 0;
	}
	const worked = (endMs - startMs) / HOUR_MS;
	return Math.max(0, worked - Math.max(0, Number(options.breakMinutes)) / 60);
}

/**
 * Hours clocked out after the scheduled end of the shift.
 *
 * An overnight shift ends on the following calendar day, so its end is carried forward whenever it
 * is not after its start. This depends only on the clock-out: arriving late is undertime, deducted
 * separately, and never shortens the overtime earned (decision E4).
 */
export function hoursPastShiftEnd(options: {
	readonly clockOut: Date | string | null;
	readonly workDate: IsoDate;
	readonly shiftStart: string;
	readonly shiftEnd: string;
	readonly crossesMidnight: boolean;
}): number {
	if (options.clockOut == null) return 0;
	const clockOutMs = instant(options.clockOut);
	if (!Number.isFinite(clockOutMs)) return 0;
	const startMinutes = clockMinutes(options.shiftStart);
	let endMinutes = clockMinutes(options.shiftEnd);
	if (options.crossesMidnight || endMinutes <= startMinutes) endMinutes += 1440;
	const shiftEndMs = midnight(options.workDate) + endMinutes * MINUTE_MS;
	return Math.max(0, (clockOutMs - shiftEndMs) / HOUR_MS);
}

/** Duration of a dedicated overtime punch. */
export function overtimePunchHours(
	overtimeIn: Date | string | null,
	overtimeOut: Date | string | null
): number {
	if (overtimeIn == null || overtimeOut == null) return 0;
	const start = instant(overtimeIn);
	const end = instant(overtimeOut);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
	return (end - start) / HOUR_MS;
}

/**
 * Hours inside the Philippines' 22:00–06:00 statutory night-work window.
 *
 * Attendance is already assigned to a work date. The window therefore starts at 22:00 on that
 * date and ends at 06:00 the next day, which also handles an overtime punch continuing past the
 * scheduled night shift. The overlap is derived from the actual clock rather than a payroll
 * workbook amount.
 */
export function philippineNightWorkHours(entry: TimeEntryLike): number {
	if (entry.clock_in == null || entry.clock_out == null) return 0;
	const start = instant(entry.clock_in);
	const end = instant(entry.clock_out);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
	const workDate = requiredDateKey(entry.work_date, 'time_entries.work_date');
	const nightStart = midnight(workDate) + 22 * HOUR_MS;
	const nightEnd = midnight(workDate) + 30 * HOUR_MS;
	return Math.max(0, Math.min(end, nightEnd) - Math.max(start, nightStart)) / HOUR_MS;
}

/** One day's overtime, before it is priced. */
export type DailyOvertime = {
	readonly date: IsoDate;
	readonly timeEntryId: string;
	readonly dayType: DayType;
	/** Floored to the half hour. Never negative, never zero — a zero day is dropped. */
	readonly hours: number;
	/** Contracted hours for the day, the boundary `STATUTORY_DAY_WAGE` bands against. */
	readonly normalHours: number;
	/** Actual hours at the employer's disposal, used only to locate the total-work-hours boundary. */
	readonly totalWorkHours: number;
};

/**
 * Derive one day's overtime hours from one attendance record.
 *
 * Returns `null` when the day earns nothing, which is the common case: the gates fire, or the
 * overrun floors away to zero. A day that earns nothing produces no entry at all rather than a
 * zero one, so provenance never claims a payslip line consumed a record it did not.
 */
export function deriveDailyOvertime(entry: TimeEntryLike, day: ScheduledDay): DailyOvertime | null {
	const workDate = requiredDateKey(entry.work_date, 'time_entries.work_date');
	if (entry.state === 'OPEN') throw new Error(`Time entry on ${workDate} is still open.`);
	if (day.shift?.pays_overtime === false) return null;

	const shift = day.shift;
	// A rest, off or holiday day has no shift to run past, and neither has a fixed-week employee
	// with no roster: on those days every clocked hour is overtime.
	const shiftToRunPast = day.dayType === 'ORDINARY' ? shift : null;

	// Three sources, in descending order of how directly they record the overtime itself. Each is a
	// clock, never an assertion about hours: a dedicated punch says exactly when overtime ran; a day
	// with no shift to run past is overtime from the first minute; otherwise the overrun past the
	// scheduled end is what the employee stayed for.
	let raw: number;
	if (entry.overtime_in != null && entry.overtime_out != null) {
		raw = overtimePunchHours(entry.overtime_in, entry.overtime_out);
	} else if (shiftToRunPast == null) {
		raw = clockedWorkHours({
			clockIn: entry.clock_in,
			clockOut: entry.clock_out,
			workDate,
			clampStart: day.clampStart,
			breakMinutes: shift ? shift.break_minutes : entry.break_minutes
		});
	} else {
		raw =
			hoursPastShiftEnd({
				clockOut: entry.clock_out,
				workDate,
				shiftStart: shiftToRunPast.start_time,
				shiftEnd: shiftToRunPast.end_time,
				crossesMidnight: shiftToRunPast.crosses_midnight
			}) -
			Number(shiftToRunPast.overtime_break_minutes) / 60;
	}

	const hours = floorHalfHour(Math.max(0, raw));
	if (hours <= 0) return null;
	const clockedTotal = clockedWorkHours({
		clockIn: entry.clock_in,
		clockOut: entry.clock_out,
		workDate,
		clampStart: day.clampStart,
		breakMinutes: shift ? shift.break_minutes : entry.break_minutes
	});
	const totalWorkHours =
		clockedTotal > 0 ? clockedTotal : day.dayType === 'ORDINARY' ? day.normalHours + hours : hours;
	return {
		date: workDate,
		timeEntryId: entry.norbital_id,
		dayType: day.dayType,
		hours,
		normalHours: day.normalHours,
		totalWorkHours
	};
}

/** A slice of a day's overtime priced by one statutory rule. */
export type PricedSegment = {
	readonly rule: OvertimeRule;
	readonly dayType: RuleDayType;
	readonly measure: 'BEYOND_NORMAL' | 'FROM_START_OF_DAY';
	/** The rule band's lower bound, which is how a pay component names the rule it pays. */
	readonly bandFrom: number;
	/** Hours in the band. Zero for a day-wage award, which pays flat. */
	readonly hours: number;
	/** Multiple of the hourly rate, or of a day's wages for a `DAY_WAGE_MULTIPLE` award. */
	readonly multiple: number;
	readonly award: 'HOURLY_MULTIPLE' | 'DAY_WAGE_MULTIPLE';
	readonly date: IsoDate;
	readonly timeEntryId: string;
};

/** Statutory excess value reclassified to incentive rather than discarded. */
export type ExcessHours = {
	readonly date: IsoDate;
	readonly timeEntryId: string;
	readonly dayType: RuleDayType;
	readonly measure: 'BEYOND_NORMAL' | 'FROM_START_OF_DAY';
	readonly bandFrom: number;
	readonly hours: number;
	/**
	 * Hourly awards store `hours × multiple`; day-wage awards store the additional day-wage
	 * multiple earned beyond the retained statutory OT hours.
	 */
	readonly units: number;
	readonly valuedAt: 'ORDINARY_HOURLY' | 'ORDINARY_DAY_WAGE';
};

export type ClassifiedDailyOvertime = {
	readonly day: DailyOvertime;
	/** Hours retained in statutory overtime components after daily and calendar-month controls. */
	readonly retainedHours: number;
	/** Hours routed to incentive components at the same statutory value. */
	readonly excessHours: number;
};

/**
 * Apply Malaysian-style statutory controls in chronological calendar-month order.
 *
 * The monthly counter includes only ordinary-day overtime (OFF_DAY uses the ordinary rule). Work
 * on a rest day or public holiday is expressly excluded by the 1980 Regulations. The counter still
 * advances by the whole qualifying day, even if part of that day already exceeded the daily
 * total-work boundary, so reclassification cannot make statutory hours disappear.
 */
export function classifyOvertimeByCalendarMonth(options: {
	readonly days: readonly DailyOvertime[];
	readonly dailyWorkLimit: number | null;
	readonly monthlyOrdinaryOvertimeLimit: number | null;
}): ClassifiedDailyOvertime[] {
	const ordinaryHoursByMonth = new Map<string, number>();
	return options.days
		.toSorted((left, right) => left.date.localeCompare(right.date))
		.map((day) => {
			const dailyRetained =
				options.dailyWorkLimit == null
					? day.hours
					: Math.max(
							0,
							day.hours - floorHalfHour(Math.max(0, day.totalWorkHours - options.dailyWorkLimit))
						);
			let monthlyRetained = day.hours;
			if (options.monthlyOrdinaryOvertimeLimit != null && ruleDayType(day.dayType) === 'ORDINARY') {
				const month = monthKey(day.date);
				const before = ordinaryHoursByMonth.get(month) ?? 0;
				monthlyRetained = Math.min(
					day.hours,
					Math.max(0, options.monthlyOrdinaryOvertimeLimit - before)
				);
				ordinaryHoursByMonth.set(month, before + day.hours);
			}
			const retainedHours = Math.min(day.hours, dailyRetained, monthlyRetained);
			return {
				day,
				retainedHours,
				excessHours: day.hours - retainedHours
			};
		});
}

type ResolvedRule = {
	readonly row: OvertimeRule;
	readonly measure: 'BEYOND_NORMAL' | 'FROM_START_OF_DAY';
	readonly from: number;
	readonly to: number | null;
	readonly award: 'HOURLY_MULTIPLE' | 'DAY_WAGE_MULTIPLE';
	readonly multiple: number;
};

function resolveRule(rule: OvertimeRule): ResolvedRule {
	const { band, award } = rule;
	if (band == null)
		throw new Error(`Overtime rule ${rule.authority} has no band, so no hour can enter it.`);
	if (award == null)
		throw new Error(`Overtime rule ${rule.authority} has no award, so it would pay nothing.`);
	const bounds =
		band.measure === 'BEYOND_NORMAL'
			? { from: band.from_hours, to: band.to_hours }
			: { from: band.from_fraction, to: band.to_fraction };
	return {
		row: rule,
		measure: band.measure,
		from: bounds.from,
		to: bounds.to,
		award: award.kind,
		multiple: award.multiple
	};
}

/** Rules for one day type, ascending by band floor. */
function rulesFor(
	rules: readonly OvertimeRule[],
	dayType: RuleDayType,
	measure: 'BEYOND_NORMAL' | 'FROM_START_OF_DAY'
): ResolvedRule[] {
	return rules
		.filter((rule) => rule.day_type === dayType)
		.map(resolveRule)
		.filter((rule) => rule.measure === measure)
		.toSorted((left, right) => left.from - right.from);
}

/**
 * Split a day's hours across a `BEYOND_NORMAL` ladder.
 *
 * Malaysia states one open band per day type, so this collapses to a single segment at a flat
 * multiple. Indonesia bands the first hour beyond normal separately, and the same code splits it.
 * No engine code branches on country.
 */
function spreadAcrossBands(
	hours: number,
	rules: readonly ResolvedRule[],
	offset: number
): { rule: ResolvedRule; hours: number }[] {
	const spread: { rule: ResolvedRule; hours: number }[] = [];
	let remaining = hours;
	let cursor = offset;
	for (const rule of rules) {
		if (remaining <= 0) break;
		const bandTop = rule.to == null ? Number.POSITIVE_INFINITY : rule.to;
		if (cursor >= bandTop) continue;
		const inBand = Math.min(remaining, bandTop - Math.max(cursor, rule.from));
		if (inBand <= 0) continue;
		spread.push({ rule, hours: inBand });
		remaining -= inBand;
		cursor += inBand;
	}
	if (remaining > 0.0001)
		throw new Error(
			`${remaining.toFixed(2)} overtime hours fall outside every band. The last band of a day ` +
				'type must be open-ended, or hours the employee worked go unpaid.'
		);
	return spread;
}

/**
 * Price one day's overtime.
 *
 * Daily and calendar-month controls may split the statutory award between overtime and an
 * incentive component. The legal rate ladder prices the full day first; only the value difference
 * beyond the retained hours is reclassified, never discarded.
 */
export function priceDay(options: {
	readonly day: DailyOvertime;
	readonly rules: readonly OvertimeRule[];
	readonly retainedHours: number;
}): { segments: PricedSegment[]; excess: ExcessHours[] } {
	const dayType = ruleDayType(options.day.dayType);
	const beyondNormal = rulesFor(options.rules, dayType, 'BEYOND_NORMAL');
	if (beyondNormal.length === 0)
		throw new Error(
			`The jurisdiction states no BEYOND_NORMAL overtime rule for a ${dayType}, so ` +
				`${options.day.hours} hours worked on ${options.day.date} could not be priced.`
		);

	// Whether a day's wages is payable is not a setting — it is whether the jurisdiction states a
	// FROM_START_OF_DAY band for this day type. Malaysia does, for rest days and public holidays
	// (EA s.60(3), s.60D(3)); Singapore states a single open hourly band and so pays no day wage.
	// Adding or removing that entitlement is an `overtime_rules` row, never a code change.
	const dayWageRules = rulesFor(options.rules, dayType, 'FROM_START_OF_DAY');
	const usesDayWage = dayWageRules.length > 0;

	const statutorySegments = (hours: number): PricedSegment[] => {
		const withinNormalDay = usesDayWage ? Math.min(hours, options.day.normalHours) : 0;
		const hourlyHours = hours - withinNormalDay;
		const segments: PricedSegment[] = [];
		if (usesDayWage && withinNormalDay > 0 && options.day.normalHours > 0) {
			// A day's wages is not paid twice: the highest band the day entered wins.
			const fraction = withinNormalDay / options.day.normalHours;
			const entered = dayWageRules.filter((rule) => fraction > rule.from);
			const highest = entered[entered.length - 1];
			if (!highest)
				throw new Error(
					`The jurisdiction states no FROM_START_OF_DAY rule covering ${fraction.toFixed(2)} of a ` +
						`normal day on a ${dayType}. Rest-day work under that fraction would be unpaid.`
				);
			segments.push({
				rule: highest.row,
				dayType,
				measure: 'FROM_START_OF_DAY',
				bandFrom: highest.from,
				hours: withinNormalDay,
				multiple: highest.multiple,
				award: highest.award,
				date: options.day.date,
				timeEntryId: options.day.timeEntryId
			});
		}

		// The `BEYOND_NORMAL` ladder is measured in hours beyond the normal day, so it always starts
		// at zero: the normal day has already been valued by the day-wage ladder where one exists.
		for (const slice of spreadAcrossBands(hourlyHours, beyondNormal, 0)) {
			segments.push({
				rule: slice.rule.row,
				dayType,
				measure: 'BEYOND_NORMAL',
				bandFrom: slice.rule.from,
				hours: slice.hours,
				multiple: slice.rule.multiple,
				award: slice.rule.award,
				date: options.day.date,
				timeEntryId: options.day.timeEntryId
			});
		}
		return segments;
	};

	const full = statutorySegments(options.day.hours);
	const keptHours = Math.max(0, Math.min(options.day.hours, options.retainedHours));
	if (keptHours === options.day.hours) return { segments: full, excess: [] };

	// Classification happens after statutory pricing, through the same legal ladder.
	const kept = statutorySegments(keptHours);
	const excess: ExcessHours[] = [];

	const fullDayWage = full.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE');
	if (fullDayWage) {
		const keptDayWage =
			kept.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE')?.multiple ?? 0;
		const additionalMultiple = fullDayWage.multiple - keptDayWage;
		if (additionalMultiple > 0) {
			excess.push({
				date: options.day.date,
				timeEntryId: options.day.timeEntryId,
				dayType,
				measure: fullDayWage.measure,
				bandFrom: fullDayWage.bandFrom,
				hours:
					Math.min(options.day.hours, options.day.normalHours) -
					Math.min(keptHours, options.day.normalHours),
				units: additionalMultiple,
				valuedAt: 'ORDINARY_DAY_WAGE'
			});
		}
	}

	for (const fullHourly of full.filter((segment) => segment.award === 'HOURLY_MULTIPLE')) {
		const keptHours =
			kept.find((segment) => segment.rule.norbital_id === fullHourly.rule.norbital_id)?.hours ?? 0;
		const movedHours = fullHourly.hours - keptHours;
		if (movedHours <= 0) continue;
		excess.push({
			date: options.day.date,
			timeEntryId: options.day.timeEntryId,
			dayType,
			measure: fullHourly.measure,
			bandFrom: fullHourly.bandFrom,
			hours: movedHours,
			units: movedHours * fullHourly.multiple,
			valuedAt: 'ORDINARY_HOURLY'
		});
	}
	return { segments: kept, excess };
}

/** Ordinary/off-day OT counted by the 104-hour regulation; rest-day and PH work are excluded. */
export function regulatedMonthlyOvertimeHours(
	days: readonly DailyOvertime[],
	period: string
): number {
	return days
		.filter((day) => monthKey(day.date) === period && ruleDayType(day.dayType) === 'ORDINARY')
		.reduce((total, day) => total + day.hours, 0);
}
