/**
 * The two ranges a payroll run spans.
 *
 * A company has a **pay period** — the calendar month wages belong to — and an **attendance
 * window** — the work days those wages cover. They are not the same range and they are not the
 * same length in different months.
 *
 * ```
 *   Dec                        Jan                        Feb
 * ───┼───────────┼─────────────┼───────────┼──────────────┼───►
 *    1          21             1          21              1
 *               └──── attendance window ───┘
 *                     21 Dec  →  20 Jan
 *                                           pay period 2026-01, paid 25 Jan
 * ```
 *
 * **The boundary is `[C of the previous month, C−1 of this month]`.** The plan reads cutoff day 21
 * as "the last day included" and so writes `[22 Dec, 21 Jan]`; the engine of record reads it as
 * "the first day of the new window" and computes `[21 Dec, 20 Jan]`. Both are defensible readings
 * of the same English phrase, and the second is the one that reconciles against the customer's
 * workbook, so it is the one implemented (decision E6/E19). Getting this wrong moves every 21st-of-
 * month time entry and leave day into the neighbouring run and cascades through overtime, gross,
 * every statutory band and PCB — it is the highest-blast-radius single line in the engine.
 */

import { addDays, dayOfMonth, monthBounds, monthDay, shiftPeriod, type IsoDate } from './dates.js';

export type PayrollWindow = {
	/** `YYYY-MM`. */
	readonly period: string;
	/** The calendar month the wages belong to; the proration denominator lives here. */
	readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
	/** The work days the wages cover; time entries and leave days are selected by this. */
	readonly attendance: { readonly start: IsoDate; readonly end: IsoDate };
	readonly payDate: IsoDate;
};

function periodParts(period: string): { year: number; monthIndex: number } {
	if (!/^\d{4}-\d{2}$/.test(period))
		throw new Error(`Payroll period must be YYYY-MM, received "${period}".`);
	return { year: Number(period.slice(0, 4)), monthIndex: Number(period.slice(5, 7)) - 1 };
}

/** The attendance window of a monthly period, given the company's cutoff day. */
export function attendanceWindow(
	period: string,
	cutoffDay: number
): { start: IsoDate; end: IsoDate } {
	const { year, monthIndex } = periodParts(period);
	return {
		start: monthDay(year, monthIndex - 1, cutoffDay),
		end: addDays(monthDay(year, monthIndex, cutoffDay), -1)
	};
}

export function resolveWindow(
	period: string,
	company: { readonly pay_cutoff_day: number; readonly pay_day: number }
): PayrollWindow {
	const { year, monthIndex } = periodParts(period);
	const cutoffDay = Number(company.pay_cutoff_day);
	const payDay = Number(company.pay_day);
	if (!Number.isInteger(cutoffDay) || cutoffDay < 1 || cutoffDay > 31)
		throw new Error(`Company pay cutoff day ${company.pay_cutoff_day} is not a day of the month.`);
	if (!Number.isInteger(payDay) || payDay < 1 || payDay > 31)
		throw new Error(`Company pay day ${company.pay_day} is not a day of the month.`);
	return {
		period,
		salary: monthBounds(period),
		attendance: attendanceWindow(period, cutoffDay),
		payDate: monthDay(year, monthIndex, payDay)
	};
}

/**
 * Which run a component entry belongs to when its `pay_period` was left blank.
 *
 * This is the money cutoff, not the attendance cutoff: an entry dated on or before the cutoff pays
 * this month, one dated after it pays next month. `component_entries.pay_period` overrides it and
 * is authoritative wherever it is set, because a late-submitted December claim is still December's
 * money (decision L16).
 */
export function defaultPayPeriod(eventDate: IsoDate, cutoffDay: number): string {
	const period = eventDate.slice(0, 7);
	return dayOfMonth(eventDate) <= cutoffDay ? period : shiftPeriod(period, 1);
}

/** Pay periods left in the tax year, this one included. Feeds the PCB projection. */
export function payPeriodsRemaining(period: string, taxYearStartMonth: number): number {
	const month = Number(period.slice(5, 7));
	const start = Math.min(12, Math.max(1, Math.trunc(taxYearStartMonth)));
	const elapsed = (month - start + 12) % 12;
	return 12 - elapsed;
}

/** The tax year label a period falls in, for year-to-date accumulation. */
export function taxYearOf(period: string, taxYearStartMonth: number): string {
	const year = Number(period.slice(0, 4));
	const month = Number(period.slice(5, 7));
	const start = Math.min(12, Math.max(1, Math.trunc(taxYearStartMonth)));
	return String(month >= start ? year : year - 1);
}

/** The first period of the tax year `period` falls in. */
export function taxYearFirstPeriod(period: string, taxYearStartMonth: number): string {
	const start = Math.min(12, Math.max(1, Math.trunc(taxYearStartMonth)));
	return `${taxYearOf(period, taxYearStartMonth)}-${String(start).padStart(2, '0')}`;
}
