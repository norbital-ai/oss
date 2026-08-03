/**
 * Step 7 — SETTLE.
 *
 * Four numbers, derived entirely from `pay_components.nature` and the statutory lines. Nothing
 * here reads a component code.
 *
 * ```
 * gross            = Σ EARNING − Σ ABSENCE
 * statutory (ee)   = Σ payslip_lines(STATUTORY_EMPLOYEE).amount
 * other deductions = Σ DEDUCTION lines
 * payments         = Σ NON_WAGE_PAYMENT lines settled through payroll
 *
 * net              = gross − statutory − other + payments
 * employer cost    = Σ employer_amount + Σ EMPLOYER_COST lines + Σ company-direct entries
 * ```
 *
 * `total_deductions` includes the employee's statutory contributions and excludes reimbursements.
 * A payroll-settled reimbursement repays the employee's own outlay, so it is added to net without
 * ever having been part of gross. A company-direct entry (for example, a panel-clinic invoice) is
 * instead an employer cost: the line remains on the payslip for provenance, but no cash passes
 * through the employee.
 *
 * ## The negative-net guard
 *
 * If net would fall below zero, deductions are reduced in **reverse component-type sequence** until
 * net is exactly zero, and the shortfall carries forward as an arrears entry on the next period.
 * Nothing is ever reduced below zero and nothing is ever written off.
 *
 * The plan makes reducibility a `definition.reducible` flag on the pay component. The schema
 * carries that flag only on the `SCHEDULE` arm, so it cannot be read for a deduction; the order is
 * therefore taken from the pay component policy —
 * `OTHER_DEDUCTION` first, `LOAN_REPAYMENT` next, `STATUTORY_ORDER` never, because a court order
 * cannot be shrunk by policy, and statutory contributions never, because they are not a company's
 * to reduce.
 */

import type { ContributionCharge } from './contribute.js';
import type { MeasuredLine } from './measure.js';
import { cents } from './rounding.js';

/** Types that a shortfall may never touch, in the order the guard would otherwise reach them. */
const PROTECTED_DEDUCTION_TYPES = new Set(['STATUTORY_ORDER']);

export type Settlement = {
	readonly gross: number;
	readonly totalDeductions: number;
	readonly net: number;
	readonly employerCost: number;
	/** Lines after the guard has run; identical to the input when net never went negative. */
	readonly lines: readonly MeasuredLine[];
	/** What could not be deducted this period, per pay component. Empty in the ordinary case. */
	readonly shortfalls: readonly { readonly payComponentId: string; readonly amount: number }[];
};

export function settle(options: {
	readonly lines: readonly MeasuredLine[];
	readonly charges: readonly ContributionCharge[];
}): Settlement {
	const statutoryEmployee = options.charges.reduce((total, charge) => total + charge.employee, 0);
	const statutoryEmployer = options.charges.reduce((total, charge) => total + charge.employer, 0);

	const sumOf = (lines: readonly MeasuredLine[], nature: string): number =>
		lines.reduce(
			(total, line) => total + (line.payComponent.nature === nature ? line.amount : 0),
			0
		);
	const isCompanyDirect = (line: MeasuredLine): boolean =>
		line.payComponent.definition?.source === 'ENTRY' &&
		line.payComponent.definition.settlement === 'COMPANY_DIRECT';

	const gross = cents(sumOf(options.lines, 'EARNING') - sumOf(options.lines, 'ABSENCE'));
	const payments = options.lines.reduce(
		(total, line) =>
			total +
			(line.payComponent.nature === 'NON_WAGE_PAYMENT' && !isCompanyDirect(line) ? line.amount : 0),
		0
	);
	const employerLines = options.lines.reduce(
		(total, line) =>
			total +
			(line.payComponent.nature === 'EMPLOYER_COST' || isCompanyDirect(line) ? line.amount : 0),
		0
	);

	let lines = options.lines;
	let otherDeductions = sumOf(lines, 'DEDUCTION');
	let net = cents(gross - statutoryEmployee - otherDeductions + payments);
	const shortfalls: { payComponentId: string; amount: number }[] = [];

	if (net < 0) {
		// Reverse type sequence: the least essential deduction gives way first.
		const reducible = lines
			.map((line, index) => ({ line, index }))
			.filter(
				({ line }) =>
					line.payComponent.nature === 'DEDUCTION' &&
					!PROTECTED_DEDUCTION_TYPES.has(line.payComponent.code)
			)
			.toSorted(
				(left, right) =>
					Number(right.line.payComponent.sequence) - Number(left.line.payComponent.sequence)
			);
		const reduced = [...lines];
		let outstanding = -net;
		for (const { line, index } of reducible) {
			if (outstanding <= 0) break;
			const relief = Math.min(line.amount, outstanding);
			if (relief <= 0) continue;
			reduced[index] = { ...line, amount: cents(line.amount - relief) };
			shortfalls.push({ payComponentId: line.payComponent.norbital_id, amount: cents(relief) });
			outstanding = cents(outstanding - relief);
		}
		lines = reduced;
		otherDeductions = sumOf(lines, 'DEDUCTION');
		net = cents(gross - statutoryEmployee - otherDeductions + payments);
	}

	return {
		gross,
		totalDeductions: cents(statutoryEmployee + otherDeductions),
		net,
		employerCost: cents(statutoryEmployer + employerLines),
		lines,
		shortfalls
	};
}
