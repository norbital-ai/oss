<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover } from '@norbital-ai/ui/layout';
	import { entryOriginSchema } from '../../custom-types/entry_origin/+definition.js';
	import { formatNumeric, formatRepaymentSchedule } from '../../lib/ui/display-formatters.js';

	/**
	 * There is no `state` and no `outstanding` column on an agreement — settled is
	 * `SUM(instalments) >= principal`, derived here from the instalment entries themselves.
	 */
	const instalmentsQuery = client.db.component_entries.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 2000
	});
	// A relation column holds a uuid. These reference sets load once per page and the label is
	// resolved from memory rather than by mounting a lookup per row; a miss falls back to the raw id
	// so an unloaded label never reads as missing data.
	const employmentsQuery = client.db.employments.findMany({
		where: { norbital_approval_id: { isNull: true } },
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
		const totals = new Map<string, number>();
		for (const entry of instalmentsQuery.current ?? []) {
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
	<CollectionTable
		{client}
		collection="repayment_agreements"
		title="Repayment agreements"
		description="Open an agreement to review its schedule and the instalment entries it has generated."
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
			<Column name="effective_range" label="Effective" />
		{/snippet}
		{#snippet ListCard(agreement)}
			<div class="flex items-start justify-between gap-3">
				<p class="truncate font-medium">{agreement.reference}</p>
				<span class="shrink-0 text-xs text-muted-foreground">{agreement.disbursed_on}</span>
			</div>
			<p class="mt-1 truncate text-sm text-muted-foreground">
				{formatRepaymentSchedule(agreement.schedule)}
			</p>
			<p class="mt-1 text-sm">
				{outstandingLabel(agreement.norbital_id, agreement.principal)} outstanding
			</p>
		{/snippet}
	</CollectionTable>
</Cover>
