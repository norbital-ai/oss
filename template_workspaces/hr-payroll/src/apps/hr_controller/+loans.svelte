<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import AppHeaderActions from '@norbital-ai/pod/client/app-header-actions';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Bound, Cover, Inline } from '@norbital-ai/ui/layout';
	import {
		formatCalendarDate,
		formatNumeric,
		formatRepaymentSchedule
	} from '../../lib/ui/display-formatters.js';
	import { inForceTodayFilter, todayInstant } from '../../lib/ui/calendar.js';
	import {
		repaymentProgress,
		type RepaymentInstalmentLink
	} from '../../collections/repayment_agreements/lib/repayment-progress.js';

	const { t } = useI18n<TenantI18nKeys>();

	let companyId = $state<string | null>(null);
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	/**
	 * The ledger opens on the agreements still running today, as a filter chip the operator can drop
	 * to see settled and future ones. The legal-entity selector keeps `activeRange` in its own query
	 * regardless: that is the page's scope picker, not a listing, and it has to default to an entity
	 * that still exists.
	 */
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
			return t('app.loans.progress_settled', {
				paid: progress.paidInstalments,
				total: progress.totalInstalments
			});
		return t('app.loans.progress_partial', {
			outstanding: formatNumeric(progress.outstandingAmount),
			paid: progress.paidInstalments,
			total: progress.totalInstalments
		});
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
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/hr-payroll/app-media/loans-banner.webp"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/app-media/loans-banner.webp"
	/>
</svelte:head>

{#snippet companyScopeActions()}
	<Combobox
		ariaLabel={t('component.legal_entity')}
		options={companyOptions}
		value={selectedCompanyId}
		onValueChange={(value) => {
			if (typeof value === 'string') {
				companyId = value;
				return;
			}
			companyId = companies[0]?.norbital_id ?? null;
		}}
		emptyPlaceholder={t('component.select_legal_entity')}
		searchPlaceholder={t('component.search_companies')}
		clientConfig={{
			isLoading: companiesQuery.loading,
			error: companiesQuery.error?.message ?? null
		}}
		class="min-w-[16rem]"
	/>
{/snippet}

<AppHeaderActions>
	{@render companyScopeActions()}
</AppHeaderActions>

<Cover>
	<Bound size="full" inset>
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">
				{t('app.loans.empty')}
			</p>
		{:else}
			<CollectionTable
				{client}
				collection="repayment_agreements"
				view={`hr_controller:loans:${selectedCompanyId}`}
				title={t('app.loans.repayment_agreements')}
				description={t('app.loans.repayment_agreements_description')}
				initialFilters={inForceTodayFilter()}
				query={{
					where: {
						employment_id: { in: employmentIds }
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
				searchPlaceholder={t('app.loans.search_agreements')}
			>
				{#snippet columns({ Column })}
					<Column name="reference" card="title" />
					<Column
						name="employment_id"
						label={t('component.employment')}
						card="subtitle"
						render={({ row }) => employmentLabel(row)}
					/>
					<Column
						name="pay_component_id"
						label={t('app.loans.deducted_as')}
						render={({ row }) => componentLabel(row)}
					/>
					<Column
						name="principal"
						label={t('app.loans.principal_outstanding')}
						render={({ row, value }) => `${formatNumeric(value)} · ${progressLabel(row)}`}
					/>
					<Column
						name="schedule"
						label={t('component.schedule')}
						render={({ value }) => formatRepaymentSchedule(value, t)}
					/>
					<Column
						name="disbursed_on"
						label={t('component.disbursed')}
						render={({ value }) => formatCalendarDate(value)}
					/>
					<Column
						name="repay_by"
						label={t('app.loans.repay_by')}
						render={({ value }) => formatCalendarDate(value)}
					/>
					<Column name="effective_range" label={t('component.effective')} />
				{/snippet}
				{#snippet ListCard(agreement)}
					<Inline align="start" justify="between" gap="sm">
						<p class="truncate font-medium">{agreement.reference}</p>
						<span class="shrink-0 text-xs text-muted-foreground">
							{formatCalendarDate(agreement.disbursed_on)}
						</span>
					</Inline>
					<p class="mt-1 truncate text-sm text-muted-foreground">
						{formatRepaymentSchedule(agreement.schedule, t)}
					</p>
					<p class="mt-1 text-sm">
						{progressLabel(agreement)}
					</p>
				{/snippet}
			</CollectionTable>
		{/if}
	</Bound>
</Cover>
