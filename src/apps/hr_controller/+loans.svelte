<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Bound, Cover, Inline } from '@norbital-ai/ui/layout';
	import { formatNumeric, formatRepaymentSchedule } from '../../lib/ui/display-formatters.js';
	import { todayKey } from '../../lib/ui/calendar.js';
	import {
		repaymentProgress,
		type RepaymentInstalmentLink
	} from '../../collections/repayment_agreements/lib/repayment-progress.js';

	let companyId = $state<string | null>(null);
	const today = todayKey();
	const activeRange = { effective_range: { contains_date: today } } as const;

	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true }, ...activeRange },
		orderBy: { name: 'asc' },
		limit: 500
	});
	const companies = $derived(companiesQuery.current ?? []);
	const companyOptions = $derived(
		companies.map((c) => ({
			value: c.norbital_id,
			label: c.name,
			search_term: `${c.name} ${c.registration_number ?? ''}`
		}))
	);
	const selectedCompanyId = $derived(
		companyId != null && companies.some((c) => c.norbital_id === companyId)
			? companyId
			: (companies[0]?.norbital_id ?? null)
	);

	const employmentsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.employments.findMany({
					where: {
						norbital_approval_id: { isNull: true },
						company_id: { eq: selectedCompanyId }
					},
					limit: 1000
				})
	);
	const employmentIds = $derived(
		(employmentsQuery?.current ?? []).map((employment) => employment.norbital_id)
	);

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

	function employmentLabel(row: unknown): string {
		return nestedAgreement(row).agreement_employment?.employee_number ?? '—';
	}

	function componentLabel(row: unknown): string {
		const component = nestedAgreement(row).agreement_pay_component;
		if (component?.code && component.name) return `${component.code} · ${component.name}`;
		if (component?.code) return component.code;
		return '—';
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

{#snippet companyScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground">Legal entity</span>
		<Inline gap="sm">
			<Combobox
				ariaLabel="Legal entity"
				options={companyOptions}
				value={selectedCompanyId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						companyId = value;
						return;
					}
					companyId = companies[0]?.norbital_id ?? null;
				}}
				emptyPlaceholder="Select legal entity…"
				searchPlaceholder="Search companies…"
				clientConfig={{
					isLoading: companiesQuery.loading,
					error: companiesQuery.error?.message ?? null
				}}
				class="min-w-[16rem]"
			/>
		</Inline>
	</label>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Loans"
		description="Repayment agreements deduct a principal over time — scoped to one legal entity. Outstanding is derived from scheduled instalments linked to payslips, never stored separately."
		actions={companyScopeActions}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Bound size="full" inset>
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">
				Select a legal entity to review its repayment agreements.
			</p>
		{:else}
			<CollectionTable
				{client}
				collection="repayment_agreements"
				view={`hr_controller:loans:${selectedCompanyId}`}
				title="Repayment agreements"
				description="Outstanding falls when a scheduled entry is linked to a payslip."
				query={{
					where: {
						employment_id: { in: employmentIds },
						...activeRange
					},
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
						render={({ row }) => employmentLabel(row)}
					/>
					<Column
						name="pay_component_id"
						label="Deducted as"
						render={({ row }) => componentLabel(row)}
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
		{/if}
	</Bound>
</Cover>
