/**
 * What a repayment schedule row can honestly say about itself.
 *
 * Consumption is not a flag. An instalment is recovered when payroll persisted a payslip line to
 * the component entry the agreement materialised for it — so the only thing this file can observe
 * directly is "a line exists" or "no line exists".
 *
 * "No line exists" was previously rendered as a bare **"Not consumed"**, which is four different
 * situations wearing one label:
 *
 * | situation                                    | what an operator should do            |
 * | -------------------------------------------- | ------------------------------------- |
 * | the due period is still in the future         | nothing                               |
 * | the due period has no payroll run yet         | nothing — the run will take it        |
 * | the due period's run is still a draft         | recalculate that draft                |
 * | the due period's run is **paid**              | act: that money was never recovered   |
 *
 * The last one is the only defect, and it is unrecoverable by the run itself: a paid run is
 * immutable (`payroll_runs/+hooks.ts` refuses to rebuild one), so an instalment that was not
 * present when its period was built can never be picked up by that period again. Presenting it
 * identically to the three benign cases is what makes a closed period indistinguishable from a
 * broken engine.
 */

export interface RepaymentConsumptionReference {
	readonly payslipLineId: string;
	readonly payslipId: string;
	readonly payrollRunId: string;
	readonly payslipLineSequence: number;
	readonly payrollPeriod: string;
	readonly cycleDate: string;
	readonly consumedAt: string;
	/**
	 * What payroll actually deducted, when the line records it. Lower than the scheduled amount when
	 * the negative-net guard reduced the deduction; the remainder is carried forward as an arrears
	 * entry by `payroll_runs/lib/persist.ts`, so the instalment is still settled — but the schedule
	 * should say the run only took part of it rather than implying the full figure left the payslip.
	 */
	readonly recoveredAmount: number | null;
}

export type RepaymentConsumptionCell =
	| { readonly status: 'loading' }
	| { readonly status: 'error'; readonly message: string }
	| { readonly status: 'consumed'; readonly reference: RepaymentConsumptionReference }
	/** The due period is in the future and no run has reached it. */
	| { readonly status: 'not_due'; readonly period: string }
	/** The due period is here or past, but no payroll run exists for it yet. */
	| { readonly status: 'awaiting_run'; readonly period: string }
	/** A run exists for the due period and is still a draft — recalculating it takes the instalment. */
	| { readonly status: 'awaiting_rebuild'; readonly period: string }
	/** The due period's run is paid and did not deduct this instalment. Nothing will now. */
	| { readonly status: 'unrecovered'; readonly period: string };

export interface RepaymentScheduleMatrixRow {
	id: string;
	due_date: string;
	amount: number;
	consumed_by: RepaymentConsumptionCell;
	consumed_at: string | null;
}

export interface RepaymentConsumptionSourceRow {
	readonly repayment_sequence?: number | null;
	readonly entry_payslip_lines?:
		| readonly {
				readonly norbital_created_at?: string | null;
				readonly norbital_id?: string | null;
				readonly sequence?: number | null;
				readonly amount?: unknown;
				readonly payslip_line_payslip?: {
					readonly norbital_id?: string | null;
					readonly payslip_payroll_run?: {
						readonly norbital_id?: string | null;
						readonly period?: string | null;
						readonly pay_date?: string | null;
					} | null;
				} | null;
		  }[]
		| null;
}

/** A payroll run as this screen needs to read it: which period, and how settled it is. */
export interface RepaymentPeriodRunRow {
	readonly period?: string | null;
	readonly lifecycle?: string | null;
}

function nonEmpty(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function numeric(value: unknown): number | null {
	if (value == null || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The run an instalment settles in.
 *
 * `repayment_agreements/+hooks.ts` materialises every instalment with
 * `pay_period: instalment.due_date.slice(0, 7)`, and MEASURE selects an entry by an exact
 * `pay_period === run.period` match. So the due date names the run outright — the company's cutoff
 * day never enters into it, and this must keep deriving the period the same way the hook writes it.
 */
export function instalmentPayPeriod(dueDate: string): string {
	return String(dueDate).slice(0, 7);
}

/** `period` → `lifecycle`, for the company that owns the agreement's employment. */
export function repaymentRunLifecycleByPeriod(
	runs: readonly RepaymentPeriodRunRow[]
): ReadonlyMap<string, string | null> {
	const byPeriod = new Map<string, string | null>();
	for (const run of runs) {
		const period = nonEmpty(run.period);
		if (period == null) continue;
		byPeriod.set(period, nonEmpty(run.lifecycle));
	}
	return byPeriod;
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
		for (const source of row.entry_payslip_lines ?? []) {
			const line = source;
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
				consumedAt,
				recoveredAmount: numeric(line.amount)
			});
			break;
		}
	}
	return references;
}

/**
 * Why a schedule row is where it is.
 *
 * Deliberately ordered: an existing payslip line is the strongest evidence there is and wins over
 * everything, and beyond that the run's own lifecycle outranks the calendar — a paid period is a
 * closed period whether or not the due date has passed.
 */
export function resolveRepaymentConsumption(options: {
	readonly dueDate: string;
	readonly reference: RepaymentConsumptionReference | undefined;
	readonly runLifecycleByPeriod: ReadonlyMap<string, string | null>;
	/** `YYYY-MM-DD`. */
	readonly today: string;
}): RepaymentConsumptionCell {
	if (options.reference != null) return { status: 'consumed', reference: options.reference };
	const period = instalmentPayPeriod(options.dueDate);
	const lifecycle = options.runLifecycleByPeriod.get(period);
	if (lifecycle === 'PAID') return { status: 'unrecovered', period };
	if (lifecycle != null) return { status: 'awaiting_rebuild', period };
	if (String(options.dueDate).slice(0, 10) > options.today) return { status: 'not_due', period };
	return { status: 'awaiting_run', period };
}

/** What the run recovered, against what the schedule asked for. */
export function repaymentShortfall(
	scheduledAmount: number,
	reference: RepaymentConsumptionReference
): number | null {
	const recovered = reference.recoveredAmount;
	if (recovered == null) return null;
	const short = Math.round((Number(scheduledAmount) - recovered) * 100) / 100;
	return short > 0 ? short : null;
}

export function formatPayrollCycleDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	return match ? `${match[3]}-${match[2]}-${match[1].slice(-2)}` : value;
}
