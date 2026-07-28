/**
 * Which run an **employment** settles in, and which days that run covers for it.
 *
 * `period.ts` answers the company-wide question — the calendar month wages belong to, and the
 * attendance window those wages cover. It is the same answer for everyone. This module answers the
 * per-person question, and there are exactly three cases where the two differ:
 *
 * ```
 *                 Feb                                Mar
 *   ──────┼─────────────┼───────────────┼──────────────┼────►
 *         1            21              1             21
 *              └──── attendance ───────┘
 *                     21 Jan → 20 Feb        pay period 2026-02
 *
 *   joiner 23 Feb   ▓▓▓▓▓▓          ← starts after the window closed:
 *                                     no day of it is measurable in February
 *   leaver 27 Feb          ▓▓▓▓▓▓▓  ← ends after the window closed:
 *                                     no later run will ever look at these days
 * ```
 *
 * 1. **A late joiner.** An employment beginning after the attendance window has closed did not work
 *    one day the run can measure. Paying a stub for it anyway states an attendance the run never
 *    read; the customer's rule is to skip the joining period and pay it as arrears in the next one.
 * 2. **A leaver in the tail.** An employment ending between the window's close and the period end
 *    has days that fall inside the *next* period's window — and there is no next run for that
 *    person. Their absence would go unrecovered and their clocks unread. The final run's window is
 *    extended to the exit date so nothing is left behind.
 * 3. **A leave of absence longer than a window.** Unpaid days settle in the calendar month they
 *    fall in rather than the month whose window carries them, so a leave beginning on the 15th is
 *    felt in that month's pay.
 *
 * **Every unpaid day is consumed exactly once.** A day inside a qualifying absence is only ever
 * taken by the run for its own calendar month; a day outside one is only ever taken by the run
 * whose attendance window contains it. The two sets are disjoint by construction and together they
 * are every day, which is the property that makes this a cutoff rule rather than an adjustment.
 *
 * Nothing here names a country, a nationality or a pay component. Every threshold, every population
 * and the arrears component itself come from `companies.settlement_policy` (decision L45).
 */

import {
	addDays,
	dateKey,
	dayOfMonth,
	monthBounds,
	monthDay,
	shiftPeriod,
	type IsoDate
} from './dates.js';
import { coversDate } from './effective.js';
import { attendanceWindow, type PayrollWindow } from './period.js';

export type SettlementPolicy = {
	readonly lateJoinerComponentId: string | null;
	readonly settlesInFinalPeriod: boolean;
	readonly fullFinalPeriodWages: boolean;
	readonly extendedUnpaidLeave: {
		readonly minimumCalendarDays: number;
		readonly bridgedGapDays: number;
		readonly populationContributionId: string | null;
	} | null;
	readonly absenceProration: readonly {
		readonly payFrequency: string;
		readonly basis:
			| { readonly by: 'CALENDAR_DAYS' }
			| { readonly by: 'WORKING_DAYS' }
			| { readonly by: 'FIXED_DAYS'; readonly days: number };
	}[];
	readonly overtimeWindows: readonly {
		readonly payFrequency: string;
		readonly startDay: number;
		readonly endDay: number;
	}[];
};

/** What a company with no stated policy does — the plain pay calendar, and nothing else. */
export const PLAIN_CALENDAR: SettlementPolicy = {
	lateJoinerComponentId: null,
	settlesInFinalPeriod: false,
	fullFinalPeriodWages: false,
	extendedUnpaidLeave: null,
	absenceProration: [],
	overtimeWindows: []
};

type StoredPolicy = {
	readonly late_joiner_arrears: { readonly defer_to_component_id: string } | null;
	readonly final_period: string;
	readonly final_period_wages: string;
	readonly extended_unpaid_leave: {
		readonly minimum_calendar_days: number;
		readonly bridged_gap_days: number;
		readonly population_contribution_id: string | null;
	} | null;
	readonly absence_proration?:
		| readonly {
				readonly pay_frequency: string;
				readonly basis:
					| { readonly by: 'CALENDAR_DAYS' }
					| { readonly by: 'WORKING_DAYS' }
					| { readonly by: 'FIXED_DAYS'; readonly days: number };
		  }[]
		| null;
	readonly overtime_windows:
		| readonly {
				readonly pay_frequency: string;
				readonly start_day: number;
				readonly end_day: number;
		  }[]
		| null;
} | null;

/** Read the stored variant into the shape the engine reasons with. */
export function readSettlementPolicy(company: {
	readonly settlement_policy?: StoredPolicy;
}): SettlementPolicy {
	const stored = company.settlement_policy;
	if (stored == null) return PLAIN_CALENDAR;
	const extended = stored.extended_unpaid_leave;
	return {
		lateJoinerComponentId: stored.late_joiner_arrears?.defer_to_component_id ?? null,
		settlesInFinalPeriod: stored.final_period === 'SETTLE_IN_FINAL_PERIOD',
		fullFinalPeriodWages: stored.final_period_wages === 'FULL_PERIOD',
		extendedUnpaidLeave:
			extended == null
				? null
				: {
						minimumCalendarDays: Number(extended.minimum_calendar_days),
						bridgedGapDays: Number(extended.bridged_gap_days),
						populationContributionId: extended.population_contribution_id
					},
		absenceProration: (stored.absence_proration ?? []).map((rule) => ({
			payFrequency: rule.pay_frequency,
			basis: rule.basis
		})),
		overtimeWindows: (stored.overtime_windows ?? []).map((window) => ({
			payFrequency: window.pay_frequency,
			startDay: Number(window.start_day),
			endDay: Number(window.end_day)
		}))
	};
}

/**
 * The time-entry window for one employment's OT/NS calculation.
 *
 * Salary and unpaid leave do not use this override. That separation is deliberate: a semi-monthly
 * employee can have OT/NS on 1st–15th while their NPL still follows the company-wide 21st–20th
 * window.
 */
export function overtimeAttendanceWindow(options: {
	readonly policy: SettlementPolicy;
	readonly payFrequency: string;
	readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
	readonly fallback: { readonly start: IsoDate; readonly end: IsoDate };
}): { readonly start: IsoDate; readonly end: IsoDate } {
	const override = options.policy.overtimeWindows.find(
		(candidate) => candidate.payFrequency === options.payFrequency
	);
	if (override == null) return options.fallback;
	if (override.startDay > override.endDay)
		throw new Error(
			`Overtime window ${override.payFrequency} starts on day ${override.startDay} after ` +
				`its end day ${override.endDay}.`
		);
	const year = Number(options.salary.start.slice(0, 4));
	const monthIndex = Number(options.salary.start.slice(5, 7)) - 1;
	return {
		start: monthDay(year, monthIndex, override.startDay),
		end: monthDay(year, monthIndex, override.endDay)
	};
}

export type EmploymentDates = {
	readonly hire: IsoDate;
	readonly exit: IsoDate | null;
};

export type EmploymentSettlement = {
	/** Whether this run produces a payslip for the employment at all. */
	readonly runs: boolean;
	/** The days of the pay period the employment covers, or `null` when it covers none. */
	readonly employedDays: { readonly start: IsoDate; readonly end: IsoDate } | null;
	/** The days recurring wages cover; may extend past a leaver's exit by company policy. */
	readonly wageDays: { readonly start: IsoDate; readonly end: IsoDate } | null;
	/** The attendance days this run reads for this employment — the tail of a leaver included. */
	readonly attendance: { readonly start: IsoDate; readonly end: IsoDate };
	/**
	 * Set when the employment's own period is being skipped. `runs` is false whenever this is set,
	 * and nothing at all is measured — the period is not half-paid, it is not paid.
	 */
	readonly deferral: {
		readonly coversPeriod: string;
		readonly paidInPeriod: string;
		readonly days: { readonly start: IsoDate; readonly end: IsoDate };
	} | null;
	/**
	 * Set when this run is paying a period an earlier one skipped.
	 *
	 * **The arrears is derived here, not carried from there.** What someone was owed for the month
	 * they joined is a fact about their contract and their start date, not about whether a run
	 * happened — a customer who onboards in February and never builds January must still pay the
	 * January days, and a system that answered "nothing was carried forward, so nothing is owed"
	 * would underpay in silence. Every input needed is on this run's own bundle.
	 */
	readonly arrearsFor: {
		readonly period: string;
		readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
		readonly attendance: { readonly start: IsoDate; readonly end: IsoDate };
		readonly days: { readonly start: IsoDate; readonly end: IsoDate };
	} | null;
};

/** The days of `period` an employment covers, or `null` when it covers none. */
function employedWithin(
	dates: EmploymentDates,
	period: { start: IsoDate; end: IsoDate }
): { start: IsoDate; end: IsoDate } | null {
	const start = dates.hire > period.start ? dates.hire : period.start;
	const end = dates.exit != null && dates.exit < period.end ? dates.exit : period.end;
	return start > end ? null : { start, end };
}

/**
 * Whether an employment starting on `hire` is deferred out of the period whose attendance window
 * ends on `attendanceEnd`.
 *
 * The test is the window, not the cutoff day: "joined after the 20th" is the customer's phrasing of
 * "joined after the last day this run can see", and stating it that way is what keeps the rule
 * correct when the cutoff moves and true in a month with 28 days.
 */
function startsAfterWindow(
	hire: IsoDate,
	period: { start: IsoDate; end: IsoDate },
	attendanceEnd: IsoDate
): boolean {
	return hire >= period.start && hire <= period.end && hire > attendanceEnd;
}

/** The attendance window of the period before `period`, given the same cutoff. */
function previousAttendanceEnd(window: PayrollWindow): IsoDate {
	return addDays(window.attendance.start, -1);
}

/**
 * Resolve one employment against one run.
 *
 * `window` is the company's; everything returned is this employment's.
 */
export function resolveEmploymentSettlement(options: {
	readonly dates: EmploymentDates;
	readonly window: PayrollWindow;
	readonly policy: SettlementPolicy;
}): EmploymentSettlement {
	const { dates, window, policy } = options;
	const employedDays = employedWithin(dates, window.salary);

	// Someone who joins and leaves inside the same period has no next run to be deferred into, and
	// the final-pay rule is explicit that nothing may be pushed past it. Rule 2 wins over rule 1
	// wherever they meet, which is the only ordering that never strands a wage.
	const endsHere = dates.exit != null && dates.exit <= window.salary.end;
	const wageDays =
		employedDays != null &&
		endsHere &&
		policy.fullFinalPeriodWages &&
		dates.exit != null &&
		dates.exit >= window.salary.start
			? { start: employedDays.start, end: window.salary.end }
			: employedDays;

	// ── 1. the joining period, skipped ─────────────────────────────────────────────────────────
	if (
		policy.lateJoinerComponentId != null &&
		!endsHere &&
		startsAfterWindow(dates.hire, window.salary, window.attendance.end)
	) {
		const days = employedDays;
		return {
			runs: false,
			employedDays,
			wageDays,
			attendance: window.attendance,
			deferral:
				days == null
					? null
					: {
							coversPeriod: window.period,
							paidInPeriod: shiftPeriod(window.period, 1),
							days
						},
			arrearsFor: null
		};
	}

	// ── the period after a skipped one, paying what it owes ────────────────────────────────────
	let arrearsFor: EmploymentSettlement['arrearsFor'] = null;
	if (policy.lateJoinerComponentId != null) {
		const previousPeriod = shiftPeriod(window.period, -1);
		const previousBounds = monthBounds(previousPeriod);
		const previousEnd = previousAttendanceEnd(window);
		if (startsAfterWindow(dates.hire, previousBounds, previousEnd)) {
			const days = employedWithin(dates, previousBounds);
			if (days != null)
				arrearsFor = {
					period: previousPeriod,
					salary: previousBounds,
					// The deferred period's own attendance window — which, by the very test that
					// deferred it, this employment has no day inside. That is not a technicality: the
					// days they *did* work at the end of that month fall in **this** run's window and
					// are already being paid here, so reading them again for the arrears would pay the
					// same overtime twice. It is also why the workbook's `back_pay_ot` is empty for
					// every late joiner in the source.
					attendance: attendanceWindow(previousPeriod, dayOfMonth(window.attendance.start)),
					days
				};
		}
	}

	// ── 2. the final period, extended to the exit date ─────────────────────────────────────────
	const endsInTail =
		policy.settlesInFinalPeriod &&
		dates.exit != null &&
		dates.exit > window.attendance.end &&
		dates.exit <= window.salary.end;
	const attendance = endsInTail
		? { start: window.attendance.start, end: dates.exit! }
		: window.attendance;

	return {
		runs: employedDays != null,
		employedDays,
		wageDays,
		attendance,
		deferral: null,
		arrearsFor
	};
}

/**
 * Whether an employment is in the population an extended-leave rule applies to.
 *
 * The policy names a statutory scheme; enrolment in it is the selector. Payroll does not know what
 * the scheme means, only that HR maintains an effective-dated answer per employment — which is the
 * whole point: the engine cannot hold a nationality, and a company must not have to encode one.
 */
export function inExtendedLeavePopulation(options: {
	readonly policy: SettlementPolicy;
	readonly statutoryFacts: readonly {
		readonly statutory_contribution_id: string;
		readonly status: { readonly kind: string } | null;
		readonly effective_range: unknown;
	}[];
	readonly asOf: IsoDate;
}): boolean {
	const rule = options.policy.extendedUnpaidLeave;
	if (rule == null) return false;
	if (rule.populationContributionId == null) return true;
	return options.statutoryFacts.some(
		(fact) =>
			fact.statutory_contribution_id === rule.populationContributionId &&
			fact.status?.kind === 'REGISTERED' &&
			coversDate(fact.effective_range, options.asOf)
	);
}

/**
 * The days that belong to a leave of absence rather than to a missed day here and there.
 *
 * Days are walked in order and grouped into spells; a break of at most `bridgedGapDays` does not
 * end one, because a rest day, a public holiday or a weekend inside a leave of absence is not a
 * return to work. A spell whose first-to-last span reaches `minimumCalendarDays` is extended, and
 * every day in it settles in its own month.
 *
 * Measuring the **span** rather than the count is deliberate: someone away for all of March takes
 * 31 days off a calendar and about 22 off a roster, and only the first of those is a fact about the
 * leave rather than about the shift pattern.
 */
export function extendedAbsenceDays(options: {
	readonly dates: readonly IsoDate[];
	readonly minimumCalendarDays: number;
	readonly bridgedGapDays: number;
}): ReadonlySet<IsoDate> {
	const ordered = [...new Set(options.dates)].toSorted();
	const extended = new Set<IsoDate>();
	let spell: IsoDate[] = [];
	const close = (): void => {
		const first = spell[0];
		const last = spell[spell.length - 1];
		if (first != null && last != null) {
			const span =
				Math.round(
					(Date.parse(`${last}T00:00:00.000Z`) - Date.parse(`${first}T00:00:00.000Z`)) / 86_400_000
				) + 1;
			if (span >= options.minimumCalendarDays) for (const date of spell) extended.add(date);
		}
		spell = [];
	};
	for (const date of ordered) {
		const previous = spell[spell.length - 1];
		if (
			previous != null &&
			Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${previous}T00:00:00.000Z`) >
				(options.bridgedGapDays + 1) * 86_400_000
		)
			close();
		spell.push(date);
	}
	close();
	return extended;
}

/** Narrow a stored hire/exit pair, failing loudly on a row that has no start. */
export function employmentDates(employment: {
	readonly employee_number?: string | null;
	readonly norbital_id?: string;
	readonly hire_date: string | Date | null;
	readonly exit_date: string | Date | null;
}): EmploymentDates {
	const hire = dateKey(employment.hire_date);
	if (hire == null)
		throw new Error(
			`Employment ${employment.employee_number ?? employment.norbital_id ?? '(unknown)'} has no hire date.`
		);
	return { hire, exit: dateKey(employment.exit_date) };
}
