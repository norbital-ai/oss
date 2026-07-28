/**
 * The ordinary rate of pay, and one day's wages.
 *
 * The divisor is statutory and lives on `jurisdictions` — Malaysia's 26 is EA s.60I, Indonesia's
 * 173 is PP 35/2021, Singapore's 190.67 is 12 × monthly ÷ (52 × 44). A company using 30 where the
 * statute says 26 underpays every overtime hour by 15%, which is why it is not a company setting.
 *
 * Two details matter for parity:
 *
 * - the numerator is the **unprorated** contract salary, so a mid-month joiner's overtime is priced
 *   at their full-month rate, not their part-month pay (decision E4);
 * - the rate is rounded to cents **before** it is multiplied by hours, never after.
 *
 * Normal hours in an overtime-rate day are the employment's contractual weekly hours divided by
 * its contractual working days. That is the employee's normal day; a payroll-system convention
 * cannot replace it with a different schedule.
 */

import type { Jurisdiction } from './configuration.js';
import { monthDays } from './dates.js';
import { cents } from './rounding.js';
import { normalDailyHours } from './schedule.js';

export type RateTerms = {
	readonly base_salary: { readonly value: number; readonly currency: string };
	readonly pay_frequency: 'MONTHLY' | 'SEMI_MONTHLY' | 'WEEKLY' | 'DAILY' | 'HOURLY';
	readonly ordinary_hours_per_week: number;
	readonly working_days_per_week: number;
};

export type OvertimeCalculationMethod = 'STATUTORY_AGGREGATE' | 'INFOTECH_ANNUALISED_DATED';

export function readOvertimeCalculationMethod(value: string | null): OvertimeCalculationMethod {
	switch (value) {
		case 'STATUTORY_AGGREGATE':
		case 'INFOTECH_ANNUALISED_DATED':
			return value;
		default:
			throw new Error('companies.overtime_calculation_method must name a supported method.');
	}
}

/**
 * The Philippines uses 261 annual days for a five-day week and 313 for a six-day week. The
 * jurisdiction row stores the common monthly divisor (261 / 12 = 21.75); the employee's stated
 * working week selects the statutory 313-day alternative when it exceeds forty ordinary hours.
 *
 * This is employee-level law, so it cannot be represented by replacing the jurisdiction's one
 * divisor with a company-wide value.
 */
function ordinaryRateDivisor(terms: RateTerms, jurisdiction: Jurisdiction): number {
	if (
		jurisdiction.code === 'PH' &&
		Number(terms.ordinary_hours_per_week) > 40 &&
		jurisdiction.ordinary_rate_basis === 'DAYS_PER_MONTH'
	)
		return 313 / 12;
	return Number(jurisdiction.ordinary_rate_divisor);
}

/**
 * The monthly-equivalent contract wage.
 *
 * `base_salary` is the monthly contract wage for both monthly and semi-monthly payroll groups.
 * `pay_frequency` controls when that wage is paid; it does not change the wage's unit. Treating a
 * semi-monthly employee's stored salary as one half-period doubled every OT and absence rate.
 *
 * Weekly, daily and hourly contracts are converted because those are genuinely different wage
 * bases. They still need their own proration story before those populations are trusted.
 */
export function monthlyBaseSalary(terms: RateTerms): number {
	const value = Number(terms.base_salary.value);
	const hoursPerDay = Number(terms.ordinary_hours_per_week) / Number(terms.working_days_per_week);
	switch (terms.pay_frequency) {
		case 'MONTHLY':
			return value;
		case 'SEMI_MONTHLY':
			return value;
		case 'WEEKLY':
			return (value * 52) / 12;
		case 'DAILY':
			return (value * Number(terms.working_days_per_week) * 52) / 12;
		case 'HOURLY':
			return (value * hoursPerDay * Number(terms.working_days_per_week) * 52) / 12;
	}
}

/** Pay for one ordinary hour, rounded to cents before any multiplication. */
export function ordinaryHourlyRate(terms: RateTerms, jurisdiction: Jurisdiction): number {
	const divisor = ordinaryRateDivisor(terms, jurisdiction);
	if (!(divisor > 0)) throw new Error('jurisdictions.ordinary_rate_divisor must be positive.');
	const monthly = monthlyBaseSalary(terms);
	return jurisdiction.ordinary_rate_basis === 'HOURS_PER_MONTH'
		? cents(monthly / divisor)
		: cents(monthly / divisor / normalDailyHours(terms));
}

/**
 * Contract rate used by Infotech: annual salary divided by contracted annual hours. The employee
 * master expresses annual hours as weekly hours × 52, so no company-wide day divisor is involved.
 */
export function annualisedContractHourlyRate(terms: RateTerms): number {
	const annualHours = Number(terms.ordinary_hours_per_week) * 52;
	if (!(annualHours > 0)) throw new Error('Contracted annual hours must be positive.');
	return cents((monthlyBaseSalary(terms) * 12) / annualHours);
}

/** The company-selected OT rate, never below the jurisdiction's statutory ordinary-hour rate. */
export function overtimeHourlyRate(
	terms: RateTerms,
	jurisdiction: Jurisdiction,
	method: OvertimeCalculationMethod
): number {
	const statutory = ordinaryHourlyRate(terms, jurisdiction);
	switch (method) {
		case 'STATUTORY_AGGREGATE':
			return statutory;
		case 'INFOTECH_ANNUALISED_DATED':
			return Math.max(annualisedContractHourlyRate(terms), statutory);
		default:
			return method satisfies never;
	}
}

/**
 * One day's wages — what a `DAY_WAGE_MULTIPLE` overtime award multiplies.
 *
 * On a days-per-month basis this is the divisor itself; on an hours-per-month basis there is no day
 * in the statute at all, so a day is the contracted daily hours priced at the hourly rate
 * (decision E28).
 */
export function ordinaryDayWage(terms: RateTerms, jurisdiction: Jurisdiction): number {
	const divisor = ordinaryRateDivisor(terms, jurisdiction);
	const monthly = monthlyBaseSalary(terms);
	return jurisdiction.ordinary_rate_basis === 'HOURS_PER_MONTH'
		? cents((monthly * normalDailyHours(terms)) / divisor)
		: cents(monthly / divisor);
}

/**
 * What one day of *withheld* pay is worth.
 *
 * Deliberately not `ordinaryDayWage`. That divisor answers "what is an extra day of work worth"
 * (EA s.60I: 26). Withholding pay for a day not worked is proration, and proration is configured in
 * exactly one place — `jurisdictions.proration` — so an absence follows the month's calendar days,
 * its working days, or a fixed divisor, whichever that jurisdiction states.
 *
 * Conflating the two over-deducts by the ratio between the divisors: 31/26 in a 31-day Malaysian
 * month, about 19% on every employee with unpaid leave.
 *
 * The rate is rounded to the cent **before** the day count multiplies it. Rounding after instead
 * moves the result by a cent or two on most absences, which is the difference between reproducing
 * the source system and merely being close to it.
 */
export function absenceDayRate(options: {
	readonly terms: RateTerms;
	readonly jurisdiction: Jurisdiction;
	readonly period: { readonly start: string; readonly end: string };
	readonly workingDaysIn: (range: { readonly start: string; readonly end: string }) => number;
}): number {
	const monthly = monthlyBaseSalary(options.terms);
	const proration = options.jurisdiction.proration;
	if (proration == null) throw new Error('The jurisdiction states no proration basis.');
	switch (proration.by) {
		case 'CALENDAR_DAYS':
			return cents(monthly / monthDays(options.period.start));
		case 'WORKING_DAYS': {
			const days = options.workingDaysIn(options.period);
			if (!(days > 0))
				throw new Error(
					`The period ${options.period.start}..${options.period.end} has no working days, so an ` +
						'absence in it cannot be priced.'
				);
			return cents(monthly / days);
		}
		case 'FIXED_DAYS': {
			if (!(proration.days > 0))
				throw new Error('A FIXED_DAYS proration basis needs a positive divisor.');
			return cents(monthly / proration.days);
		}
	}
	throw new Error(`Unsupported proration basis: ${Reflect.get(proration, 'by')}`);
}
