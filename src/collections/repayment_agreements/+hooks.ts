import type { Hooks, WorkspaceRow } from './$types.js';
import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
import { payslipLineSourceSchema } from '../../custom-types/payslip_line_source/+definition.js';
import { assertRepaymentSchedule } from './lib/repayment-schedule.js';

const LIMIT = 5000;
type AfterApi = Parameters<NonNullable<NonNullable<Hooks['create']>['after']>>[0]['api'];
type ReadApi = Parameters<NonNullable<NonNullable<Hooks['create']>['before']>>[0]['api'];

function checked<T>(rows: T[], what: string): T[] {
	if (rows.length >= LIMIT)
		throw new Error(
			`${what} reached the ${LIMIT}-row safety limit; the operation was not applied.`
		);
	return rows;
}

function instalmentOrigin(value: unknown) {
	const parsed = entryOriginSchema.safeParse(value);
	return parsed.success && parsed.data.kind === 'INSTALMENT' ? parsed.data : null;
}

async function agreementEntries(
	api: ReadApi | AfterApi,
	agreement: Pick<WorkspaceRow<'repayment_agreements'>, 'norbital_id' | 'employment_id'>
) {
	const rows = checked(
		await api.db.query.component_entries.findMany({
			where: { employment_id: { eq: agreement.employment_id } },
			limit: LIMIT
		}),
		'Component entries'
	);
	return rows.filter((row) => instalmentOrigin(row.origin)?.agreement_id === agreement.norbital_id);
}

/**
 * "Consumed" is not a flag. It is the persisted path
 * component entry → payslip line source → payslip line → payslip → PAID payroll run.
 */
async function paidLinkedEntryIds(
	api: ReadApi,
	agreement: WorkspaceRow<'repayment_agreements'>,
	entries: Awaited<ReturnType<typeof agreementEntries>>
): Promise<Set<string>> {
	if (entries.length === 0) return new Set();
	const employment = (
		await api.db.query.employments.findMany({
			where: { norbital_id: { eq: agreement.employment_id } },
			limit: 1
		})
	)[0];
	if (!employment) throw new Error('The repayment agreement has no employment.');
	const periods = [
		...new Set(entries.flatMap((entry) => (entry.pay_period ? [entry.pay_period] : [])))
	];
	if (periods.length === 0) return new Set();
	const paidRuns = checked(
		await api.db.query.payroll_runs.findMany({
			where: {
				company_id: { eq: employment.company_id },
				period: { in: periods },
				lifecycle: { eq: 'PAID' }
			},
			limit: LIMIT
		}),
		'Paid payroll runs'
	);
	if (paidRuns.length === 0) return new Set();
	const payslips = checked(
		await api.db.query.payslips.findMany({
			where: {
				payroll_run_id: { in: paidRuns.map((run) => run.norbital_id) },
				employment_id: { eq: agreement.employment_id }
			},
			limit: LIMIT
		}),
		'Loan payslips'
	);
	if (payslips.length === 0) return new Set();
	const lines = checked(
		await api.db.query.payslip_lines.findMany({
			where: { payslip_id: { in: payslips.map((payslip) => payslip.norbital_id) } },
			limit: LIMIT
		}),
		'Loan payslip lines'
	);
	if (lines.length === 0) return new Set();
	const sources = checked(
		await api.db.query.payslip_line_sources.findMany({
			where: { payslip_line_id: { in: lines.map((line) => line.norbital_id) } },
			limit: LIMIT
		}),
		'Loan payslip sources'
	);
	const agreementEntryIds = new Set(entries.map((entry) => entry.norbital_id));
	const linked = new Set<string>();
	for (const row of sources) {
		const parsed = payslipLineSourceSchema.safeParse(row.source);
		if (
			parsed.success &&
			parsed.data.kind === 'COMPONENT_ENTRY' &&
			agreementEntryIds.has(parsed.data.entry_id)
		)
			linked.add(parsed.data.entry_id);
	}
	return linked;
}

async function protectPaidInstalments(
	api: ReadApi,
	existing: WorkspaceRow<'repayment_agreements'>,
	next: {
		readonly employment_id: string;
		readonly pay_component_id: string;
		readonly schedule: WorkspaceRow<'repayment_agreements'>['schedule'];
	}
): Promise<void> {
	const entries = await agreementEntries(api, existing);
	const paid = await paidLinkedEntryIds(api, existing, entries);
	if (paid.size === 0) return;
	if (
		next.employment_id !== existing.employment_id ||
		next.pay_component_id !== existing.pay_component_id
	)
		throw new Error(
			'A repayment agreement with paid instalments cannot change employment or component.'
		);
	for (const entry of entries) {
		if (!paid.has(entry.norbital_id)) continue;
		const origin = instalmentOrigin(entry.origin);
		if (!origin) continue;
		const candidate = next.schedule?.[origin.sequence - 1];
		if (
			!candidate ||
			Number(candidate.amount) !== Number(entry.amount) ||
			candidate.due_date !== String(entry.event_date).slice(0, 10)
		)
			throw new Error(
				`Repayment ${origin.sequence} is linked to a paid payslip and cannot be changed or removed.`
			);
	}
}

/** Synchronise the N payroll inputs from the agreement-owned schedule. */
async function synchronizeInstalments(
	api: AfterApi,
	agreement: WorkspaceRow<'repayment_agreements'>
): Promise<void> {
	if (!agreement.schedule) throw new Error('A repayment schedule is required.');
	const existing = await agreementEntries(api, agreement);
	const bySequence = new Map<number, (typeof existing)[number]>();
	for (const entry of existing) {
		const origin = instalmentOrigin(entry.origin);
		if (!origin) continue;
		if (bySequence.has(origin.sequence))
			throw new Error(`Repayment ${origin.sequence} has more than one component entry.`);
		bySequence.set(origin.sequence, entry);
	}
	const count = agreement.schedule.length;
	const inputs = agreement.schedule.map((instalment, index) => {
		const sequence = index + 1;
		const existingEntry = bySequence.get(sequence);
		return {
			...(existingEntry ? { norbital_id: existingEntry.norbital_id } : {}),
			employment_id: agreement.employment_id,
			pay_component_id: agreement.pay_component_id,
			amount: instalment.amount,
			quantity: 1,
			event_date: instalment.due_date,
			pay_period: instalment.due_date.slice(0, 7),
			description: `${agreement.reference} · repayment ${sequence}/${count}`,
			origin: {
				kind: 'INSTALMENT' as const,
				agreement_id: agreement.norbital_id,
				sequence,
				of: count
			}
		};
	});
	if (inputs.length > 0) await api.db.mutate('component_entries', inputs);
	const stale = existing.filter((entry) => {
		const sequence = instalmentOrigin(entry.origin)?.sequence;
		return sequence == null || sequence > count;
	});
	if (stale.length > 0)
		await api.db.delete(
			'component_entries',
			stale.map((entry) => entry.norbital_id)
		);
}

export default {
	create: {
		before: async ({ input }) => {
			assertRepaymentSchedule({
				principal: input.principal,
				repayBy: input.repay_by,
				schedule: input.schedule
			});
			return input;
		},
		after: async ({ record, api }) => synchronizeInstalments(api, record)
	},
	update: {
		before: async ({ input, existing, api }) => {
			const principal = input.principal ?? existing.principal;
			const repayBy = input.repay_by ?? existing.repay_by;
			const schedule = input.schedule ?? existing.schedule;
			assertRepaymentSchedule({ principal, repayBy, schedule });
			await protectPaidInstalments(api, existing, {
				employment_id: input.employment_id ?? existing.employment_id,
				pay_component_id: input.pay_component_id ?? existing.pay_component_id,
				schedule
			});
			return input;
		},
		after: async ({ record, api }) => synchronizeInstalments(api, record)
	},
	delete: {
		before: async () => {
			throw new Error(
				'Repayment agreements are auditable records and cannot be deleted. Correct the unpaid schedule instead.'
			);
		}
	}
} satisfies Hooks;
