/**
 * Step 8 — PERSIST.
 *
 * Four collections, written in dependency order: the payslip, its lines, its statutory charges, and
 * what each line consumed.
 *
 * Provenance is rows, not a column. A line is many-to-one with its sources — an overtime line is
 * computed from every time entry in the attendance window, an unpaid-leave deduction from every
 * leave request that caused it — so `payslip_line_sources` carries one row per source rather than
 * `payslip_lines` carrying one nullable id that could only ever name the first of them.
 *
 * A rebuild is safe: the run's existing payslips are deleted first and the cascade takes their
 * lines, charges and sources with them. Nothing is merged, so a rebuild cannot leave half of a
 * previous answer behind.
 */

import { assertComplete, PAGE_LIMIT, type PayrollApi } from './api.js';
import type { ContributionCharge } from './contribute.js';
import type { LineSource, MeasuredLine } from './measure.js';
import type { Settlement } from './settle.js';

export type PendingPayslip = {
	readonly employmentId: string;
	readonly currency: string;
	readonly settlement: Settlement;
	readonly charges: readonly ContributionCharge[];
};

function identifier(row: Record<string, unknown>, what: string): string {
	const id = row.norbital_id;
	if (typeof id !== 'string')
		throw new Error(`Writing ${what} returned a row without an identifier.`);
	return id;
}

/**
 * Remove a run's results so it can be rebuilt from scratch.
 *
 * The read is checked against the page ceiling because a partial clear is worse than a failed
 * one: the rebuild would write a second set of payslips alongside the half of the first set this
 * never saw, and the run would report every figure twice.
 */
export async function clearRunResults(api: PayrollApi, runId: string): Promise<void> {
	const existing = await api.db.query.payslips.findMany({
		where: { payroll_run_id: { eq: runId } },
		limit: PAGE_LIMIT
	});
	assertComplete(existing, 'payslips to clear');
	if (existing.length === 0) return;
	await api.db.delete(
		'payslips',
		existing.map((row) => row.norbital_id)
	);
}

export async function persistPayslips(options: {
	readonly api: PayrollApi;
	readonly runId: string;
	readonly pending: readonly PendingPayslip[];
}): Promise<{ payslipCount: number; lineCount: number }> {
	if (options.pending.length === 0) return { payslipCount: 0, lineCount: 0 };

	const payslipRows = await options.api.db.mutate(
		'payslips',
		options.pending.map((payslip) => ({
			payroll_run_id: options.runId,
			employment_id: payslip.employmentId,
			gross: payslip.settlement.gross,
			total_deductions: payslip.settlement.totalDeductions,
			net: payslip.settlement.net,
			employer_cost: payslip.settlement.employerCost,
			currency: payslip.currency
		}))
	);
	const payslipIdByEmployment = new Map(
		payslipRows.map((row) => [String(row.employment_id), identifier(row, 'a payslip')])
	);
	if (payslipIdByEmployment.size !== options.pending.length)
		throw new Error('Not every calculated employment produced a payslip.');

	// Lines are written in one batch and matched back by (payslip, sequence), which is unique by
	// construction — the measurement numbers them from one within each payslip.
	const lineInputs: { payslipId: string; line: MeasuredLine }[] = [];
	for (const payslip of options.pending) {
		const payslipId = payslipIdByEmployment.get(payslip.employmentId);
		if (payslipId == null)
			throw new Error('A calculated employment has no payslip to hang lines on.');
		for (const line of payslip.settlement.lines) lineInputs.push({ payslipId, line });
	}

	if (lineInputs.length > 0) {
		const lineRows = await options.api.db.mutate(
			'payslip_lines',
			lineInputs.map(({ payslipId, line }) => ({
				payslip_id: payslipId,
				pay_component_id: line.payComponent.norbital_id,
				component_type_id: line.componentType.norbital_id,
				amount: line.amount,
				quantity: line.quantity,
				rate: line.rate,
				sequence: line.sequence
			}))
		);
		const lineIdByKey = new Map(
			lineRows.map((row) => [
				`${String(row.payslip_id)}:${String(row.sequence)}`,
				identifier(row, 'a payslip line')
			])
		);
		const sourceInputs: { payslip_line_id: string; source: LineSource }[] = [];
		for (const { payslipId, line } of lineInputs) {
			const lineId = lineIdByKey.get(`${payslipId}:${line.sequence}`);
			if (lineId == null)
				throw new Error(
					`Payslip line ${line.payComponent.code} was written without an identifier.`
				);
			for (const source of line.sources) sourceInputs.push({ payslip_line_id: lineId, source });
		}
		if (sourceInputs.length > 0) await options.api.db.mutate('payslip_line_sources', sourceInputs);
	}

	const chargeInputs = options.pending.flatMap((payslip) => {
		const payslipId = payslipIdByEmployment.get(payslip.employmentId);
		if (payslipId == null) return [];
		return payslip.charges.map((charge) => ({
			payslip_id: payslipId,
			statutory_contribution_id: charge.contribution.row.norbital_id,
			base_amount: charge.base,
			employee_amount: charge.employee,
			employer_amount: charge.employer,
			band_reference: charge.bandReference,
			special_amounts: charge.special
		}));
	});
	if (chargeInputs.length > 0) await options.api.db.mutate('payslip_contributions', chargeInputs);

	return { payslipCount: options.pending.length, lineCount: lineInputs.length };
}

/**
 * Carry a shortfall into the next period.
 *
 * An arrears entry is written for what the negative-net guard could not deduct. It is keyed by the
 * period it covers, and any arrears already written for that same period on the same component is
 * removed first, so rebuilding a run cannot make an employee owe the same money twice.
 */
export async function persistShortfalls(options: {
	readonly api: PayrollApi;
	readonly period: string;
	readonly nextPeriod: string;
	readonly payDate: string;
	readonly shortfalls: readonly {
		readonly employmentId: string;
		readonly payComponentId: string;
		readonly amount: number;
	}[];
}): Promise<void> {
	if (options.shortfalls.length === 0) return;
	const employmentIds = [...new Set(options.shortfalls.map((row) => row.employmentId))];
	const existing = await options.api.db.query.component_entries.findMany({
		where: { employment_id: { in: employmentIds } },
		limit: PAGE_LIMIT
	});
	// A truncated read here would leave last build's arrears standing beside this build's, and the
	// employee would owe the same money twice.
	assertComplete(existing, 'component entries to re-arrear');
	const stale = existing.filter(
		(entry) =>
			entry.origin?.kind === 'ARREARS' &&
			entry.origin.covers_periods.length === 1 &&
			entry.origin.covers_periods[0] === options.period
	);
	if (stale.length > 0)
		await options.api.db.delete(
			'component_entries',
			stale.map((row) => row.norbital_id)
		);
	await options.api.db.mutate(
		'component_entries',
		options.shortfalls.map((shortfall) => ({
			employment_id: shortfall.employmentId,
			pay_component_id: shortfall.payComponentId,
			amount: shortfall.amount,
			quantity: null,
			event_date: options.payDate,
			pay_period: options.nextPeriod,
			origin: {
				kind: 'ARREARS' as const,
				covers_periods: [options.period],
				reason: `Net pay for ${options.period} reached zero before this deduction could be taken.`
			}
		}))
	);
}

/** A skipped joining period, and what this run is paying for it. */
export type PendingDeferral = {
	readonly employmentId: string;
	readonly employeeNumber: string;
	readonly hireDate: Date | string | null;
	readonly coversPeriod: string;
	readonly paidInPeriod: string;
	readonly payComponentId: string;
	readonly amount: number;
};

/**
 * Record a skipped joining period in the employee's own entry stream.
 *
 * The money is already on the payslip — MEASURE derived it, and it went through the grid and the
 * statutory schemes with everything else on this run. This writes the **arrears entry** that says
 * so, on the component the company nominated, keyed by the period it covers.
 *
 * That entry is a record, not an input: the run re-derives the figure from the contract every time,
 * so the entry cannot go stale and cannot be double-counted if a build is repeated. It exists
 * because a wage that appears on one payslip with no trace of where it came from is the kind of
 * number a payroll clerk cannot answer a question about — the entry stream is where "why is there
 * an extra 857.14 on this payslip?" is answerable, and `origin.reason` answers it in words.
 *
 * Delete-first for the same reason `persistShortfalls` does it: rebuilding a month must leave one
 * record of that month's arrears, not two.
 */
export async function persistDeferrals(options: {
	readonly api: PayrollApi;
	readonly deferrals: readonly PendingDeferral[];
}): Promise<void> {
	if (options.deferrals.length === 0) return;
	const employmentIds = [...new Set(options.deferrals.map((row) => row.employmentId))];
	const existing = await options.api.db.query.component_entries.findMany({
		where: { employment_id: { in: employmentIds } },
		limit: PAGE_LIMIT
	});
	assertComplete(existing, 'component entries to re-defer');
	const owned = new Set(
		options.deferrals.map((row) => `${row.employmentId}:${row.payComponentId}:${row.coversPeriod}`)
	);
	const stale = existing.filter(
		(entry) =>
			entry.origin?.kind === 'ARREARS' &&
			entry.origin.covers_periods.length === 1 &&
			owned.has(
				`${entry.employment_id}:${entry.pay_component_id}:${entry.origin.covers_periods[0]}`
			)
	);
	if (stale.length > 0)
		await options.api.db.delete(
			'component_entries',
			stale.map((row) => row.norbital_id)
		);
	await options.api.db.mutate(
		'component_entries',
		options.deferrals.map((row) => {
			const joined = row.hireDate == null ? row.coversPeriod : String(row.hireDate).slice(0, 10);
			return {
				employment_id: row.employmentId,
				pay_component_id: row.payComponentId,
				amount: row.amount,
				quantity: null,
				event_date: joined,
				pay_period: row.paidInPeriod,
				origin: {
					kind: 'ARREARS' as const,
					covers_periods: [row.coversPeriod],
					reason:
						`${row.employeeNumber} joined on ${joined}, after the ${row.coversPeriod} attendance ` +
						`window had closed, so ${row.coversPeriod} was not processed. Those days are paid ` +
						`with ${row.paidInPeriod}.`
				}
			};
		})
	);
}
