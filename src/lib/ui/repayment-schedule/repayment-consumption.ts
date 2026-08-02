export interface RepaymentConsumptionReference {
	readonly payslipLineId: string;
	readonly payslipId: string;
	readonly payrollRunId: string;
	readonly payslipLineSequence: number;
	readonly payrollPeriod: string;
	readonly cycleDate: string;
	readonly consumedAt: string;
}

export type RepaymentConsumptionCell =
	| { readonly status: 'available' }
	| { readonly status: 'loading' }
	| { readonly status: 'error'; readonly message: string }
	| { readonly status: 'consumed'; readonly reference: RepaymentConsumptionReference };

export interface RepaymentScheduleMatrixRow {
	id: string;
	due_date: string;
	amount: number;
	consumed_by: RepaymentConsumptionCell;
	consumed_at: string | null;
}

export interface RepaymentConsumptionSourceRow {
	readonly repayment_sequence?: number | null;
	readonly entry_payslip_sources?:
		| readonly {
				readonly norbital_created_at?: string | null;
				readonly payslip_line_source_line?: {
					readonly norbital_id?: string | null;
					readonly sequence?: number | null;
					readonly payslip_line_payslip?: {
						readonly norbital_id?: string | null;
						readonly payslip_payroll_run?: {
							readonly norbital_id?: string | null;
							readonly period?: string | null;
							readonly pay_date?: string | null;
						} | null;
					} | null;
				} | null;
		  }[]
		| null;
}

function nonEmpty(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Index the single nested provenance query by the canonical schedule sequence.
 *
 * A schedule row is consumed only when its component entry has a source that reaches an exact
 * payslip line, payslip and payroll run. Partial links are not presented as a completed recovery.
 */
export function repaymentConsumptionBySequence(
	rows: readonly RepaymentConsumptionSourceRow[]
): ReadonlyMap<number, RepaymentConsumptionReference> {
	const references = new Map<number, RepaymentConsumptionReference>();
	for (const row of rows) {
		const sequence = row.repayment_sequence;
		if (typeof sequence !== 'number' || references.has(sequence)) continue;
		for (const source of row.entry_payslip_sources ?? []) {
			const line = source.payslip_line_source_line;
			const payslip = line?.payslip_line_payslip;
			const run = payslip?.payslip_payroll_run;
			const payslipLineId = nonEmpty(line?.norbital_id);
			const payslipId = nonEmpty(payslip?.norbital_id);
			const payrollRunId = nonEmpty(run?.norbital_id);
			const payrollPeriod = nonEmpty(run?.period);
			const cycleDate = nonEmpty(run?.pay_date);
			const consumedAt = nonEmpty(source.norbital_created_at);
			if (
				payslipLineId == null ||
				payslipId == null ||
				payrollRunId == null ||
				payrollPeriod == null ||
				cycleDate == null ||
				consumedAt == null ||
				typeof line?.sequence !== 'number'
			) {
				continue;
			}
			references.set(sequence, {
				payslipLineId,
				payslipId,
				payrollRunId,
				payslipLineSequence: line.sequence,
				payrollPeriod,
				cycleDate,
				consumedAt
			});
			break;
		}
	}
	return references;
}

export function formatPayrollCycleDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	return match ? `${match[3]}-${match[2]}-${match[1].slice(-2)}` : value;
}
