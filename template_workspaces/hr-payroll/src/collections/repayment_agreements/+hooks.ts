import type { Hooks, WorkspaceRow } from './$types.js';
import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
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
	agreement: Pick<WorkspaceRow<'repayment_agreements'>, 'norbital_id'>
) {
	return checked(
		await api.db.query.component_entries.findMany({
			where: { repayment_agreement_id: { eq: agreement.norbital_id } },
			with: { entry_payslip_sources: { columns: { norbital_id: true } } },
			limit: LIMIT
		}),
		'Component entries'
	) as (WorkspaceRow<'component_entries'> & {
		readonly entry_payslip_sources?: readonly unknown[] | null;
	})[];
}

/** "Consumed" is not a flag: it is the existence of the nested persisted source relation. */
function linkedEntryIds(entries: Awaited<ReturnType<typeof agreementEntries>>): Set<string> {
	return new Set(
		entries
			.filter((entry) => Boolean(entry.entry_payslip_sources?.length))
			.map((entry) => entry.norbital_id)
	);
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
	const linked = linkedEntryIds(entries);
	if (linked.size === 0) return;
	if (
		next.employment_id !== existing.employment_id ||
		next.pay_component_id !== existing.pay_component_id
	)
		throw new Error(
			'A repayment agreement with payslip-linked instalments cannot change employment or component.'
		);
	for (const entry of entries) {
		if (!linked.has(entry.norbital_id)) continue;
		const origin = instalmentOrigin(entry.origin);
		if (!origin) continue;
		const candidate = next.schedule?.[origin.sequence - 1];
		if (
			!candidate ||
			Number(candidate.amount) !== Number(entry.amount) ||
			candidate.due_date !== String(entry.event_date).slice(0, 10)
		)
			throw new Error(
				`Repayment ${origin.sequence} is linked to a payslip and cannot be changed or removed.`
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
