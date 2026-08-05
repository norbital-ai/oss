/**
 * What a day *is*, and what shift governs it.
 *
 * `day_type` is never stored. It is decided at calculation time from the roster, the terms and the
 * holiday calendar, so a roster correction or a newly gazetted holiday is picked up by the next
 * build without rewriting a single row (plan 06 §1).
 *
 * `OFF` is a third kind, not a synonym for `REST`. A rostered non-working day that is nonetheless
 * worked has no scheduled shift to run past, so every clocked hour on it is overtime — but at the
 * **ordinary** multiplier, because an off day is neither a rest day nor a public holiday.
 * Collapsing it into either one misprices every hour worked on it (decision E27).
 */

import type { Configuration, ShiftDefinition } from './configuration.js';
import { WEEKDAY_CODES, dateKey, requiredDateKey, weekdayCode, type IsoDate } from './dates.js';
import { coversDate } from './effective.js';

export type DayType = 'ORDINARY' | 'REST_DAY' | 'PUBLIC_HOLIDAY' | 'OFF_DAY';

/** The overtime rules are stated for three day types; an off day is priced as an ordinary one. */
export type RuleDayType = 'ORDINARY' | 'REST_DAY' | 'PUBLIC_HOLIDAY';

export function ruleDayType(dayType: DayType): RuleDayType {
	return dayType === 'OFF_DAY' ? 'ORDINARY' : dayType;
}

export type ScheduledDay = {
	readonly date: IsoDate;
	readonly dayType: DayType;
	/** The shift rostered for the day, or `null` for a fixed-week employee with no roster. */
	readonly shift: ShiftDefinition | null;
	/**
	 * The shift start used to clamp an early clock-in. On a rest or off day the employee's ordinary
	 * shift start is carried over, so arriving before their normal starting time is still unpaid.
	 *
	 * That carry-over is what makes a worked rest day measurable without pinning a shift to it. It
	 * is taken from the first ORDINARY rostered day of the whole window — the loop below settles
	 * `clampStart` across every date before any `ScheduledDay` is built, so it does not matter
	 * whether the rest day falls before or after the working day it borrows from.
	 */
	readonly clampStart: string | null;
	/** Contracted hours for a working day of this employment. */
	readonly normalHours: number;
};

export interface WeeklyHoursTerms {
	readonly ordinary_hours_per_week: number;
	readonly working_days_per_week: number;
}

/**
 * The shape of a week as a work pattern names it.
 *
 * `week_starts_on` is deliberately absent: deciding what one day *is* only needs to know which set
 * that weekday belongs to. Where the week begins matters when counting rest days per week — that is
 * the roster publication check's job, not this one's.
 */
export type WeekShape = {
	readonly rest_days: readonly string[];
	readonly off_days: readonly string[];
};

export interface ScheduleTerms extends WeeklyHoursTerms {
	/** Widened: a generated enum column is nullable. An unknown rest day is a data fault. */
	readonly rest_day: string | null;
	/**
	 * What the employment's work pattern says about its week.
	 *
	 * A `WeekShape` comes from a STANDARD pattern and is authoritative — it names the rest and off
	 * days outright. `'ROSTERED'` means the roster decides every day. `null` means terms written
	 * before patterns existed, which fall back to `rest_day` and `working_days_per_week`.
	 */
	readonly week?: WeekShape | 'ROSTERED' | null;
}

/**
 * `shift_definition_id` is null on a REST or OFF entry: those arms schedule no shift.
 *
 * Rows written before the roster took that shape may still carry one, and they resolve exactly as
 * they always did — the read below is null-tolerant rather than null-assuming.
 */
type RosterEntry = {
	readonly work_date: string | Date;
	readonly shift_definition_id: string | null;
	readonly designation: string | null;
};

/**
 * Contracted hours on a working day: the weekly hours spread over the weekly working days. This is
 * a term of the employment, not a property of whichever shift happened to be rostered.
 */
export function normalDailyHours(terms: WeeklyHoursTerms): number {
	const days = Number(terms.working_days_per_week);
	if (!(days > 0)) throw new Error('working_days_per_week must be greater than zero.');
	return Number(terms.ordinary_hours_per_week) / days;
}

/** A week read in the conventional order, used only by the legacy inference below. */
const LEGACY_WEEK_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;

/** What a day is when a STANDARD work pattern has named the week outright. */
function patternDayType(date: IsoDate, week: WeekShape): Exclude<DayType, 'PUBLIC_HOLIDAY'> {
	const code = weekdayCode(date);
	if (week.rest_days.includes(code)) return 'REST_DAY';
	if (week.off_days.includes(code)) return 'OFF_DAY';
	return 'ORDINARY';
}

/**
 * Which weekdays a fixed-week employee works, for terms that name no work pattern.
 *
 * The rest day is named on the terms; the working days are then taken in week order, skipping it,
 * until `working_days_per_week` is satisfied. Everything left over is an off day — worked at the
 * ordinary rate, where a rest day is worked at the rest-day rate, and the difference is real money.
 *
 * A five-day week resting Sunday therefore works Monday to Friday and leaves Saturday off. This is
 * an inference, and it can only ever be a guess about *which* non-rest days are the off ones: it
 * happens to be right for a week that runs Monday to Friday and wrong for one that runs Tuesday to
 * Saturday, and it cannot tell the two apart. Naming a work pattern removes the guess.
 */
function legacyWeekDayType(
	date: IsoDate,
	terms: ScheduleTerms
): Exclude<DayType, 'PUBLIC_HOLIDAY'> {
	if (terms.rest_day == null)
		throw new Error(
			'Employment terms name neither a work pattern nor a rest day, so a week with no roster ' +
				'cannot be resolved. Without one a rest day is indistinguishable from an ordinary day ' +
				'and rest-day work would be paid at the ordinary rate.'
		);
	if (!WEEKDAY_CODES.includes(terms.rest_day as (typeof WEEKDAY_CODES)[number]))
		throw new Error(`Unknown rest day "${terms.rest_day}".`);
	const code = weekdayCode(date);
	if (code === terms.rest_day) return 'REST_DAY';
	const workingDays = Math.min(6, Math.max(0, Math.round(Number(terms.working_days_per_week))));
	const working = LEGACY_WEEK_ORDER.filter((day) => day !== terms.rest_day).slice(0, workingDays);
	return working.includes(code as (typeof LEGACY_WEEK_ORDER)[number]) ? 'ORDINARY' : 'OFF_DAY';
}

/**
 * What a day is when no roster entry covers it.
 *
 * A rostered employment answers this with `OFF_DAY` rather than by inference. The roster is the
 * authority for those people, so a day it does not mention is a day it did not schedule — and an
 * off day is the kind that is neither worked nor a rest-day entitlement. Guessing a rest day here
 * would hand out the rest-day multiple on a day nobody rostered as rest.
 */
function derivedDayType(date: IsoDate, terms: ScheduleTerms): Exclude<DayType, 'PUBLIC_HOLIDAY'> {
	if (terms.week === 'ROSTERED') return 'OFF_DAY';
	if (terms.week != null) return patternDayType(date, terms.week);
	return legacyWeekDayType(date, terms);
}

/**
 * Resolve every day of a window for one employment.
 *
 * The public-holiday test comes first: a holiday is a holiday whatever the roster says. Scope is
 * honoured — a regional holiday only applies where the company observes it, and with no location
 * recorded on an employment the national holidays are the ones that bind.
 */
export function resolveSchedule(options: {
	readonly window: { readonly start: IsoDate; readonly end: IsoDate };
	readonly dates: readonly IsoDate[];
	readonly terms: (date: IsoDate) => ScheduleTerms;
	readonly rosterEntries: readonly RosterEntry[];
	readonly configuration: Pick<Configuration, 'holidays' | 'shiftById'>;
}): Map<IsoDate, ScheduledDay> {
	const rosterByDate = new Map<IsoDate, RosterEntry>();
	for (const entry of options.rosterEntries) {
		rosterByDate.set(requiredDateKey(entry.work_date, 'roster_entries.work_date'), entry);
	}

	const shiftFor = (id: string | null, date: IsoDate): ShiftDefinition | null => {
		if (id == null) return null;
		const shift = options.configuration.shiftById.get(id);
		if (!shift) throw new Error(`Roster on ${date} names a shift that does not exist.`);
		if (!coversDate(shift.effective_range, date))
			throw new Error(`Shift ${shift.code} is not effective on ${date}.`);
		return shift;
	};

	const resolved = new Map<IsoDate, ScheduledDay>();
	// The clamp start is the employee's own ordinary shift start, taken from the first rostered
	// working day of the window and reused on days that carry no shift of their own.
	let clampStart: string | null = null;
	const pending: {
		date: IsoDate;
		baseDayType: Exclude<DayType, 'PUBLIC_HOLIDAY'>;
		dayType: DayType;
		shift: ShiftDefinition | null;
	}[] = [];
	for (const date of options.dates) {
		const roster = rosterByDate.get(date);
		const terms = options.terms(date);
		const holiday = options.configuration.holidays.get(date);
		const baseDayType: Exclude<DayType, 'PUBLIC_HOLIDAY'> = roster
			? roster.designation === 'WORK'
				? 'ORDINARY'
				: roster.designation === 'REST'
					? 'REST_DAY'
					: 'OFF_DAY'
			: derivedDayType(date, terms);
		// A holiday on the statutory rest day is substituted under s.60D(1): the original day
		// remains REST_DAY and the following working day becomes PUBLIC_HOLIDAY.
		const dayType: DayType = holiday && baseDayType !== 'REST_DAY' ? 'PUBLIC_HOLIDAY' : baseDayType;
		const shift = shiftFor(roster?.shift_definition_id ?? null, date);
		if (clampStart == null && dayType === 'ORDINARY' && shift) clampStart = shift.start_time;
		pending.push({ date, baseDayType, dayType, shift });
	}

	/*
	 * EA 1955 s.60D(1): when a public holiday falls on the employee's rest day, the immediately
	 * following working day becomes the substituted paid holiday. This must be employee-specific:
	 * a shift roster may designate any weekday as REST. An explicitly configured substitute row
	 * wins and suppresses automatic derivation for its original holiday.
	 */
	const explicitlySubstituted = new Set(
		[...options.configuration.holidays.values()]
			.map((holiday) => dateKey(holiday.substitutes_date))
			.filter((date) => date != null)
	);
	const substituteDates = new Set<IsoDate>();
	for (let index = 0; index < pending.length; index += 1) {
		const holidayDay = pending[index]!;
		if (
			!options.configuration.holidays.has(holidayDay.date) ||
			holidayDay.baseDayType !== 'REST_DAY' ||
			explicitlySubstituted.has(holidayDay.date)
		)
			continue;
		for (let candidateIndex = index + 1; candidateIndex < pending.length; candidateIndex += 1) {
			const candidate = pending[candidateIndex]!;
			if (candidate.baseDayType !== 'ORDINARY') continue;
			if (options.configuration.holidays.has(candidate.date) || substituteDates.has(candidate.date))
				continue;
			substituteDates.add(candidate.date);
			candidate.dayType = 'PUBLIC_HOLIDAY';
			break;
		}
	}

	for (const day of pending) {
		resolved.set(day.date, {
			date: day.date,
			dayType: day.dayType,
			shift: day.shift,
			clampStart: day.shift?.start_time ?? clampStart,
			normalHours: normalDailyHours(options.terms(day.date))
		});
	}
	return resolved;
}
