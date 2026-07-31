/**
 * Step 3 — GATHER.
 *
 * Everything about people, read once for the whole run: who was employed, on what terms, where they
 * stand with each statutory scheme, what entries they have this period, what leave they moved, what
 * they clocked and what they have already been paid this tax year.
 *
 * Only **live** rows are read — `norbital_approval_id IS NULL`. On this platform a null approval
 * stamp means the row is in force; a set one means it is still pending, and pending money is not
 * money. That predicate is on every query here without exception.
 */

import type { WorkspaceRow } from '../$types.js';
import { assertComplete, groupBy, PAGE_LIMIT, type PayrollReadApi } from './api.js';
import type { Configuration } from './configuration.js';
import {
	completedMonths,
	completedYears,
	dateKey,
	monthBounds,
	monthKey,
	type IsoDate
} from './dates.js';
import { effectiveWithin, live, overlapsRange } from './effective.js';
import type { LedgerRow } from './leave.js';
import { taxYearFirstPeriod, taxYearOf, type PayrollWindow } from './period.js';
import type { TimeEntryLike } from './overtime.js';
import {
	employmentDates,
	inExtendedLeavePopulation,
	resolveEmploymentSettlement,
	type EmploymentSettlement,
	type SettlementPolicy
} from './settlement.js';

export type Employment = WorkspaceRow<'employments'>;
export type Employee = WorkspaceRow<'employees'>;
export type EmploymentTerms = WorkspaceRow<'employment_terms'>;
export type StatutoryFact = WorkspaceRow<'employment_statutory_facts'>;
export type Agreement = WorkspaceRow<'repayment_agreements'>;
export type ComponentEntry = WorkspaceRow<'component_entries'>;
export type LeaveRequest = WorkspaceRow<'leave_requests'>;

/** One person's whole input to the run. */
export type EmploymentBundle = {
	readonly employment: Employment;
	readonly employee: Employee;
	/** Every terms row touching the pay period, in effective order — a mid-month raise is two rows. */
	readonly terms: readonly EmploymentTerms[];
	readonly statutoryFacts: readonly StatutoryFact[];
	readonly entries: readonly ComponentEntry[];
	readonly ledger: readonly LedgerRow[];
	readonly timeEntries: readonly TimeEntryLike[];
	readonly rosterEntries: readonly WorkspaceRow<'roster_entries'>[];
	readonly agreements: readonly Agreement[];
	/** Completed months of service at the period end. */
	readonly serviceMonths: number;
	/** Completed years of age at the period end, or `null` when no date of birth is recorded. */
	readonly age: number | null;
	/** The days of the pay period this employment covers, or `null` when it covers none. */
	readonly employedDays: { readonly start: IsoDate; readonly end: IsoDate } | null;
	/** The span recurring salary and standing allowances cover under the company's final-pay rule. */
	readonly wageDays: { readonly start: IsoDate; readonly end: IsoDate } | null;
	/**
	 * The attendance days **this employment** is measured over. Identical to the run's window for
	 * everyone except a leaver settling in their final period, whose window runs to the exit date.
	 */
	readonly attendance: { readonly start: IsoDate; readonly end: IsoDate };
	/** An earlier period this run is paying out, set only after a deferred joining period. */
	readonly arrearsFor: EmploymentSettlement['arrearsFor'];
	/**
	 * Set when this period is being deferred. The bundle is measured exactly like every other one —
	 * that is the point, the amount owed is what the run *would* have paid — and then diverted at
	 * persistence into an arrears entry instead of a payslip.
	 */
	readonly deferral: EmploymentSettlement['deferral'];
	/** Whether an extended unpaid absence settles in its own month for this employment. */
	readonly extendedLeaveSettlesInOwnMonth: boolean;
};

export type GatheredRun = {
	/** Everyone the run measures — deferred periods included; `bundle.deferral` tells them apart. */
	readonly bundles: readonly EmploymentBundle[];
	/** Active employments in the company at the period end — the HEADCOUNT band selector. */
	readonly headcount: number;
	/** `${employee_id}:${contribution_code}` → what has already been charged this tax year. */
	readonly yearToDate: ReadonlyMap<string, { employee: number; employer: number; base: number }>;
};

export async function gatherRun(options: {
	readonly api: PayrollReadApi;
	readonly configuration: Configuration;
	readonly window: PayrollWindow;
	readonly policy: SettlementPolicy;
}): Promise<GatheredRun> {
	const { window } = options;
	const period = window.period;
	const salary = window.salary;
	const { query } = options.api.db;
	const approved = { norbital_approval_id: { isNull: true } } as const;
	const companyId = options.configuration.company.norbital_id;

	const employmentRows = live(
		await query.employments.findMany({
			where: { company_id: { eq: companyId }, ...approved },
			limit: PAGE_LIMIT
		})
	);
	assertComplete(employmentRows, 'employments');

	// Someone is in the run if their employment touches the pay period at all — and then
	// `settlement.ts` says which run that period actually settles in. A leaver paid to the 10th is
	// still paid here; a joiner who started after this run's window closed has a period to settle
	// but no attendance to settle it against, so their money is deferred rather than guessed.
	const touching = employmentRows.filter((row) =>
		overlapsRange(row.effective_range, salary.start, salary.end)
	);
	const settlementByEmployment = new Map<string, EmploymentSettlement>();
	for (const row of touching)
		settlementByEmployment.set(
			row.norbital_id,
			resolveEmploymentSettlement({
				dates: employmentDates(row),
				window,
				policy: options.policy
			})
		);

	const employments = touching.filter((row) => {
		const settlement = settlementByEmployment.get(row.norbital_id);
		return settlement != null && (settlement.runs || settlement.deferral != null);
	});
	const employmentIds = employments.map((row) => row.norbital_id);
	if (employmentIds.length === 0) return { bundles: [], headcount: 0, yearToDate: new Map() };

	// One query span covers everyone: the widest attendance window any employment settles over, so
	// a leaver's tail is read in the same round trip as everybody else's window.
	const attendanceSpan = [...settlementByEmployment.values()].reduce(
		(span, settlement) => ({
			start: settlement.attendance.start < span.start ? settlement.attendance.start : span.start,
			end: settlement.attendance.end > span.end ? settlement.attendance.end : span.end
		}),
		{ start: window.attendance.start, end: window.attendance.end }
	);
	// A cutoff can straddle two months, but the 104-hour statutory counter resets on the first of
	// each calendar month. Read both months in full so 1st–20th work can correctly affect later
	// 21st–month-end work (and vice versa when it is paid in the following run).
	const complianceSpan = {
		start: monthBounds(monthKey(attendanceSpan.start)).start,
		end: monthBounds(monthKey(attendanceSpan.end)).end
	};

	const employeeIds = [...new Set(employments.map((row) => row.employee_id))];
	const inEmployments = { employment_id: { in: employmentIds }, ...approved } as const;

	const [
		employeeRows,
		termRows,
		factRows,
		entryRows,
		requestRows,
		ledgerRows,
		timeRows,
		rosterRows,
		agreementRows
	] = await Promise.all([
		query.employees.findMany({
			where: { norbital_id: { in: employeeIds }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.employment_terms.findMany({ where: inEmployments, limit: PAGE_LIMIT }),
		query.employment_statutory_facts.findMany({ where: inEmployments, limit: PAGE_LIMIT }),
		query.component_entries.findMany({ where: inEmployments, limit: PAGE_LIMIT }),
		query.leave_requests.findMany({ where: inEmployments, limit: PAGE_LIMIT }),
		query.leave_ledger.findMany({
			where: { employment_id: { in: employmentIds } },
			limit: PAGE_LIMIT
		}),
		query.time_entries.findMany({
			where: {
				employment_id: { in: employmentIds },
				work_date: { gte: complianceSpan.start, lte: complianceSpan.end },
				...approved
			},
			limit: PAGE_LIMIT
		}),
		query.roster_entries.findMany({
			where: {
				employment_id: { in: employmentIds },
				work_date: { gte: complianceSpan.start, lte: complianceSpan.end },
				...approved
			},
			limit: PAGE_LIMIT
		}),
		query.repayment_agreements.findMany({ where: inEmployments, limit: PAGE_LIMIT })
	]);
	// Every read above pages to the same ceiling, so every one of them is checked. A silently
	// truncated page is the one failure mode that produces a wrong payroll rather than no payroll:
	// a missing roster day changes a day type, a missing terms row changes a wage, and neither
	// leaves a trace. Roster entries are the closest to the ceiling of the lot.
	assertComplete(employeeRows, 'employees');
	assertComplete(termRows, 'employment terms');
	assertComplete(factRows, 'statutory facts');
	assertComplete(entryRows, 'component entries');
	assertComplete(requestRows, 'leave requests');
	assertComplete(ledgerRows, 'leave ledger rows');
	assertComplete(timeRows, 'time entries');
	assertComplete(rosterRows, 'roster entries');
	assertComplete(agreementRows, 'repayment agreements');

	const employeeById = new Map(live(employeeRows).map((row) => [row.norbital_id, row]));
	const termsByEmployment = groupBy(live(termRows), (row) => row.employment_id);
	const factsByEmployment = groupBy(live(factRows), (row) => row.employment_id);
	const entriesByEmployment = groupBy(live(entryRows), (row) => row.employment_id);
	/**
	 * An approved leave request already is the complete TAKEN movement: person, type, date, days
	 * and source id. Derive that movement directly so payroll never depends on a second seeded copy
	 * that can drift. The ledger remains for movements that are not requests — ADJUSTMENT and
	 * ENCASHMENT. Historical TAKEN projection rows are ignored, preventing double counting.
	 */
	const movementRows = ledgerRows.filter((row) => row.kind !== 'TAKEN');
	const takenRows: (LedgerRow & { readonly employment_id: string })[] = live(requestRows).map(
		(request) => ({
			norbital_id: request.norbital_id,
			employment_id: request.employment_id,
			leave_type_id: request.leave_type_id,
			entry_date: request.from_date,
			kind: 'TAKEN',
			days: -Math.abs(Number(request.days)),
			source_id: request.norbital_id,
			norbital_approval_id: null
		})
	);
	const ledgerByEmployment = groupBy([...movementRows, ...takenRows], (row) => row.employment_id);
	const timeByEmployment = groupBy(live(timeRows), (row) => row.employment_id);
	const rosterByEmployment = groupBy(live(rosterRows), (row) => row.employment_id);
	const agreementsByEmployment = groupBy(live(agreementRows), (row) => row.employment_id);

	const settlementOf = (employment: Employment): EmploymentSettlement => {
		const settlement = settlementByEmployment.get(employment.norbital_id);
		if (!settlement)
			throw new Error(
				`Employment ${employment.employee_number} was gathered without a settlement.`
			);
		return settlement;
	};

	const bundles: EmploymentBundle[] = [];
	for (const employment of employments) {
		const employee = employeeById.get(employment.employee_id);
		if (!employee)
			throw new Error(`Employment ${employment.employee_number} has no approved employee record.`);
		const settlement = settlementOf(employment);
		const hire = dateKey(employment.hire_date);
		if (hire == null) throw new Error(`Employment ${employment.employee_number} has no hire date.`);
		const dob = dateKey(employee.date_of_birth);
		const statutoryFacts = factsByEmployment.get(employment.norbital_id) ?? [];
		bundles.push({
			employment,
			employee,
			terms: effectiveWithin(
				termsByEmployment.get(employment.norbital_id) ?? [],
				salary.start,
				salary.end
			),
			statutoryFacts,
			entries: entriesByEmployment.get(employment.norbital_id) ?? [],
			ledger: ledgerByEmployment.get(employment.norbital_id) ?? [],
			timeEntries: timeByEmployment.get(employment.norbital_id) ?? [],
			rosterEntries: rosterByEmployment.get(employment.norbital_id) ?? [],
			agreements: agreementsByEmployment.get(employment.norbital_id) ?? [],
			serviceMonths: completedMonths(hire, salary.end),
			age: dob == null ? null : completedYears(dob, salary.end),
			employedDays: settlement.employedDays,
			wageDays: settlement.wageDays,
			attendance: settlement.attendance,
			arrearsFor: settlement.arrearsFor,
			deferral: settlement.deferral,
			extendedLeaveSettlesInOwnMonth: inExtendedLeavePopulation({
				policy: options.policy,
				statutoryFacts,
				asOf: salary.end
			})
		});
	}

	return {
		bundles,
		// Headcount is who the run pays. A deferred joining period pays nobody, and counting it would
		// move a headcount-banded contribution for everyone else in the company.
		headcount: bundles.filter((bundle) => bundle.deferral == null).length,
		yearToDate: await gatherYearToDate({
			api: options.api,
			configuration: options.configuration,
			period,
			employeeIds,
			companyId
		})
	};
}

/**
 * Year-to-date statutory charges.
 *
 * Two faults in the engine of record are fixed here, and both were verified to be safe against the
 * parity baseline before being changed:
 *
 * 1. **YTD is keyed on the employee, not the employment.** A transfer or a rehire creates a new
 *    employment, which zeroed the year-to-date mid-year and reset the PCB projection and both
 *    relief pools with it. The 2026 population has no transfers, so fixing it moves nothing today
 *    and stops misstating tax the first time someone moves (decision L34 / risk register #11).
 * 2. **Draft runs no longer count.** There was no lifecycle predicate at all, so an abandoned draft
 *    fed the next period's projection and nothing recomputed it when the draft was discarded. Only
 *    `PAID` runs are year-to-date (decision L35 / risk register #8).
 */
async function gatherYearToDate(options: {
	readonly api: PayrollReadApi;
	readonly configuration: Configuration;
	readonly period: string;
	readonly companyId: string;
	readonly employeeIds: readonly string[];
}): Promise<Map<string, { employee: number; employer: number; base: number }>> {
	const { query } = options.api.db;
	const startMonth = Number(options.configuration.jurisdiction.tax_year_start_month);
	const firstPeriod = taxYearFirstPeriod(options.period, startMonth);
	const priorRunRows = await query.payroll_runs.findMany({
		where: {
			company_id: { eq: options.companyId },
			period: { gte: firstPeriod, lt: options.period },
			lifecycle: { eq: 'PAID' }
		},
		limit: PAGE_LIMIT
	});
	assertComplete(priorRunRows, 'prior payroll runs');
	const priorRuns = priorRunRows.filter(
		(run) => taxYearOf(run.period, startMonth) === taxYearOf(options.period, startMonth)
	);
	const totals = new Map<string, { employee: number; employer: number; base: number }>();
	if (priorRuns.length === 0 || options.employeeIds.length === 0) return totals;

	// Employments are resolved employee-first so a mid-year transfer keeps its history: the person
	// is the taxpayer, not the contract.
	const siblingEmploymentRows = await query.employments.findMany({
		where: {
			company_id: { eq: options.companyId },
			employee_id: { in: [...options.employeeIds] }
		},
		limit: PAGE_LIMIT
	});
	assertComplete(siblingEmploymentRows, 'sibling employments');
	const siblingEmployments = live(siblingEmploymentRows);
	const employmentToEmployee = new Map(
		siblingEmployments.map((row) => [row.norbital_id, row.employee_id])
	);
	const priorPayslips = await query.payslips.findMany({
		where: {
			payroll_run_id: { in: priorRuns.map((run) => run.norbital_id) },
			employment_id: { in: siblingEmployments.map((row) => row.norbital_id) }
		},
		limit: PAGE_LIMIT
	});
	assertComplete(priorPayslips, 'prior payslips');
	if (priorPayslips.length === 0) return totals;

	const contributionCodeById = new Map(
		options.configuration.contributions.map((entry) => [entry.row.norbital_id, entry.row.code])
	);
	const charges = await query.payslip_contributions.findMany({
		where: { payslip_id: { in: priorPayslips.map((row) => row.norbital_id) } },
		limit: PAGE_LIMIT
	});
	assertComplete(charges, 'prior statutory charges');
	const employeeByPayslip = new Map(
		priorPayslips.map((row) => [row.norbital_id, employmentToEmployee.get(row.employment_id)])
	);
	for (const charge of charges) {
		const employeeId = employeeByPayslip.get(charge.payslip_id);
		const code = contributionCodeById.get(charge.statutory_contribution_id);
		if (employeeId == null || code == null) continue;
		const key = `${employeeId}:${code}`;
		const running = totals.get(key) ?? { employee: 0, employer: 0, base: 0 };
		totals.set(key, {
			employee: running.employee + Number(charge.employee_amount),
			employer: running.employer + Number(charge.employer_amount),
			base: running.base + Number(charge.base_amount)
		});
	}
	return totals;
}

/** The key `gatherYearToDate` files a total under. */
export function yearToDateKey(employeeId: string, contributionCode: string): string {
	return `${employeeId}:${contributionCode}`;
}
