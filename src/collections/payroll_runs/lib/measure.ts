/**
 * Step 4 — MEASURE.
 *
 * Every plane of input — a contract, an entry, a clock, a formula — arrives here and leaves as
 * money. Components are measured in `component_types.sequence` order, so the hourly rate exists
 * before overtime needs it and every earning exists before the grid sums them.
 *
 * Two rules hold throughout:
 *
 * - **an amount is a magnitude.** Direction is the component type's `nature` and the treatment's
 *   decision; no line here carries a minus sign, including unpaid absence, whose type is `ABSENCE`
 *   and whose grid row is `REDUCE`.
 * - **an ineligible component produces nothing at all.** Not a zero line — nothing. A manager has
 *   no overtime row, rather than an overtime row of zero.
 *
 * `INFORMATION` components are measured, because later formulas read them, but they are not written
 * to the payslip: they are not money, the grid does not apply to them, and a report that sums a
 * column must never find an hourly rate inside it (plan 03 §2).
 */

import type { ComponentType, Configuration, PayComponent } from './configuration.js';
import {
	addDays,
	dateKey,
	daysBetween,
	inclusiveDays,
	intersectDays,
	monthBounds,
	monthDays,
	monthKey,
	requiredDateKey,
	type IsoDate
} from './dates.js';
import { clipRange, coversDate } from './effective.js';
import { isEligible } from './eligibility.js';
import {
	entryPayPeriod,
	entrySign,
	prorates,
	standingRange,
	type ComponentEntry
} from './entries.js';
import { evaluateFormula, type FormulaContext } from './formula.js';
import type { EmploymentBundle } from './gather.js';
import {
	leaveBalance,
	resolveEntitlement,
	unpaidLeaveDates,
	unpaidLeaveInWindow,
	type UnpaidLeave
} from './leave.js';
import {
	extendedAbsenceDays,
	overtimeAttendanceWindow,
	type SettlementPolicy
} from './settlement.js';
import {
	classifyOvertimeByCalendarMonth,
	deriveDailyOvertime,
	philippineNightWorkHours,
	priceDay,
	type DailyOvertime,
	type ExcessHours,
	type PricedSegment
} from './overtime.js';
import {
	absenceDayRate,
	ordinaryDayWage,
	overtimeHourlyRate,
	readOvertimeCalculationMethod,
	type OvertimeCalculationMethod,
	type RateTerms
} from './ordinary-rate.js';
import { prorationFraction } from './proration.js';
import { cents } from './rounding.js';
import { normalDailyHours, resolveSchedule, type ScheduledDay } from './schedule.js';
import { settle } from './settle.js';

/** What a payslip line consumed, in the shape `payslip_line_sources.source` stores. */
export type LineSource =
	| { readonly kind: 'COMPONENT_ENTRY'; readonly entry_id: string }
	| { readonly kind: 'TIME_ENTRY'; readonly time_entry_id: string }
	| { readonly kind: 'LEAVE_REQUEST'; readonly leave_request_id: string };

export type MeasuredLine = {
	readonly payComponent: PayComponent;
	readonly componentType: ComponentType;
	/** Always a magnitude. */
	readonly amount: number;
	/** Hours, days or units where the line has a natural quantity; `null` otherwise. */
	readonly quantity: number | null;
	readonly rate: number | null;
	readonly sequence: number;
	readonly sources: readonly LineSource[];
};

export type MeasuredEmployment = {
	readonly bundle: EmploymentBundle;
	readonly lines: readonly MeasuredLine[];
	/** What a deferred earlier period is owed, when this run is the one paying it. */
	readonly arrears: {
		readonly period: string;
		readonly payComponentId: string;
		readonly amount: number;
	} | null;
	/** Amounts of every component measured, including `INFORMATION` — what formulas read. */
	readonly componentAmounts: ReadonlyMap<string, number>;
	readonly ordinaryHourlyRate: number;
	readonly ordinaryDayWage: number;
	readonly overtimeDays: readonly DailyOvertime[];
	/** Regulated ordinary/off-day OT by calendar month; rest days and PH are excluded. */
	readonly calendarMonthOvertimeHours: ReadonlyMap<string, number>;
	readonly currency: string;
	readonly schedule: ReadonlyMap<IsoDate, ScheduledDay>;
};

/**
 * The total-work-hours boundary that routes the corresponding overtime into incentive.
 *
 * Every overflow component represents one statutory overtime band, but the work boundary is
 * company-wide. Refusing conflicting limits prevents the same hour from being classified
 * differently merely because its day type changed.
 */
function overtimeExcessWorkLimit(components: readonly PayComponent[]): number | null {
	const limits = new Set<number>();
	for (const component of components) {
		if (component.definition?.source === 'OVERTIME_EXCESS') {
			limits.add(component.definition.after_total_work_hours);
		}
	}
	if (limits.size > 1) {
		throw new Error(
			`Overtime excess components disagree on the total-work-hours boundary: ${[...limits].join(', ')} hours.`
		);
	}
	return limits.values().next().value ?? null;
}

function monthlyOvertimeLimit(configuration: Configuration): number | null {
	const limits = configuration.overtimeLimits.filter((limit) => limit.period === 'MONTH');
	if (limits.length > 1)
		throw new Error('More than one monthly overtime limit is effective for this jurisdiction.');
	return limits[0] == null ? null : Number(limits[0].max_hours);
}

/** Statutory OT/rest-day/holiday pay coverage under the Malaysian First Schedule. */
export function isStatutoryOvertimePayCovered(options: {
	readonly jurisdictionCode: string;
	readonly monthlyBaseSalary: number;
	readonly statutoryWorkCategory: string | null;
}): boolean {
	if (options.jurisdictionCode !== 'MY') return false;
	return (
		options.monthlyBaseSalary <= 4000 ||
		(options.statutoryWorkCategory != null && options.statutoryWorkCategory !== 'NON_MANUAL')
	);
}

function termsAt(bundle: EmploymentBundle, date: IsoDate): EmploymentBundle['terms'][number] {
	const row = bundle.terms.find((candidate) => coversDate(candidate.effective_range, date));
	if (!row)
		throw new Error(
			`${bundle.employment.employee_number} has no employment terms effective on ${date}. ` +
				'Every day of the period a person is paid for must be covered by terms.'
		);
	return row;
}

const PAY_FREQUENCIES = ['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY'] as const;

function payFrequency(value: string | null): RateTerms['pay_frequency'] {
	const found = PAY_FREQUENCIES.find((candidate) => candidate === value);
	if (!found)
		throw new Error(
			`Employment terms state a pay frequency of "${value ?? 'nothing'}". Every wage must say how ` +
				'often it is paid before it can be spread over a period.'
		);
	return found;
}

function asRateTerms(terms: EmploymentBundle['terms'][number]): RateTerms {
	const salary = terms.base_salary;
	if (salary == null)
		throw new Error('Employment terms carry no base salary, so no rate can be derived from them.');
	return {
		base_salary: { value: Number(salary.value), currency: salary.currency },
		pay_frequency: payFrequency(terms.pay_frequency),
		ordinary_hours_per_week: Number(terms.ordinary_hours_per_week),
		working_days_per_week: Number(terms.working_days_per_week)
	};
}

/** Measure one employment's whole payslip. */
export function measureEmployment(options: {
	readonly bundle: EmploymentBundle;
	readonly configuration: Configuration;
	readonly period: string;
	readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
	readonly periodsRemaining: number;
	readonly headcount: number;
	readonly policy: SettlementPolicy;
}): MeasuredEmployment {
	const { bundle, configuration } = options;
	// The attendance window is the employment's, not the run's: a leaver settling in their final
	// period is measured to the exit date, because no later run will ever read those days.
	const attendance = bundle.attendance;
	const employed = bundle.employedDays;
	if (employed == null)
		throw new Error(
			`${bundle.employment.employee_number} is not employed during ${options.period}.`
		);
	const wageDays = bundle.wageDays ?? employed;

	const closingTerms = termsAt(bundle, employed.end);
	const rateTerms = asRateTerms(closingTerms);
	const currency = rateTerms.base_salary.currency;
	const overtimeCalculationMethod = readOvertimeCalculationMethod(
		configuration.company.overtime_calculation_method
	);
	const hourlyRate = overtimeHourlyRate(
		rateTerms,
		configuration.jurisdiction,
		overtimeCalculationMethod
	);
	const dayWage = ordinaryDayWage(rateTerms, configuration.jurisdiction);

	// ── schedule across the full calendar months touched by the settlement cutoff ───────────────
	const complianceWindow = {
		start: monthBounds(monthKey(attendance.start)).start,
		end: monthBounds(monthKey(attendance.end)).end
	};
	const attendanceDays = daysBetween(complianceWindow.start, complianceWindow.end);
	const scheduleTermsAt = (date: IsoDate) => {
		// Attendance can run before the pay period starts, so a day outside the terms history falls
		// back to the closest terms row rather than blocking a run on a boundary day.
		const row =
			bundle.terms.find((candidate) => coversDate(candidate.effective_range, date)) ??
			bundle.terms[0] ??
			closingTerms;
		return {
			ordinary_hours_per_week: Number(row.ordinary_hours_per_week),
			working_days_per_week: Number(row.working_days_per_week),
			rest_day: row.rest_day
		};
	};
	const schedule = resolveSchedule({
		window: complianceWindow,
		dates: attendanceDays,
		terms: scheduleTermsAt,
		rosterEntries: bundle.rosterEntries,
		configuration
	});

	// Proration asks how many days the person was meant to work, not how many they attended. Source
	// rosters mark an approved leave day OFF because there is no shift to clock; using that mark as
	// the divisor makes a whole-month absence have zero working days and therefore no price. Remove
	// those leave-day marks so the contractual week supplies the missed schedule, while retaining
	// genuine roster rotations on every other day. Resolve each requested window independently:
	// salary proration needs the whole calendar month even though overtime only reads the cutoff
	// attendance window, and deferred joiners can ask for the previous month.
	const takenLeaveDates = new Set<IsoDate>();
	for (const row of bundle.ledger) {
		if (row.kind !== 'TAKEN' || row.norbital_approval_id != null) continue;
		const date = dateKey(row.entry_date);
		if (date != null) takenLeaveDates.add(date);
	}
	const prorationRosterEntries = bundle.rosterEntries.filter(
		(row) => !takenLeaveDates.has(requiredDateKey(row.work_date, 'roster_entries.work_date'))
	);
	const workingDaysCache = new Map<string, number>();
	const workingDaysIn = (window: { start: IsoDate; end: IsoDate }): number => {
		const key = `${window.start}:${window.end}`;
		const cached = workingDaysCache.get(key);
		if (cached != null) return cached;
		const dates = daysBetween(window.start, window.end);
		const prorationSchedule = resolveSchedule({
			window,
			dates,
			terms: scheduleTermsAt,
			rosterEntries: prorationRosterEntries,
			configuration
		});
		const days = dates.filter((date) => prorationSchedule.get(date)?.dayType === 'ORDINARY').length;
		workingDaysCache.set(key, days);
		return days;
	};

	/**
	 * A day of pay *withheld* is not a day of pay *earned*, and the two use different divisors.
	 *
	 * `ordinary_day_wage` divides by `ordinary_rate_divisor` — 26 in Malaysia, EA s.60I — because that
	 * is the basis the Act sets for what an extra day of work is worth. Withholding pay for a day not
	 * worked is proration, and proration is `jurisdictions.proration`: the month's calendar days here,
	 * working days elsewhere. Valuing an absence at the overtime divisor over-deducts by the ratio
	 * between them — 31/26, about 19%, on every employee with unpaid leave.
	 *
	 * Rounded to the cent before it is multiplied by the day count, not after, which is what the
	 * source system does and what reproduces its figures exactly.
	 */
	const absenceDayWage = absenceDayRate({
		terms: rateTerms,
		jurisdiction: {
			...configuration.jurisdiction,
			proration:
				options.policy.absenceProration.find(
					(rule) => rule.payFrequency === rateTerms.pay_frequency
				)?.basis ?? configuration.jurisdiction.proration
		},
		period: options.salary,
		workingDaysIn
	});

	// ── overtime, derived from clocks and split only beyond the total-work-hours boundary ───────
	const dailyWorkLimit = overtimeExcessWorkLimit(configuration.payComponents);
	const overtimeAttendance = overtimeAttendanceWindow({
		policy: options.policy,
		payFrequency: rateTerms.pay_frequency,
		salary: options.salary,
		fallback: attendance
	});
	const overtimeDays: DailyOvertime[] = [];
	const segments: PricedSegment[] = [];
	const excess: ExcessHours[] = [];
	for (const entry of bundle.timeEntries) {
		const workDate = requiredDateKey(entry.work_date, 'time_entries.work_date');
		if (workDate < complianceWindow.start || workDate > complianceWindow.end) continue;
		const day = schedule.get(workDate);
		if (!day) continue;
		const derived = deriveDailyOvertime(entry, day);
		if (derived) overtimeDays.push(derived);
	}
	const paymentEligible =
		closingTerms.overtime_eligible ||
		isStatutoryOvertimePayCovered({
			jurisdictionCode: configuration.jurisdiction.code,
			monthlyBaseSalary: rateTerms.base_salary.value,
			statutoryWorkCategory: closingTerms.statutory_work_category
		});
	const classifiedOvertime = classifyOvertimeByCalendarMonth({
		days: overtimeDays,
		dailyWorkLimit,
		monthlyOrdinaryOvertimeLimit: monthlyOvertimeLimit(configuration)
	});
	if (paymentEligible) {
		for (const classified of classifiedOvertime) {
			if (
				classified.day.date < overtimeAttendance.start ||
				classified.day.date > overtimeAttendance.end
			)
				continue;
			const priced = priceDay({
				day: classified.day,
				rules: configuration.overtimeRules,
				retainedHours: classified.retainedHours
			});
			segments.push(...priced.segments);
			excess.push(...priced.excess);
		}
	}
	const calendarMonthOvertimeHours = new Map<string, number>();
	for (const day of overtimeDays) {
		if (day.dayType !== 'ORDINARY' && day.dayType !== 'OFF_DAY') continue;
		const calendarMonth = monthKey(day.date);
		calendarMonthOvertimeHours.set(
			calendarMonth,
			(calendarMonthOvertimeHours.get(calendarMonth) ?? 0) + day.hours
		);
	}

	// ── unpaid leave, in whichever window each day settles by ──────────────────────────────────
	//
	// A day inside a leave of absence settles in its own calendar month; every other unpaid day
	// settles in the run whose attendance window contains it. `extendedDates` is the whole set of
	// days the first rule applies to, computed from the employment's entire unpaid history so that
	// a spell straddling a month boundary is recognised as one absence from either side of it.
	const extendedRule = options.policy.extendedUnpaidLeave;
	const extendedDates =
		extendedRule == null || !bundle.extendedLeaveSettlesInOwnMonth
			? new Set<IsoDate>()
			: extendedAbsenceDays({
					dates: unpaidLeaveDates(bundle.ledger, configuration.leaveTypes),
					minimumCalendarDays: extendedRule.minimumCalendarDays,
					bridgedGapDays: extendedRule.bridgedGapDays
				});
	const settlesHere = (date: IsoDate): boolean =>
		extendedDates.has(date)
			? date >= options.salary.start && date <= options.salary.end
			: date >= attendance.start && date <= attendance.end;
	const unpaid = unpaidLeaveInWindow({
		ledger: bundle.ledger,
		window: attendance,
		month: options.salary,
		extendedDates,
		configuration
	});
	const unpaidByComponent = new Map<string, UnpaidLeave>(
		unpaid.map((row) => [row.componentId, row])
	);

	// ── entries settling in this run ───────────────────────────────────────────────────────────
	const cutoffDay = Number(configuration.company.pay_cutoff_day);
	const entryById = new Map(bundle.entries.map((entry) => [entry.norbital_id, entry]));
	// The arrears entry a previous build of *this* period wrote is the engine's own output, and this
	// run is about to derive that figure again. Reading it back as an input would pay a late joiner's
	// first month twice, once more on every rebuild. Everything else on that component — an arrears
	// row HR keyed, a back-payment for any other period — is ordinary input and is read normally.
	const ownedArrears = (entry: ComponentEntry): boolean =>
		bundle.arrearsFor != null &&
		entry.pay_component_id === options.policy.lateJoinerComponentId &&
		entry.origin?.kind === 'ARREARS' &&
		entry.origin.covers_periods.length === 1 &&
		entry.origin.covers_periods[0] === bundle.arrearsFor.period;
	const periodEntries = bundle.entries.filter(
		(entry) => entryPayPeriod(entry, cutoffDay) === options.period && !ownedArrears(entry)
	);
	const entriesByComponent = new Map<string, ComponentEntry[]>();
	for (const entry of periodEntries) {
		const bucket = entriesByComponent.get(entry.pay_component_id);
		if (bucket) bucket.push(entry);
		else entriesByComponent.set(entry.pay_component_id, [entry]);
	}

	// ── the formula context, emitted complete: CEL throws on a missing key ─────────────────────
	const componentAmounts = new Map<string, number>();
	const componentsByCode: Record<string, number> = {};
	const entryTotals: Record<string, number> = {};
	for (const component of configuration.payComponents) {
		componentsByCode[component.code] = 0;
		entryTotals[component.code] = (entriesByComponent.get(component.norbital_id) ?? []).reduce(
			(total, entry) => total + entrySign(entry, entryById) * Number(entry.amount),
			0
		);
	}
	const facts: Record<string, string | number | boolean> = {};
	for (const contribution of configuration.contributions) {
		const fact = bundle.statutoryFacts.find(
			(row) =>
				row.statutory_contribution_id === contribution.row.norbital_id &&
				coversDate(row.effective_range, options.salary.end)
		);
		const status = fact?.status;
		// An absent row means registered with nothing captured, so the default is registration.
		facts[`${contribution.row.code}.registered`] = status == null || status.kind === 'REGISTERED';
		facts[`${contribution.row.code}.reference_number`] =
			status != null && status.kind === 'REGISTERED' ? status.reference_number : '';
		facts[`${contribution.row.code}.rate_override`] =
			status != null && status.kind === 'REGISTERED' && status.rate_override != null
				? status.rate_override
				: -1;
		facts[`${contribution.row.code}.reason`] =
			status != null && status.kind === 'NOT_REGISTERED' ? status.reason : '';
	}
	const leaveDays: Record<string, number> = {};
	const leaveBalances: Record<string, number> = {};
	const hireDate = dateKey(bundle.employment.hire_date) ?? options.salary.start;
	const exitDate = dateKey(bundle.employment.exit_date);
	for (const type of configuration.leaveTypes) {
		leaveDays[type.code] = bundle.ledger
			.filter(
				(row) =>
					row.leave_type_id === type.norbital_id &&
					row.kind === 'TAKEN' &&
					row.norbital_approval_id == null
			)
			// The same predicate the deduction itself uses. An unpaid-absence component is a FORMULA
			// over `leaveDays(...)`, so if this counted a different set of days than
			// `unpaidLeaveInWindow` selected, the money and the day count on the same payslip line
			// would disagree — and the quantity would be the one nobody checks.
			.reduce((total, row) => {
				const date = String(row.entry_date).slice(0, 10);
				return settlesHere(date) ? total + Math.abs(Number(row.days)) : total;
			}, 0);
		// The settled balance, derived in full — carried in, accrued, expired, plus the ledger.
		// Payroll never acts on it, but a formula may read it (an encashment on exit does), and it
		// is emitted for every type so CEL never meets a missing key.
		leaveBalances[type.code] = leaveBalance(
			{
				leaveType: type,
				entitlementAtMonths: (serviceMonths) =>
					resolveEntitlement({
						leaveCode: type.code,
						serviceMonths,
						companyId: configuration.company.norbital_id,
						jurisdictionId: configuration.jurisdiction.norbital_id,
						bands: configuration.accrualBands
					}),
				hireDate,
				exitDate,
				leaveYearStartMonth: Number(configuration.company.leave_year_start_month),
				ledger: bundle.ledger,
				basis: 'SETTLED'
			},
			options.salary.end
		);
	}
	const periodCalendarDays = monthDays(options.salary.start);
	const nightShiftHours =
		configuration.jurisdiction.code === 'PH'
			? bundle.timeEntries
					.filter((entry) => {
						const date = requiredDateKey(entry.work_date, 'time_entries.work_date');
						return date >= overtimeAttendance.start && date <= overtimeAttendance.end;
					})
					.reduce((total, entry) => total + philippineNightWorkHours(entry), 0)
			: 0;
	const context = (): FormulaContext => ({
		components: componentsByCode,
		entries: entryTotals,
		facts,
		leaveDays,
		leaveBalances,
		terms: {
			base_salary: rateTerms.base_salary.value,
			currency,
			pay_frequency: rateTerms.pay_frequency,
			ordinary_hours_per_week: rateTerms.ordinary_hours_per_week,
			working_days_per_week: rateTerms.working_days_per_week,
			// Emitted as empty strings rather than omitted: CEL has no `?.` and throws on a missing key.
			work_classification: closingTerms.work_classification ?? '',
			employment_type: closingTerms.employment_type ?? '',
			rest_day: closingTerms.rest_day ?? ''
		},
		derived: {
			service_months: bundle.serviceMonths,
			age: bundle.age ?? -1,
			employed_days: inclusiveDays(employed.start, employed.end),
			headcount: options.headcount,
			ordinary_hourly_rate: hourlyRate,
			normal_daily_hours: normalDailyHours(rateTerms),
			night_shift_hours: nightShiftHours,
			ordinary_day_wage: dayWage,
			absence_day_wage: absenceDayWage
		},
		period: {
			start: options.salary.start,
			end: options.salary.end,
			calendar_days: periodCalendarDays,
			working_days: workingDaysIn(options.salary),
			periods_remaining: options.periodsRemaining,
			pay_fraction: prorationFraction({
				jurisdiction: configuration.jurisdiction,
				period: options.salary,
				covered: wageDays,
				workingDaysIn
			})
		},
		jurisdiction: {
			code: configuration.jurisdiction.code,
			currency: configuration.jurisdiction.currency,
			ordinary_rate_basis: configuration.jurisdiction.ordinary_rate_basis ?? '',
			ordinary_rate_divisor: Number(configuration.jurisdiction.ordinary_rate_divisor)
		}
	});

	const subject = {
		employment_type: closingTerms.employment_type,
		work_classification: closingTerms.work_classification,
		service_months: bundle.serviceMonths,
		gender: bundle.employee.gender,
		department: closingTerms.department,
		payroll_group: closingTerms.payroll_group
	};

	// ── what a deferred earlier period owes, measured the same way it would have been paid ──────
	//
	// The arrears is **this same function**, run against the deferred period's own windows. That is
	// what makes the figure "what that month would have paid" rather than a second, parallel
	// calculation of it — a prorated wage, its standing allowances and the entries that settled
	// there, all under the terms and the law in force then. Nothing carries across from the earlier
	// run, because there may not have been one.
	//
	// The recursion is one level deep by construction: the derived bundle owes nothing itself.
	const calculatedArrears = measureArrears(options);
	// A source payroll instruction can state the same late-joiner back pay that the settlement
	// policy is able to derive. The source entry is authoritative evidence and already produces a
	// fully linked line below; adding the identical derived line would pay it twice and leave that
	// duplicate without record provenance. Only suppress the derived copy when the current period
	// contains an exact same-component, same-amount entry.
	const explicitArrearsEntry =
		calculatedArrears == null
			? undefined
			: (entriesByComponent.get(calculatedArrears.payComponentId) ?? []).find(
					(entry) =>
						cents(entrySign(entry, entryById) * Number(entry.amount)) === calculatedArrears.amount
				);
	const arrears = explicitArrearsEntry == null ? calculatedArrears : null;

	// ── walk the catalogue in type sequence ────────────────────────────────────────────────────
	const lines: MeasuredLine[] = [];
	if (arrears != null) {
		const component = configuration.payComponents.find(
			(row) => row.norbital_id === arrears.payComponentId
		);
		const componentType =
			component == null
				? undefined
				: configuration.componentTypeById.get(component.component_type_id);
		if (component == null || componentType == null)
			throw new Error(
				`${bundle.employment.employee_number} is owed ${arrears.period}, but the component it is ` +
					'paid back on is not in this company’s catalogue.'
			);
		lines.push({
			payComponent: component,
			componentType,
			amount: arrears.amount,
			quantity: null,
			rate: null,
			sequence: lines.length + 1,
			sources: []
		});
		componentAmounts.set(component.code, arrears.amount);
		componentsByCode[component.code] = arrears.amount;
	}
	for (const componentType of configuration.componentTypes) {
		const components = configuration.payComponents.filter(
			(component) => component.component_type_id === componentType.norbital_id
		);
		for (const component of components) {
			if (!isEligible(component.eligibility, subject)) continue;
			const measured = measureComponent({
				component,
				componentType,
				bundle,
				configuration,
				salary: options.salary,
				employed: wageDays,
				contracted: employed,
				entries: entriesByComponent.get(component.norbital_id) ?? [],
				entryById,
				unpaid: unpaidByComponent.get(component.norbital_id) ?? null,
				segments,
				excess,
				hourlyRate,
				dayWage,
				overtimeCalculationMethod,
				workingDaysIn,
				context
			});
			if (measured == null) continue;
			// `+`, not `=`: a back-pay component can carry both this run's derived arrears and an
			// entry HR keyed by hand, and a formula reading that code must see the whole of it.
			const running = (componentAmounts.get(component.code) ?? 0) + measured.amount;
			componentAmounts.set(component.code, running);
			componentsByCode[component.code] = running;
			// Information is measured so formulas can read it, and stops there: it is not money.
			if (componentType.nature === 'INFORMATION') continue;
			lines.push({
				payComponent: component,
				componentType,
				amount: measured.amount,
				quantity: measured.quantity,
				rate: measured.rate,
				sequence: lines.length + 1,
				sources: measured.sources
			});
		}
	}

	return {
		bundle,
		lines,
		arrears,
		componentAmounts,
		ordinaryHourlyRate: hourlyRate,
		ordinaryDayWage: dayWage,
		overtimeDays,
		calendarMonthOvertimeHours,
		currency,
		schedule
	};
}

/**
 * What the deferred period would have paid, measured by measuring it.
 *
 * The bundle is rebuilt against the earlier month — its own employed days, its own attendance
 * window, and only the entries and clocks that fall inside it — and then handed back to
 * `measureEmployment`. The number that comes out is that month's gross: prorated wage, standing
 * allowances, whatever settled there, less anything unpaid. It is the same arithmetic the person
 * would have seen on a payslip, which is the only defensible definition of what they are owed.
 */
function measureArrears(options: {
	readonly bundle: EmploymentBundle;
	readonly configuration: Configuration;
	readonly periodsRemaining: number;
	readonly headcount: number;
	readonly policy: SettlementPolicy;
}): MeasuredEmployment['arrears'] {
	const owed = options.bundle.arrearsFor;
	const payComponentId = options.policy.lateJoinerComponentId;
	if (owed == null || payComponentId == null) return null;
	const within = <T extends { work_date: Date | string }>(rows: readonly T[]): T[] =>
		rows.filter((row) => {
			const date = requiredDateKey(row.work_date, 'work_date');
			return date >= owed.attendance.start && date <= owed.attendance.end;
		});
	const measured = measureEmployment({
		bundle: {
			...options.bundle,
			timeEntries: within(options.bundle.timeEntries),
			rosterEntries: within(options.bundle.rosterEntries),
			employedDays: owed.days,
			wageDays: owed.days,
			attendance: owed.attendance,
			arrearsFor: null,
			deferral: null
		},
		configuration: options.configuration,
		period: owed.period,
		salary: owed.salary,
		periodsRemaining: options.periodsRemaining,
		headcount: options.headcount,
		policy: options.policy
	});
	// The deferred period's **gross**, by SETTLE's own definition of it and not a second one. What is
	// owed for a month is what that month's payslip would have said was earned; charging statutory
	// on it is this run's job, on this run's combined wage, which is what the source system does.
	const amount = settle({ lines: measured.lines, charges: [] }).gross;
	return amount <= 0 ? null : { period: owed.period, payComponentId, amount };
}

type Measurement = {
	readonly amount: number;
	readonly quantity: number | null;
	readonly rate: number | null;
	readonly sources: LineSource[];
};

function measureComponent(options: {
	readonly component: PayComponent;
	readonly componentType: ComponentType;
	readonly bundle: EmploymentBundle;
	readonly configuration: Configuration;
	readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
	readonly employed: { readonly start: IsoDate; readonly end: IsoDate };
	readonly contracted: { readonly start: IsoDate; readonly end: IsoDate };
	readonly entries: readonly ComponentEntry[];
	readonly entryById: ReadonlyMap<string, ComponentEntry>;
	readonly unpaid: UnpaidLeave | null;
	readonly segments: readonly PricedSegment[];
	readonly excess: readonly ExcessHours[];
	readonly hourlyRate: number;
	readonly dayWage: number;
	readonly overtimeCalculationMethod: OvertimeCalculationMethod;
	readonly workingDaysIn: (window: { start: IsoDate; end: IsoDate }) => number;
	readonly context: () => FormulaContext;
}): Measurement | null {
	const definition = options.component.definition;
	if (definition == null)
		throw new Error(`Pay component ${options.component.code} has no definition to measure.`);

	switch (definition.source) {
		case 'SCHEDULE': {
			// The contracted wage, prorated by employment dates. A mid-period change is two terms
			// rows, each prorated against the same full-period divisor, and the two sum to the month.
			let amount = 0;
			for (const terms of options.bundle.terms) {
				const covered = clipRange(terms.effective_range, options.contracted);
				const fraction = prorationFraction({
					jurisdiction: options.configuration.jurisdiction,
					period: options.salary,
					covered,
					workingDaysIn: options.workingDaysIn
				});
				if (fraction <= 0) continue;
				amount += Number(asRateTerms(terms).base_salary.value) * fraction;
			}
			// A full-final-period policy extends the last effective wage through month end. The
			// contract row still ends on the real exit date; only this run's settlement span extends.
			if (options.employed.end > options.contracted.end) {
				const tail = {
					start: addDays(options.contracted.end, 1),
					end: options.employed.end
				};
				const fraction = prorationFraction({
					jurisdiction: options.configuration.jurisdiction,
					period: options.salary,
					covered: tail,
					workingDaysIn: options.workingDaysIn
				});
				amount +=
					Number(asRateTerms(termsAt(options.bundle, options.contracted.end)).base_salary.value) *
					fraction;
			}
			return { amount: cents(amount), quantity: null, rate: null, sources: [] };
		}

		case 'ENTRY': {
			if (options.entries.length === 0) return null;
			const percentage = definition.cap?.reimbursement_percentage ?? 100;
			let amount = 0;
			let quantity = 0;
			const sources: LineSource[] = [];
			for (const entry of options.entries) {
				const sign = entrySign(entry, options.entryById);
				const standing = standingRange(entry);
				const fraction = prorates(entry)
					? prorationFraction({
							jurisdiction: options.configuration.jurisdiction,
							period: options.salary,
							covered:
								standing == null
									? options.employed
									: (intersectDays(
											{ start: standing.start, end: standing.end ?? options.salary.end },
											options.employed
										) ?? null),
							workingDaysIn: options.workingDaysIn
						})
					: 1;
				if (fraction <= 0) continue;
				// The reimbursable share is an economic fact per claim, so it is rounded per entry and
				// then summed — not applied to a total that never existed.
				amount += sign * cents((Number(entry.amount) * fraction * percentage) / 100);
				quantity += sign * Number(entry.quantity ?? 0);
				sources.push({ kind: 'COMPONENT_ENTRY', entry_id: entry.norbital_id });
			}
			if (sources.length === 0) return null;
			return {
				amount: cents(amount),
				quantity: quantity === 0 ? null : quantity,
				rate: null,
				sources
			};
		}

		case 'FORMULA': {
			const amount = evaluateFormula({
				code: options.component.code,
				expr: definition.expr,
				context: options.context()
			});
			// An unpaid-absence formula reads its days from the ledger, so its provenance is the leave
			// requests that moved them.
			const sources: LineSource[] =
				options.unpaid?.leaveRequestIds.map((id) => ({
					kind: 'LEAVE_REQUEST' as const,
					leave_request_id: id
				})) ?? [];
			const quantity = options.unpaid?.days ?? null;
			if (amount === 0 && sources.length === 0 && definition.unit !== 'RATE') return null;
			return {
				amount: cents(Math.abs(amount)),
				quantity,
				rate: definition.unit === 'RATE' ? cents(Math.abs(amount)) : null,
				sources
			};
		}

		case 'OVERTIME': {
			const rule = definition.rule;
			const matched = options.segments.filter(
				(segment) =>
					segment.dayType === rule.day_type &&
					segment.measure === rule.measure &&
					segment.bandFrom === rule.band_from
			);
			if (matched.length === 0) return null;
			// `minimum` resolves by max(statutory, company): paying above statute is permitted,
			// paying below it is not expressible.
			const floor = definition.minimum ?? 0;
			let hours = 0;
			let weighted = 0;
			let dayWageAmount = 0;
			let datedAmount = 0;
			const sources = new Map<string, LineSource>();
			for (const segment of matched) {
				const multiple = Math.max(segment.multiple, floor);
				if (options.overtimeCalculationMethod === 'INFOTECH_ANNUALISED_DATED') {
					const unitRate =
						segment.award === 'DAY_WAGE_MULTIPLE'
							? cents(options.dayWage * multiple)
							: cents(options.hourlyRate * multiple);
					const units = segment.award === 'DAY_WAGE_MULTIPLE' ? 1 : segment.hours;
					datedAmount += cents(units * unitRate);
				} else if (segment.award === 'DAY_WAGE_MULTIPLE') {
					dayWageAmount += multiple * options.dayWage;
				} else {
					weighted += segment.hours * multiple;
				}
				hours += segment.hours;
				sources.set(segment.timeEntryId, {
					kind: 'TIME_ENTRY',
					time_entry_id: segment.timeEntryId
				});
			}
			const amount =
				options.overtimeCalculationMethod === 'INFOTECH_ANNUALISED_DATED'
					? cents(datedAmount)
					: cents(weighted * options.hourlyRate + dayWageAmount);
			if (amount === 0) return null;
			return { amount, quantity: hours, rate: options.hourlyRate, sources: [...sources.values()] };
		}

		case 'OVERTIME_EXCESS': {
			const rule = definition.rule;
			const matched = options.excess.filter(
				(row) =>
					row.dayType === rule.day_type &&
					row.measure === rule.measure &&
					row.bandFrom === rule.band_from
			);
			if (matched.length === 0) return null;
			if (matched.some((row) => row.valuedAt !== definition.valued_at))
				throw new Error(
					`The ${options.component.code} incentive component values a different kind of statutory award ` +
						'than the overtime rule produced.'
				);
			// Units are already the legal value factor: multiplier-weighted hours for hourly awards,
			// or the incremental statutory day-wage multiple for a stepped flat award.
			const units = matched.reduce((total, row) => total + row.units, 0);
			const hours = matched.reduce((total, row) => total + row.hours, 0);
			const rate =
				definition.valued_at === 'ORDINARY_DAY_WAGE' ? options.dayWage : options.hourlyRate;
			const amount =
				options.overtimeCalculationMethod === 'INFOTECH_ANNUALISED_DATED'
					? cents(
							matched.reduce((total, row) => {
								if (row.valuedAt === 'ORDINARY_DAY_WAGE')
									return total + cents(row.units * options.dayWage);
								const multiple = row.hours === 0 ? 0 : row.units / row.hours;
								return total + cents(row.hours * cents(options.hourlyRate * multiple));
							}, 0)
						)
					: cents(units * rate);
			if (amount === 0) return null;
			return {
				amount,
				quantity: hours,
				rate,
				sources: [
					...new Map(
						matched.map((row) => [
							row.timeEntryId,
							{ kind: 'TIME_ENTRY' as const, time_entry_id: row.timeEntryId }
						])
					).values()
				]
			};
		}
	}
	throw new Error(`Unsupported component source: ${Reflect.get(definition, 'source')}`);
}
