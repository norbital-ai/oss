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
import {
	WEEKDAY_CODES,
	dateKey,
	requiredDateKey,
	weekdayCode,
	weekdayIndex,
	type IsoDate
} from './dates.js';
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
	 */
	readonly clampStart: string | null;
	/** Contracted hours for a working day of this employment. */
	readonly normalHours: number;
};

export interface WeeklyHoursTerms {
	readonly ordinary_hours_per_week: number;
	readonly working_days_per_week: number;
}

export interface ScheduleTerms extends WeeklyHoursTerms {
	/** Widened: a generated enum column is nullable. An unknown rest day is a data fault. */
	readonly rest_day: string | null;
}

type RosterEntry = {
	readonly work_date: string | Date;
	readonly shift_definition_id: string;
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

/**
 * Which weekdays a fixed-week employee works, when no roster says otherwise.
 *
 * The rest day is named on the terms. The remaining working days are counted backwards from the
 * day before the rest day, so a six-day week with Sunday rest works Monday to Saturday and a
 * five-day week with Sunday rest works Monday to Friday, leaving Saturday an off day rather than a
 * second rest day — an off day is worked at the ordinary rate, a rest day at the rest-day rate, and
 * the difference is real money.
 */
function fixedWeekDayType(date: IsoDate, terms: ScheduleTerms): Exclude<DayType, 'PUBLIC_HOLIDAY'> {
	if (terms.rest_day == null)
		throw new Error(
			'Employment terms name no rest day, so a week with no roster cannot be resolved. ' +
				'Every employment states its rest day; without it a rest day is indistinguishable from ' +
				'an ordinary one and rest-day work would be paid at the ordinary rate.'
		);
	if (weekdayCode(date) === terms.rest_day) return 'REST_DAY';
	const restIndex = WEEKDAY_CODES.indexOf(terms.rest_day as (typeof WEEKDAY_CODES)[number]);
	if (restIndex < 0) throw new Error(`Unknown rest day "${terms.rest_day}".`);
	const workingDays = Math.min(6, Math.max(0, Math.round(Number(terms.working_days_per_week))));
	const offDays = 6 - workingDays;
	for (let offset = offDays + 1; offset <= 6; offset += 1) {
		if ((restIndex - offset + 7) % 7 === weekdayIndex(date)) return 'ORDINARY';
	}
	return 'OFF_DAY';
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
			: fixedWeekDayType(date, terms);
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
