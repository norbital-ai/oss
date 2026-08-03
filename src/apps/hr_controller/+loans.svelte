<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover, Inline } from '@norbital-ai/ui/layout';
	import { formatNumeric, formatRepaymentSchedule } from '../../lib/ui/display-formatters.js';
	import {
		repaymentProgress,
		type RepaymentInstalmentLink
	} from '../../collections/repayment_agreements/lib/repayment-progress.js';

	/**
	 * There is no mutable `state` or `outstanding` column. The table asks for each agreement and its
	 * direct relations in one nested query; an instalment is paid once a persisted payslip line
	 * points back to it.
	 */
	type NestedAgreement = {
		readonly principal: unknown;
		readonly schedule: unknown;
		readonly agreement_employment?: { readonly employee_number?: string | null } | null;
		readonly agreement_pay_component?: {
			readonly code?: string | null;
			readonly name?: string | null;
		} | null;
		readonly agreement_instalments?: readonly RepaymentInstalmentLink[] | null;
	};

	function nestedAgreement(row: unknown): NestedAgreement {
		return row as NestedAgreement;
	}

	function progressLabel(row: unknown): string {
		const agreement = nestedAgreement(row);
		const scheduleCount = Array.isArray(agreement.schedule) ? agreement.schedule.length : 0;
		const progress = repaymentProgress(
			agreement.principal,
			scheduleCount,
			agreement.agreement_instalments ?? []
		);
		if (!progress) return '—';
		if (progress.settled)
			return `Settled · ${progress.paidInstalments}/${progress.totalInstalments}`;
		return `${formatNumeric(progress.outstandingAmount)} · ${progress.paidInstalments}/${progress.totalInstalments} paid`;
	}

	function employmentLabel(row: unknown, fallback: unknown): unknown {
		return nestedAgreement(row).agreement_employment?.employee_number ?? fallback;
	}

	function componentLabel(row: unknown, fallback: unknown): unknown {
		const component = nestedAgreement(row).agreement_pay_component;
		return component?.code && component.name ? `${component.code} · ${component.name}` : fallback;
	}
</script>

<svelte:head>
	<title>Loans</title>
	<meta
		name="description"
		content="Review staff loans, salary advances, and overpayment recoveries with their derived outstanding balance"
	/>
	<meta name="pod:icon" content="lucide:hand-coins" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Loans"
		description="Repayment agreements deduct a principal over time. Outstanding is derived from scheduled instalments linked to payslips, never stored separately."
	/>
{/snippet}

<Cover top={pageHeading}>
	<Bound size="full" inset>
		<CollectionTable
			{client}
			collection="repayment_agreements"
			title="Repayment agreements"
			description="Outstanding falls when a scheduled entry is linked to a payslip."
			query={{
				orderBy: { disbursed_on: 'desc' },
				with: {
					agreement_employment: { columns: { employee_number: true } },
					agreement_pay_component: { columns: { code: true, name: true } },
					agreement_instalments: {
						where: { norbital_approval_id: { isNull: true } },
						columns: { amount: true, repayment_sequence: true },
						with: {
							entry_payslip_lines: { columns: { norbital_id: true } }
						}
					}
				}
			}}
			searchPlaceholder="Search agreements…"
		>
			{#snippet columns({ Column })}
				<Column name="reference" card="title" />
				<Column
					name="employment_id"
					label="Employment"
					card="subtitle"
					render={({ row, value }) => employmentLabel(row, value)}
				/>
				<Column
					name="pay_component_id"
					label="Deducted as"
					render={({ row, value }) => componentLabel(row, value)}
				/>
				<Column
					name="principal"
					label="Principal · outstanding"
					render={({ row, value }) => `${formatNumeric(value)} · ${progressLabel(row)}`}
				/>
				<Column
					name="schedule"
					label="Schedule"
					render={({ value }) => formatRepaymentSchedule(value)}
				/>
				<Column name="disbursed_on" label="Disbursed" />
				<Column name="repay_by" label="Repay by" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
			{#snippet ListCard(agreement)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{agreement.reference}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{agreement.disbursed_on}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">
					{formatRepaymentSchedule(agreement.schedule)}
				</p>
				<p class="mt-1 text-sm">
					{progressLabel(agreement)}
				</p>
			{/snippet}
		</CollectionTable>
	</Bound>
</Cover>
