/**
 * Proration.
 *
 * An amount is prorated when the employment — or a standing entry's own effective range — covers
 * only part of the pay period. The divisor comes from `jurisdictions.proration` and nothing else:
 * there is no `prorates` flag on a pay component, no proration arithmetic inside a formula, and no
 * branch on a pay component's name.
 *
 * What prorates is a component's **cadence**, not its kind: basic salary and a recurring allowance
 * do, a one-off claim, a bonus and a loan instalment do not. Keying on cadence is what removes the
 * type-name branch the plan itself worries about (decision E7 / E22).
 *
 * The denominator is the calendar length of the pay period's month. A salary change mid-month
 * produces two terms rows, each prorated against that same full-month divisor and summed —
 * 4,000 × 15/31 + 4,600 × 16/31 — so the two halves of the month never add up to more or less than
 * a month.
 */

import type { Jurisdiction } from './configuration.js';
import { inclusiveDays, intersectDays, monthDays, type IsoDate } from './dates.js';

export type DayWindow = { readonly start: IsoDate; readonly end: IsoDate };

/**
 * The fraction of a pay period a span of employment covers.
 *
 * `workingDaysIn` is only consulted for a `WORKING_DAYS` jurisdiction, and is supplied by the
 * caller because only the schedule knows which days those are (public holidays excluded — decision
 * E20).
 */
export function prorationFraction(options: {
	readonly jurisdiction: Jurisdiction;
	readonly period: DayWindow;
	readonly covered: DayWindow | null;
	readonly workingDaysIn: (window: DayWindow) => number;
}): number {
	if (options.covered == null) return 0;
	const basis = options.jurisdiction.proration;
	if (basis == null)
		throw new Error(`Jurisdiction ${options.jurisdiction.code} states no proration basis.`);
	const covered = intersectDays(options.covered, options.period);
	if (covered == null) return 0;
	switch (basis.by) {
		case 'CALENDAR_DAYS': {
			const divisor = monthDays(options.period.start);
			return inclusiveDays(covered.start, covered.end) / divisor;
		}
		case 'WORKING_DAYS': {
			const divisor = options.workingDaysIn(options.period);
			if (divisor <= 0) return 0;
			return options.workingDaysIn(covered) / divisor;
		}
		case 'FIXED_DAYS': {
			const divisor = Number(basis.days);
			if (!(divisor > 0)) throw new Error('A FIXED_DAYS proration basis needs a positive divisor.');
			return inclusiveDays(covered.start, covered.end) / divisor;
		}
	}
	throw new Error(`Unsupported proration basis: ${Reflect.get(basis, 'by')}`);
}

/** Whether a fraction is a whole period, within the tolerance a day count can produce. */
export function isWholePeriod(fraction: number): boolean {
	return fraction >= 1 - 1e-9;
}
