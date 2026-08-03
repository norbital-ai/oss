/**
 * The workbook vocabulary.
 *
 * The customer's payroll workbook has a settled column vocabulary — `overtimePay`,
 * `proratedSalary`, `grossEarnings` — and the parity manifests compare those named ids. That
 * vocabulary is **presentation**, so it lives here, in the export path, and not as a column on any
 * model. A pay component knows its code, its type and how it is measured; it does not know what a
 * spreadsheet calls it.
 *
 * Everything below is derived from what was persisted — `payslip_lines` grouped by component type,
 * `payslip_contributions` walked scheme by scheme, and the payslip's own four totals. No output id
 * is stored anywhere.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * NO JURISDICTION IS NAMED IN THIS FILE.
 *
 * A statutory column is produced by the contribution that charged it, not by a list of the schemes
 * one country happens to run. This module walks whatever `payslip_contributions` a run actually
 * produced and asks `vocabulary.ts` what the workbook calls each one; a Philippine run therefore
 * exports `sssEmployee` and `withholdingTax` for the same reason a Malaysian one exports
 * `epfEmployee` and `pcb` — because that is what was charged. Adding a jurisdiction is an addition
 * to `vocabulary.ts` and no change at all here.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { statutoryNaming, statutoryOutputIds, type StatutoryRole } from './vocabulary.js';

export type ReportLine = {
	readonly payComponentCode: string;
	readonly componentTypeCode: string;
	readonly nature: string;
	readonly amount: number;
	readonly quantity: number | null;
	/** An audited company expense whose cash never passes through the employee. */
	readonly isCompanyDirect: boolean;
	/** A capped employee reimbursement, excluding unrelated non-wage payments such as tax refunds. */
	readonly isClaim: boolean;
	/** `OVERTIME` / `OVERTIME_EXCESS` lines carry the day type of the rule they pay. */
	readonly overtimeDayType: 'ORDINARY' | 'REST_DAY' | 'PUBLIC_HOLIDAY' | null;
	readonly isOvertimeExcess: boolean;
};

export type ReportPayslip = {
	readonly employmentId: string;
	readonly employeeNumber: string;
	readonly currency: string;
	readonly designation: string | null;
	readonly section: string | null;
	readonly group: string | null;
	readonly employeeName: string;
	readonly identityNumber: string | null;
	readonly hireDate: string;
	readonly lastDay: string | null;
	readonly attendance: {
		readonly normalHours: number;
		readonly actualHours: number;
		readonly shiftCodes: readonly string[];
	};
	readonly gross: number;
	readonly totalDeductions: number;
	readonly net: number;
	readonly employerCost: number;
	readonly lines: readonly ReportLine[];
	/** Scheme code → what it charged. */
	readonly contributions: ReadonlyMap<string, { base: number; employee: number; employer: number }>;
};

export type OutputSection = {
	readonly name: string;
	readonly unit: 'MONEY' | 'HOURS';
	readonly outputIds: readonly string[];
};

export const VENDOR_WORKBOOK_SECTIONS: readonly OutputSection[] = [
	{
		name: 'Identity',
		unit: 'MONEY',
		outputIds: ['designation', 'section', 'group', 'eid', 'name', 'ic_no', 'hire_date', 'last_day']
	},
	{
		name: 'Earnings & absence',
		unit: 'MONEY',
		outputIds: [
			'basic_salary',
			'allowance',
			'overtime',
			'aws',
			'back_pay_bonus',
			'back_pay_ot',
			'back_pay_basic_npl',
			'leave_encashment',
			'no_pay_leave',
			'no_pay_leave_adj',
			'annual_leave_deduction',
			'short_notice'
		]
	},
	{ name: 'Gross', unit: 'MONEY', outputIds: ['gross_salary'] },
	{
		name: 'Post-gross payments & deductions',
		unit: 'MONEY',
		outputIds: [
			'incentive_ot',
			'incentive_aws',
			'medical_claim',
			'renewal_incentive',
			'ex_gratia_loss',
			'attendance_allowance',
			'loan_recovery',
			'pcb_back_pay',
			'medical_recover_ee',
			'cp38_amount'
		]
	},
	{ name: 'Net', unit: 'MONEY', outputIds: ['net_salary'] },
	{
		name: 'Statutory',
		unit: 'MONEY',
		outputIds: [
			'fw_levy',
			'check_vendor_workbook',
			'epf_employee',
			'socso_employee',
			'eis_employee',
			'tax_employee',
			'epf_employer',
			'socso_employer',
			'eis_employer',
			'hrdf',
			'remark'
		]
	},
	{
		name: 'Totals & bases',
		unit: 'MONEY',
		outputIds: [
			'total_socso',
			'total_eis',
			'total_epf',
			'remuneration_for_tax',
			'epf_gross',
			'socso_gross',
			'total_expenses'
		]
	},
	{
		name: 'Attendance',
		unit: 'HOURS',
		outputIds: [
			'att_ot_1x_hours',
			'att_ot_15x_hours',
			'att_ot_2x_hours',
			'att_ot_3x_hours',
			'att_ot_flat_hours',
			'att_normal_hours',
			'att_actual_hours',
			'att_shift_codes'
		]
	}
];

export const VENDOR_WORKBOOK_COLUMNS = VENDOR_WORKBOOK_SECTIONS.flatMap(
	(section) => section.outputIds
);

/**
 * The sections and their order.
 *
 * The order is the customer's own workbook, read column by column: identity, then what was earned
 * and what absence took away, then gross, then what is paid or recovered after gross, then net,
 * then the statutory charges, then the totals and the bases they were charged on, and finally
 * attendance. A payroll clerk who knows that workbook can read this one without being taught it.
 *
 * `unit` is not decoration: an attendance column counts hours, and formatting hours as money — or
 * tinting them like money — is how a reader ends up reading 7.50 as seven ringgit fifty.
 *
 * The two statutory sections name **roles**, not columns. Which columns those roles resolve to is
 * decided by the schemes the jurisdiction actually runs, so this layout is the same layout in Kuala
 * Lumpur and in Manila — only its statutory block is filled differently.
 */
const SECTION_LAYOUT: readonly {
	readonly name: string;
	readonly unit: 'MONEY' | 'HOURS';
	readonly statutoryRoles?: readonly StatutoryRole[];
	readonly outputIds?: readonly string[];
}[] = [
	{
		name: 'Earnings & absence',
		unit: 'MONEY',
		outputIds: [
			'proratedSalary',
			'taxableBenefits',
			'exemptBenefits',
			'overtimePay',
			'totalUnpaidLeaveDeduction'
		]
	},
	{ name: 'Gross', unit: 'MONEY', outputIds: ['grossEarnings'] },
	{
		// `incentiveOTPay` sits here because that is where the customer's workbook puts it. Note the
		// difference behind the column: their gross excludes incentive overtime, while `gross` here
		// is Σ EARNING − Σ ABSENCE and the reclassified hours are an earning, so this column is
		// inside the gross to its left. The columns tally; the two grosses are not defined alike.
		name: 'Post-gross payments & deductions',
		unit: 'MONEY',
		outputIds: ['incentiveOTPay', 'totalClaims', 'loanRecovery', 'adhocDeductions']
	},
	{ name: 'Net', unit: 'MONEY', outputIds: ['netPay'] },
	{ name: 'Statutory', unit: 'MONEY', statutoryRoles: ['employee', 'employer'] },
	{
		name: 'Totals & bases',
		unit: 'MONEY',
		statutoryRoles: ['total', 'base'],
		outputIds: ['totalDeductions', 'employerCost']
	},
	{
		name: 'Attendance',
		unit: 'HOURS',
		outputIds: ['ot10Hours', 'ot15Hours', 'ot20Hours', 'ot30Hours', 'totalOTHours']
	}
];

/** The layout with its statutory roles resolved to every column the vocabulary can name. */
export const OUTPUT_SECTIONS: readonly OutputSection[] = SECTION_LAYOUT.map((section) => ({
	name: section.name,
	unit: section.unit,
	outputIds: [...statutoryOutputIds(section.statutoryRoles ?? []), ...(section.outputIds ?? [])]
}));

/** Where output ids the vocabulary does not rank are collected, so a new id is never dropped. */
const OTHER_SECTION_NAME = 'Other';

/**
 * Component types that are neither the contractual base nor overtime, and are therefore reported as
 * benefits. Unpaid absence is not among them: it sits in Info Lines, because gross has already
 * netted it and rendering it inside Earnings would read as a double subtraction (decision L31).
 */
const BENEFIT_TYPES = new Set([
	'FIXED_ALLOWANCE',
	'VARIABLE_ALLOWANCE',
	'COMMISSION',
	'BONUS',
	'BENEFIT_IN_KIND',
	'LEAVE_ENCASHMENT',
	'TERMINATION_PAY'
]);

const ADHOC_DEDUCTION_TYPES = new Set(['OTHER_DEDUCTION', 'SALARY_SACRIFICE', 'STATUTORY_ORDER']);

function sumLines(payslip: ReportPayslip, predicate: (line: ReportLine) => boolean): number {
	return payslip.lines.reduce((total, line) => total + (predicate(line) ? line.amount : 0), 0);
}

function sumHours(payslip: ReportPayslip, predicate: (line: ReportLine) => boolean): number {
	return payslip.lines.reduce(
		(total, line) => total + (predicate(line) ? (line.quantity ?? 0) : 0),
		0
	);
}

function contribution(
	payslip: ReportPayslip,
	code: string,
	field: 'base' | 'employee' | 'employer'
): number {
	return payslip.contributions.get(code)?.[field] ?? 0;
}

function epf(payslip: ReportPayslip, field: 'base' | 'employee' | 'employer'): number {
	const citizen = contribution(payslip, 'EPF', field);
	const nonCitizen = contribution(payslip, 'EPF_NON_CITIZEN', field);
	// The two schemes are mutually exclusive, but the contribution engine persists the assessed
	// base for the non-enrolled scheme as well. Amounts can be summed because only one scheme
	// charges; a base must select the charged scheme instead of counting the same wages twice.
	return field === 'base' ? Math.max(citizen, nonCitizen) : citizen + nonCitizen;
}

function componentAmount(payslip: ReportPayslip, codes: readonly string[]): number {
	const wanted = new Set(codes);
	return sumLines(payslip, (line) => wanted.has(line.payComponentCode));
}

/**
 * The settled vendor workbook row. Its keys and order are the source workbook contract,
 * while every value is read from persisted payroll, identity, terms and attendance records.
 */
export function vendorWorkbookRow(payslip: ReportPayslip): Record<string, string | number | null> {
	const generic = workbookRow(payslip);
	const incentiveOvertime = generic.incentiveOTPay ?? 0;
	const medicalClaim = componentAmount(payslip, ['MEDICAL_CLAIM']);
	const regularAllowance = sumLines(
		payslip,
		(line) =>
			BENEFIT_TYPES.has(line.componentTypeCode) &&
			!line.isOvertimeExcess &&
			!['BPAYBS', 'ALPAY', 'PHILE'].includes(line.payComponentCode)
	);
	return {
		designation: payslip.designation,
		section: payslip.section,
		group: payslip.group,
		eid: payslip.employeeNumber,
		name: payslip.employeeName,
		ic_no: payslip.identityNumber,
		hire_date: payslip.hireDate,
		last_day: payslip.lastDay,
		basic_salary: generic.proratedSalary ?? 0,
		allowance: regularAllowance,
		overtime: generic.overtimePay ?? 0,
		aws: componentAmount(payslip, ['AWS']),
		back_pay_bonus: componentAmount(payslip, ['BACK_PAY_BONUS']),
		back_pay_ot: componentAmount(payslip, ['BACK_PAY_OT']),
		back_pay_basic_npl: componentAmount(payslip, ['BPAYBS']),
		leave_encashment: componentAmount(payslip, ['ALPAY', 'PHILE']),
		no_pay_leave: componentAmount(payslip, ['UNPAID_LEAVE_DEDUCTION', 'SOURCE_ABSENCE_CORRECTION']),
		no_pay_leave_adj: componentAmount(payslip, ['NO_PAY_LEAVE_ADJUSTMENT']),
		annual_leave_deduction: componentAmount(payslip, ['ANNUAL_LEAVE_DEDUCTION']),
		short_notice: componentAmount(payslip, ['SHORT_NOTICE']),
		gross_salary: payslip.gross,
		incentive_ot: incentiveOvertime,
		incentive_aws: componentAmount(payslip, ['INCENTIVE_AWS']),
		medical_claim: medicalClaim,
		renewal_incentive: componentAmount(payslip, ['RENEWAL_INCENTIVE']),
		ex_gratia_loss: componentAmount(payslip, ['EX_GRATIA_LOSS']),
		attendance_allowance: componentAmount(payslip, ['ATTENDANCE_ALLOWANCE']),
		loan_recovery: generic.loanRecovery ?? 0,
		pcb_back_pay: componentAmount(payslip, ['PCB_BACK_PAY']),
		medical_recover_ee: componentAmount(payslip, ['MEDICAL_RECOVER_EE']),
		cp38_amount: componentAmount(payslip, ['CP38']),
		net_salary: payslip.net,
		fw_levy: componentAmount(payslip, ['FOREIGN_WORKER_LEVY']),
		check_vendor_workbook: null,
		epf_employee: epf(payslip, 'employee'),
		socso_employee: contribution(payslip, 'SOCSO', 'employee'),
		eis_employee: contribution(payslip, 'EIS', 'employee'),
		tax_employee: contribution(payslip, 'PCB', 'employee'),
		epf_employer: epf(payslip, 'employer'),
		socso_employer: contribution(payslip, 'SOCSO', 'employer'),
		eis_employer: contribution(payslip, 'EIS', 'employer'),
		hrdf: contribution(payslip, 'HRDF', 'employer'),
		remark: null,
		total_socso:
			contribution(payslip, 'SOCSO', 'employee') + contribution(payslip, 'SOCSO', 'employer'),
		total_eis: contribution(payslip, 'EIS', 'employee') + contribution(payslip, 'EIS', 'employer'),
		total_epf: epf(payslip, 'employee') + epf(payslip, 'employer'),
		// The vendor workbook labels the post-EPF remuneration here, not the PCB scheme's gross input.
		// The contribution calculation still receives the full taxable base and applies the EPF
		// relief itself; this subtraction is presentation parity only.
		remuneration_for_tax: contribution(payslip, 'PCB', 'base') - epf(payslip, 'employee'),
		epf_gross: epf(payslip, 'base'),
		socso_gross: contribution(payslip, 'SOCSO', 'base'),
		total_expenses: payslip.gross + incentiveOvertime + medicalClaim + payslip.employerCost,
		att_ot_1x_hours: generic.ot10Hours ?? 0,
		att_ot_15x_hours: generic.ot15Hours ?? 0,
		att_ot_2x_hours: generic.ot20Hours ?? 0,
		att_ot_3x_hours: generic.ot30Hours ?? 0,
		att_ot_flat_hours: 0,
		att_normal_hours: payslip.attendance.normalHours,
		att_actual_hours: payslip.attendance.actualHours,
		att_shift_codes: payslip.attendance.shiftCodes.join(', ')
	};
}

/**
 * The statutory columns, derived from the schemes the run actually charged.
 *
 * Nothing here knows a country. Every `payslip_contributions` row carries the scheme that produced
 * it, and the scheme's code is what the workbook vocabulary is keyed by — so a run charges SSS and
 * the sheet grows an `sssEmployee` column, for the same reason and by the same code path that a
 * Malaysian run grows an `epfEmployee` one.
 *
 * A charge that has nowhere to go is an error, not a rounding-down to zero: if a scheme took money
 * from someone and this vocabulary cannot name the column, the workbook must not be written. The
 * alternative is a sheet in which "we did not charge you" and "we charged you and lost the number"
 * are the same empty cell.
 */
function statutoryOutputs(payslip: ReportPayslip): Record<string, number> {
	const outputs: Record<string, number> = {};
	const add = (outputId: string, amount: number): void => {
		outputs[outputId] = (outputs[outputId] ?? 0) + amount;
	};
	for (const [code, charged] of payslip.contributions) {
		const naming = statutoryNaming(code);
		for (const side of ['employee', 'employer'] as const)
			if (naming[side] == null && charged[side] !== 0)
				throw new Error(
					`Statutory contribution ${JSON.stringify(code)} charged the ${side} ` +
						`${charged[side]} but has no ${side} column. Name it in STATUTORY_VOCABULARY ` +
						`(lib/vocabulary.ts).`
				);
		if (naming.employee != null) add(naming.employee, charged.employee);
		if (naming.employer != null) add(naming.employer, charged.employer);
		if (naming.total != null) add(naming.total, charged.employee + charged.employer);
		if (naming.base != null) add(naming.base, charged.base);
	}
	return outputs;
}

/**
 * One payslip as the workbook sees it.
 *
 * The overtime-hours columns are named for the multiplier they historically carried; they are
 * derived from the day type of the rule each line pays, which is the stable fact — a jurisdiction
 * that changes its rest-day multiple does not change what a rest day is.
 *
 * `ot10Hours` is the exception, and it is derived from the award rather than the day: hours past
 * the statutory daily overtime ceiling are reclassified and valued at `ORDINARY_HOURLY` — the plain
 * hourly rate, no multiple — so they belong in a 1.0× bucket and not in the 1.5× one their day type
 * would otherwise put them in. Counting them by day type overstated the multiplied buckets by
 * exactly the excess hours, which is the tally the customer reconciles against.
 */
export function workbookRow(payslip: ReportPayslip): Record<string, number> {
	const overtimePay = sumLines(
		payslip,
		(line) => line.componentTypeCode === 'OVERTIME' && !line.isOvertimeExcess
	);
	const incentiveOTPay = sumLines(payslip, (line) => line.isOvertimeExcess);
	const multipliedHours = (dayType: ReportLine['overtimeDayType']): number =>
		sumHours(payslip, (line) => !line.isOvertimeExcess && line.overtimeDayType === dayType);
	return {
		proratedSalary: sumLines(payslip, (line) => line.componentTypeCode === 'BASIC_SALARY'),
		overtimePay,
		incentiveOTPay,
		// Overtime corresponding to work past the total-work-hours boundary is reclassified to a
		// benefit component type, so it would
		// otherwise be reported twice: once here and once as `incentiveOTPay`. The customer's
		// workbook keeps its allowance column and its incentive-overtime column disjoint, and so
		// does this one.
		taxableBenefits: sumLines(
			payslip,
			(line) => BENEFIT_TYPES.has(line.componentTypeCode) && !line.isOvertimeExcess
		),
		// The rebuilt type list has no exempt-earning kind: a payment that is not wages is a
		// REIMBURSEMENT and is reported under Reimbursements. The column is kept so the workbook
		// vocabulary is unchanged, and it is always zero.
		exemptBenefits: 0,
		totalClaims: sumLines(
			payslip,
			(line) => line.nature === 'NON_WAGE_PAYMENT' && line.isClaim && !line.isCompanyDirect
		),
		ot10Hours: sumHours(payslip, (line) => line.isOvertimeExcess),
		ot15Hours: multipliedHours('ORDINARY'),
		ot20Hours: multipliedHours('REST_DAY'),
		ot30Hours: multipliedHours('PUBLIC_HOLIDAY'),
		totalOTHours: sumHours(payslip, (line) => line.overtimeDayType != null),
		totalUnpaidLeaveDeduction: sumLines(payslip, (line) => line.nature === 'ABSENCE'),
		loanRecovery: sumLines(payslip, (line) => line.componentTypeCode === 'LOAN_REPAYMENT'),
		adhocDeductions: sumLines(payslip, (line) => ADHOC_DEDUCTION_TYPES.has(line.componentTypeCode)),
		grossEarnings: payslip.gross,
		totalDeductions: payslip.totalDeductions,
		employerCost: payslip.employerCost,
		netPay: payslip.net,
		// The statutory block, and with it the per-scheme totals and the wages each scheme was
		// charged on. Every one of these is already persisted on `payslip_contributions`; nothing
		// here is a new calculation, and nothing here is a jurisdiction's name.
		...statutoryOutputs(payslip)
	};
}

/**
 * One sheet's rows, squared off.
 *
 * A sheet's columns are the union of what its payslips produced, and an employment enrolled in one
 * scheme fewer than its colleagues would otherwise leave that column blank on its row. Blank is not
 * what happened: the scheme was assessed and charged nothing. Filling it with an explicit zero is
 * the difference between "this employee contributed nothing" and "this cell was never written",
 * and every reconciliation that walks the sheet reads the second as a defect.
 *
 * This is safe precisely because it is per sheet, and a sheet is one legal entity's period and so
 * one jurisdiction: a zero here says a scheme this population runs did not charge *this* person. A
 * scheme the population does not run has no column at all, which is the honest answer.
 */
export function workbookRows(payslips: readonly ReportPayslip[]): Record<string, number>[] {
	const rows = payslips.map((payslip) => workbookRow(payslip));
	const outputIds = new Set(rows.flatMap((row) => Object.keys(row)));
	for (const row of rows)
		for (const outputId of outputIds) if (!(outputId in row)) row[outputId] = 0;
	return rows;
}

/**
 * The sections the given rows actually populate, in vocabulary order, each holding only the output
 * ids present. An id the vocabulary does not rank is not dropped — it lands in a trailing `Other`
 * section, so adding an output to `workbookRow` can never silently lose a column.
 */
export function outputGroups(rows: readonly Record<string, number>[]): OutputSection[] {
	const present = new Set(rows.flatMap((row) => Object.keys(row)));
	const ranked = new Set<string>(OUTPUT_SECTIONS.flatMap((section) => [...section.outputIds]));
	const groups: OutputSection[] = OUTPUT_SECTIONS.map((section) => ({
		name: section.name,
		unit: section.unit,
		outputIds: section.outputIds.filter((id) => present.has(id))
	})).filter((section) => section.outputIds.length > 0);
	const unranked = [...present].filter((id) => !ranked.has(id)).toSorted();
	return unranked.length === 0
		? groups
		: [...groups, { name: OTHER_SECTION_NAME, unit: 'MONEY', outputIds: unranked }];
}

/** Output ids in section order, unranked ids appended alphabetically. */
export function orderedOutputIds(rows: readonly Record<string, number>[]): string[] {
	return outputGroups(rows).flatMap((section) => [...section.outputIds]);
}

export function sectionOf(outputId: string): string | null {
	for (const section of OUTPUT_SECTIONS)
		if (section.outputIds.includes(outputId)) return section.name;
	return null;
}
