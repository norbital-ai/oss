/**
 * The payroll run — eight steps, the same eight for every country.
 *
 * | # | step       | does                                                                          |
 * | - | ---------- | ----------------------------------------------------------------------------- |
 * | 1 | PICK       | resolve the governing configuration as of the period end → `configuration_hash` |
 * | 2 | VALIDATE   | everything that can be wrong before a person is read. Blocked on failure       |
 * | 3 | GATHER     | per employment: entries, leave, time, terms, statutory standing, year-to-date  |
 * | 4 | MEASURE    | in component-type sequence, produce amounts → `payslip_lines`                  |
 * | 5 | ACCUMULATE | each line through the grid → contribution bases                                |
 * | 6 | CONTRIBUTE | each scheme in sequence: base → employee and employer amounts                   |
 * | 7 | SETTLE     | gross, total deductions, net, employer cost                                    |
 * | 8 | PERSIST    | payslip, lines, charges, and what each line consumed                           |
 *
 * Step 5 never names EPF. Step 6 never names overtime. Neither knows Malaysia.
 *
 * Re-entry is idempotent by construction: a rebuild deletes the run's results first, so building
 * twice produces the same four collections rather than two overlapping halves.
 */

import { accumulateBases } from './accumulate.js';
import { readLog, resetReadLog, type PayrollApi, type PayrollReadApi } from './api.js';
import { pickConfiguration, type Configuration } from './configuration.js';
import { contribute, type StatutoryFactStatus } from './contribute.js';
import { coversDate } from './effective.js';
import { gatherRun } from './gather.js';
import { measureEmployment } from './measure.js';
import { payPeriodsRemaining, resolveWindow, type PayrollWindow } from './period.js';
import {
	clearRunResults,
	persistDeferrals,
	persistPayslips,
	persistShortfalls,
	type PendingDeferral,
	type PendingPayslip
} from './persist.js';
import { settle } from './settle.js';
import { requiredDateKey, shiftPeriod } from './dates.js';
import { readSettlementPolicy } from './settlement.js';
import {
	blockers,
	describeBlockers,
	validateConfiguration,
	validateDailyWorkLimit,
	validateOvertimeLimits,
	validatePayCalendar,
	type RunIssue
} from './validate.js';

export type PayrollRunResult = {
	readonly window: PayrollWindow;
	readonly configuration: Configuration;
	readonly payslipCount: number;
	readonly lineCount: number;
	readonly issues: readonly RunIssue[];
};

/** Resolve the window and the governing configuration without building anything. */
export async function preparePayrollRun(options: {
	readonly api: PayrollReadApi;
	readonly companyId: string;
	readonly period: string;
}): Promise<{ window: PayrollWindow; configuration: Configuration }> {
	const company = await options.api.db.query.companies.findFirst({
		where: { norbital_id: { eq: options.companyId }, norbital_approval_id: { isNull: true } }
	});
	if (!company) throw new Error(`Company ${options.companyId} does not exist.`);
	const window = resolveWindow(options.period, company);
	const configuration = await pickConfiguration({
		api: options.api,
		companyId: options.companyId,
		period: options.period,
		salary: window.salary,
		attendance: window.attendance
	});
	return { window, configuration };
}

/**
 * Build one company's payroll for one period.
 *
 * The run record must already exist — it carries the configuration hash and the window the build
 * was picked against, so that a payslip can always be traced to the law it was computed under.
 */
export async function buildPayrollRun(options: {
	readonly api: PayrollApi;
	readonly runId: string;
	readonly companyId: string;
	readonly period: string;
}): Promise<PayrollRunResult> {
	/**
	 * Phase timing. The engine runs inside the tenant runtime container, so every database call is
	 * an RPC hop before it is a query — which makes "how long did each phase take" the only honest
	 * way to tell a slow query from a chatty one from slow arithmetic.
	 */
	resetReadLog();
	const t0 = Date.now();
	let mark = t0;
	const phases: [string, number][] = [];
	const lap = (name: string): void => {
		const now = Date.now();
		phases.push([name, now - mark]);
		mark = now;
	};

	// 1 — PICK
	const { window, configuration } = await preparePayrollRun(options);
	lap('pick');

	// 2 — VALIDATE
	const issues: RunIssue[] = validateConfiguration(configuration);
	if (blockers(issues).length > 0) throw new Error(describeBlockers(issues));
	lap('validate');

	// 3 — GATHER
	const policy = readSettlementPolicy(configuration.company);
	const gathered = await gatherRun({ api: options.api, configuration, window, policy });

	lap('gather');

	const openTimeEntry = gathered.bundles
		.flatMap((bundle) => bundle.timeEntries)
		.find((entry) => entry.state === 'OPEN');
	if (openTimeEntry)
		throw new Error(
			`A time entry in the attendance window is still open (${requiredDateKey(openTimeEntry.work_date, 'time_entries.work_date')}). ` +
				'Payroll cannot price a clock that has not stopped.'
		);

	const periodsRemaining = payPeriodsRemaining(
		options.period,
		Number(configuration.jurisdiction.tax_year_start_month)
	);

	issues.push(...validatePayCalendar({ configuration, bundles: gathered.bundles }));

	const pending: PendingPayslip[] = [];
	const deferrals: PendingDeferral[] = [];
	const shortfalls: { employmentId: string; payComponentId: string; amount: number }[] = [];

	for (const bundle of gathered.bundles) {
		// A skipped joining period is skipped: no payslip, no lines, no statutory charge. The days it
		// covers are not lost — the next run derives them from this employment's own contract, which
		// is why nothing has to be handed over here for that to work.
		if (bundle.deferral != null) continue;

		// 4 — MEASURE
		const measured = measureEmployment({
			bundle,
			configuration,
			period: options.period,
			salary: window.salary,
			periodsRemaining,
			headcount: gathered.headcount,
			policy
		});
		if (measured.arrears != null)
			deferrals.push({
				employmentId: bundle.employment.norbital_id,
				employeeNumber: bundle.employment.employee_number,
				hireDate: bundle.employment.hire_date,
				coversPeriod: measured.arrears.period,
				paidInPeriod: options.period,
				payComponentId: measured.arrears.payComponentId,
				amount: measured.arrears.amount
			});

		for (const [calendarMonth, monthHours] of measured.calendarMonthOvertimeHours) {
			issues.push(
				...validateOvertimeLimits({
					configuration,
					employeeNumber: bundle.employment.employee_number,
					calendarMonth,
					monthHours
				})
			);
		}
		issues.push(
			...validateDailyWorkLimit({
				employeeNumber: bundle.employment.employee_number,
				days: measured.overtimeDays,
				maxWorkHours: 12
			})
		);

		// 5 — ACCUMULATE
		const bases = accumulateBases({
			configuration,
			lines: measured.lines,
			employeeNumber: bundle.employment.employee_number
		});

		// 6 — CONTRIBUTE
		const facts = new Map<string, StatutoryFactStatus>();
		const statutoryAsOf = bundle.employedDays?.end ?? window.salary.end;
		for (const fact of bundle.statutoryFacts) {
			// A leaver's registration remains authoritative through their actual final day. Testing
			// the calendar month's end instead would make every fact look expired and silently fall
			// back to the scheme default during final pay.
			if (!coversDate(fact.effective_range, statutoryAsOf)) continue;
			const status = fact.status;
			if (status == null) continue;
			facts.set(fact.statutory_contribution_id, {
				kind: status.kind,
				rate_override: status.kind === 'REGISTERED' ? status.rate_override : null
			});
		}
		const charges = contribute({
			bases,
			facts,
			yearToDate: (code) =>
				gathered.yearToDate.get(`${bundle.employment.employee_id}:${code}`) ?? {
					employee: 0,
					employer: 0,
					base: 0
				},
			age: bundle.age,
			headcount: gathered.headcount,
			riskClass: configuration.company.risk_class,
			periodsRemaining,
			// The relief and the married scale turn on whether the spouse has income, not on
			// `marital_status` — see employees.spouse_status.
			spouseIsDependent: bundle.employee.spouse_status === 'WITHOUT_INCOME',
			dependents: Number(bundle.employee.dependents_count ?? 0)
		});

		// 7 — SETTLE
		const settlement = settle({ lines: measured.lines, charges });
		for (const shortfall of settlement.shortfalls)
			shortfalls.push({ employmentId: bundle.employment.norbital_id, ...shortfall });

		pending.push({
			employmentId: bundle.employment.norbital_id,
			currency: measured.currency,
			settlement,
			charges
		});
	}

	if (blockers(issues).length > 0) throw new Error(describeBlockers(issues));
	lap('calculate');

	// 8 — PERSIST
	await clearRunResults(options.api, options.runId);
	lap('clear');
	const written = await persistPayslips({ api: options.api, runId: options.runId, pending });
	lap('persist');
	await persistShortfalls({
		api: options.api,
		period: options.period,
		nextPeriod: shiftPeriod(options.period, 1),
		payDate: window.payDate,
		shortfalls
	});
	lap('shortfalls');
	await persistDeferrals({ api: options.api, deferrals });
	lap('deferrals');

	console.log(
		`[payroll-timing] ${options.period} total=${Date.now() - t0}ms ` +
			phases.map(([name, ms]) => `${name}=${ms}ms`).join(' ') +
			` | employments=${gathered.bundles.length} payslips=${written.payslipCount} lines=${written.lineCount}` +
			`\n[payroll-reads] ${readLog()}`
	);

	return {
		window,
		configuration,
		payslipCount: written.payslipCount,
		lineCount: written.lineCount,
		issues
	};
}
