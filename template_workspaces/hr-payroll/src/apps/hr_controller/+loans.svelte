<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover, Inline } from '@norbital-ai/ui/layout';
	import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
	import { formatNumeric, formatRepaymentSchedule } from '../../lib/ui/display-formatters.js';

	/**
	 * There is no `state` and no `outstanding` column on an agreement — settled is
	 * `SUM(instalments linked through PAID payslips) >= principal`, derived from provenance.
	 */
	const instalmentsQuery = client.db.component_entries.findMany({
		where: { norbital_approval_id: { isNull: true } },
		columns: { norbital_id: true, amount: true, origin: true },
		limit: 2000
	});
	const lineSourcesQuery = client.db.payslip_line_sources.findMany({
		columns: { payslip_line_id: true, source: true },
		limit: 5000
	});
	const linesQuery = client.db.payslip_lines.findMany({
		columns: { norbital_id: true, payslip_id: true },
		limit: 5000
	});
	const payslipsQuery = client.db.payslips.findMany({
		columns: { norbital_id: true, payroll_run_id: true },
		limit: 2000
	});
	const runsQuery = client.db.payroll_runs.findMany({
		where: { norbital_approval_id: { isNull: true } },
		columns: { norbital_id: true, lifecycle: true },
		limit: 1000
	});
	// A relation column holds a uuid. These reference sets load once per page and the label is
	// resolved from memory rather than by mounting a lookup per row; a miss falls back to the raw id
	// so an unloaded label never reads as missing data.
	const employmentsQuery = client.db.employments.findMany({
		where: { norbital_approval_id: { isNull: true } },
		columns: { norbital_id: true, employee_number: true },
		limit: 1000
	});
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);
	const payComponentsQuery = client.db.pay_components.findMany({
		where: { norbital_approval_id: { isNull: true } },
		columns: { norbital_id: true, code: true, name: true },
		limit: 500
	});
	const payComponentLabelsById = $derived(
		new Map(
			(payComponentsQuery.current ?? []).map((component) => [
				component.norbital_id,
				`${component.code} · ${component.name}`
			])
		)
	);
	const repaidByAgreement = $derived.by(() => {
		const payslipIdByLine = new Map(
			(linesQuery.current ?? []).map((line) => [line.norbital_id, line.payslip_id])
		);
		const runIdByPayslip = new Map(
			(payslipsQuery.current ?? []).map((payslip) => [payslip.norbital_id, payslip.payroll_run_id])
		);
		const paidRunIds = new Set(
			(runsQuery.current ?? [])
				.filter((run) => run.lifecycle === 'PAID')
				.map((run) => run.norbital_id)
		);
		const paidEntryIds = new Set<string>();
		for (const link of lineSourcesQuery.current ?? []) {
			const source = link.source;
			if (
				source?.kind !== 'COMPONENT_ENTRY' ||
				!paidRunIds.has(runIdByPayslip.get(payslipIdByLine.get(link.payslip_line_id) ?? '') ?? '')
			)
				continue;
			paidEntryIds.add(source.entry_id);
		}
		const totals = new Map<string, number>();
		for (const entry of instalmentsQuery.current ?? []) {
			if (!paidEntryIds.has(entry.norbital_id)) continue;
			const origin = entryOriginSchema.safeParse(entry.origin);
			if (!origin.success || origin.data.kind !== 'INSTALMENT') continue;
			const amount = Number(entry.amount);
			if (!Number.isFinite(amount)) continue;
			totals.set(origin.data.agreement_id, (totals.get(origin.data.agreement_id) ?? 0) + amount);
		}
		return totals;
	});

	function outstandingLabel(agreementId: string, principal: unknown): string {
		const total = Number(principal);
		if (!Number.isFinite(total)) return '—';
		const repaid = repaidByAgreement.get(agreementId) ?? 0;
		const outstanding = Math.max(0, total - repaid);
		return outstanding === 0 ? 'Settled' : formatNumeric(outstanding);
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
		description="Repayment agreements deduct a principal over time. The outstanding balance is a sum of settled instalments, never a stored column."
	/>
{/snippet}

<Cover top={pageHeading}>
	<Bound size="full" inset>
		<CollectionTable
			{client}
			collection="repayment_agreements"
			title="Repayment agreements"
			description="Outstanding falls only when a scheduled entry is linked through a paid payslip."
			query={{ orderBy: { disbursed_on: 'desc' } }}
			searchPlaceholder="Search agreements…"
		>
			{#snippet columns({ Column })}
				<Column name="reference" card="title" />
				<Column
					name="employment_id"
					label="Employment"
					card="subtitle"
					render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
				/>
				<Column
					name="pay_component_id"
					label="Deducted as"
					render={({ value }) => payComponentLabelsById.get(String(value)) ?? value}
				/>
				<Column
					name="principal"
					label="Principal · outstanding"
					render={({ row, value }) =>
						`${formatNumeric(value)} · ${outstandingLabel(row.norbital_id, row.principal)}`}
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
					{outstandingLabel(agreement.norbital_id, agreement.principal)} outstanding
				</p>
			{/snippet}
		</CollectionTable>
	</Bound>
</Cover>
