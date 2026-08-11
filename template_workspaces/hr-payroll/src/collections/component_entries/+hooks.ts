import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';
import { instalmentOrigin } from '../../lib/variant.js';

type BeforeApi = Parameters<
	NonNullable<NonNullable<Hooks['create']>['before']>['handler']
>[0]['api'];

/**
 * Amounts are magnitudes. Direction comes from the pay component's policy and from the treatment,
 * and a correction is an entry whose `origin.kind` is `REVERSAL` — never a negative number.
 */
function assertMagnitude(value: unknown): void {
	if (value == null) return;
	const amount = Number(value);
	if (!Number.isFinite(amount)) {
		refuse('Amount must be a number.');
	}
	if (amount < 0) {
		refuse(
			'Amount is a magnitude and can never be negative. To take money back, record an entry whose origin is { kind: "REVERSAL", reverses_entry_id, reason }.'
		);
	}
}

async function assertInstalmentMatchesAgreement(
	api: BeforeApi,
	entry: {
		readonly employment_id: string;
		readonly pay_component_id: string;
		readonly amount: unknown;
		readonly event_date: unknown;
		readonly pay_period: string | null;
		readonly origin: unknown;
	},
	existingId?: string
): Promise<void> {
	const origin = instalmentOrigin(entry.origin);
	if (!origin) return;
	const agreement = (
		await api.db.query.repayment_agreements.findMany({
			where: { norbital_id: { eq: origin.agreement_id } },
			limit: 1
		})
	)[0];
	if (!agreement?.schedule)
		refuse('A loan instalment must reference an existing repayment agreement.');
	const scheduled = agreement.schedule[origin.sequence - 1];
	if (
		!scheduled ||
		origin.of !== agreement.schedule.length ||
		entry.employment_id !== agreement.employment_id ||
		entry.pay_component_id !== agreement.pay_component_id ||
		Number(entry.amount) !== Number(scheduled.amount) ||
		String(entry.event_date).slice(0, 10) !== scheduled.due_date ||
		entry.pay_period !== scheduled.due_date.slice(0, 7)
	)
		refuse(
			'Loan instalments are generated from their repayment agreement. Edit the agreement schedule instead.'
		);

	if (existingId == null) {
		const siblings = await api.db.query.component_entries.findMany({
			where: { employment_id: { eq: agreement.employment_id } },
			limit: 5000
		});
		if (
			siblings.some((candidate) => {
				const candidateOrigin = instalmentOrigin(candidate.origin);
				return (
					candidateOrigin?.agreement_id === agreement.norbital_id &&
					candidateOrigin.sequence === origin.sequence
				);
			})
		)
			refuse(`Repayment ${origin.sequence} already has a payroll component entry.`);
	}
}

export default {
	create: {
		before: {
			description:
				'Rejects a negative entry amount, and checks that a loan-instalment entry matches the amount, due date and pay period of the numbered instalment on its repayment agreement instead of being keyed in by hand.',
			handler: async ({ input, api }) => {
				assertMagnitude(input.amount);
				await assertInstalmentMatchesAgreement(api, {
					employment_id: input.employment_id,
					pay_component_id: input.pay_component_id,
					amount: input.amount,
					event_date: input.event_date,
					pay_period: input.pay_period ?? null,
					origin: input.origin
				});
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Keeps an edited entry amount a positive magnitude, and stops a loan instalment from being detached from its repayment agreement or edited away from the scheduled amount and due date.',
			handler: async ({ input, existing, api }) => {
				assertMagnitude(input.amount);
				const existingInstalment = instalmentOrigin(existing.origin);
				if (existingInstalment) {
					const nextOrigin = instalmentOrigin(input.origin ?? existing.origin);
					if (
						!nextOrigin ||
						nextOrigin.agreement_id !== existingInstalment.agreement_id ||
						nextOrigin.sequence !== existingInstalment.sequence
					)
						refuse(
							'Loan instalments cannot be detached from their repayment agreement. Edit the agreement schedule instead.'
						);
					await assertInstalmentMatchesAgreement(
						api,
						{
							employment_id: input.employment_id ?? existing.employment_id,
							pay_component_id: input.pay_component_id ?? existing.pay_component_id,
							amount: input.amount ?? existing.amount,
							event_date: input.event_date ?? existing.event_date,
							pay_period: input.pay_period ?? existing.pay_period,
							origin: input.origin ?? existing.origin
						},
						existing.norbital_id
					);
				}
				return input;
			}
		}
	},
	delete: {
		before: {
			description:
				'Blocks deleting a loan instalment entry while its row still exists on the repayment agreement schedule, so instalments are removed by shortening the schedule.',
			handler: async ({ existing, api }) => {
				const origin = instalmentOrigin(existing.origin);
				if (!origin) return;
				const agreement = (
					await api.db.query.repayment_agreements.findMany({
						where: { norbital_id: { eq: origin.agreement_id } },
						limit: 1
					})
				)[0];
				if (agreement?.schedule?.[origin.sequence - 1])
					refuse(
						'Loan instalments cannot be deleted directly. Remove the unpaid row from the repayment agreement schedule.'
					);
			}
		}
	}
} satisfies Hooks;
