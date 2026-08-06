<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import {
		formatCalendarDate,
		formatEntryOrigin,
		formatNumeric
	} from '../../lib/ui/display-formatters.js';
	import { inForceTodayFilter, todayKey, todayInstant } from '../../lib/ui/calendar.js';

	const { t } = useI18n<TenantI18nKeys>();

	let companyId = $state<string | null>(null);
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	/**
	 * The catalogue opens on the components in force today, as a filter chip the operator can drop to
	 * reach superseded versions. The legal-entity selector keeps `activeRange` in its own query: it is
	 * the page's scope picker, not a listing, and it has to default to an entity that still exists.
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

	// A relation column holds a uuid. These reference sets load once per page and the label is
	// resolved from memory rather than by mounting a lookup per row; a miss renders as an em dash.
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
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery?.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);
	// Deliberately unfiltered by effective range: this is the label map for the entries table's
	// component column, and an entry booked last year against a since-superseded component must
	// still resolve to its name rather than an em dash.
	const payComponentsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.pay_components.findMany({
					where: {
						norbital_approval_id: { isNull: true },
						company_id: { eq: selectedCompanyId }
					},
					limit: 500
				})
	);
	const payComponentLabelsById = $derived(
		new Map(
			(payComponentsQuery?.current ?? []).map((component) => [
				component.norbital_id,
				`${component.code} · ${component.name}`
			])
		)
	);
	const analyticsQuery = client.invoke.approval_analytics({ subject: 'CLAIM' });
	const analytics = $derived(
		analyticsQuery.current ?? {
			as_of_date: todayKey(),
			total: 0,
			summary: {
				ytd_pending: 0,
				ytd_approved: 0,
				average_approval_hours: null,
				approval_sample_size: 0
			},
			annual_trend: []
		}
	);
	const claimTrendChart = $derived({
		kind: 'line',
		loading: analyticsQuery.loading,
		title: t('app.pay_components.chart_title'),
		description: t('app.pay_components.chart_description'),
		data: analytics.annual_trend,
		xKey: 'year',
		series: ['applications', 'regression'],
		config: {
			applications: { label: t('component.chart_applications'), color: 'var(--color-primary)' },
			regression: { label: t('component.chart_regression'), color: 'var(--color-muted-foreground)' }
		},
		valueFormat: { style: 'number', maximumFractionDigits: 1 },
		curve: 'linear'
	} satisfies ChartDisplaySpec);
</script>

<svelte:head>
	<title>Pay components</title>
	<meta
		name="description"
		content="Review pay-component entries — allowances, claims, arrears, reversals, and loan instalments — and their payroll linkage"
	/>
	<meta name="pod:icon" content="lucide:coins" />
</svelte:head>

{#snippet companyScopeActions()}
	<Inline gap="md" align="end">
		<label class="grid gap-1.5 text-sm">
			<span class="font-medium text-muted-foreground">{t('component.legal_entity')}</span>
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
		</label>
	</Inline>
{/snippet}

{#snippet overview()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.pay_components.empty_overview')}</p>
	{:else}
		<Grid gap="xl" minimum="panel">
			<Stack gap="md">
				<div>
					<h2 class="text-lg font-semibold">{t('app.pay_components.reimbursement_claims')}</h2>
					<p class="text-sm text-muted-foreground">
						{t('app.pay_components.reimbursement_claims_description', {
							count: analytics.total.toLocaleString()
						})}
					</p>
				</div>
				<ApprovalSummaryTable
					title={t('app.pay_components.claim_decisions')}
					asOfDate={analytics.as_of_date}
					summary={analytics.summary}
					note={t('app.pay_components.claim_decisions_note')}
				/>
			</Stack>
			<div class="min-w-0 rounded-lg border bg-card p-4 shadow-card">
				<Display spec={claimTrendChart} class="min-h-[18rem]" />
			</div>
		</Grid>
	{/if}
{/snippet}

{#snippet entries()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			{t('app.pay_components.empty_entries')}
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="component_entries"
			view={`hr_controller:pay_components:entries:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { event_date: 'desc' }
			}}
			searchPlaceholder={t('app.pay_components.search_entries')}
		>
			{#snippet columns({ Column })}
				<Column
					name="pay_component_id"
					label={t('component.component')}
					card="title"
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (payComponentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="employment_id"
					label={t('component.employment')}
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="amount"
					label={t('component.amount')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column name="quantity" label={t('component.quantity')} />
				<Column
					name="event_date"
					label={t('component.date')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column name="pay_period" label={t('component.pay_period')} />
				<Column name="usage_mode" label={t('app.pay_components.payslip_usage')} card="badge" />
				<Column name="description" />
				<Column
					name="origin"
					label={t('component.origin')}
					card="subtitle"
					render={({ value }) => formatEntryOrigin(value)}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet catalogue()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			{t('app.pay_components.empty_catalogue')}
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="pay_components"
			view={`hr_controller:pay_components:catalogue:${selectedCompanyId}`}
			initialFilters={inForceTodayFilter()}
			query={{
				where: {
					company_id: { eq: selectedCompanyId }
				},
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder={t('app.pay_components.search_catalogue')}
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="nature" card="badge" />
				<Column name="policy" label={t('app.pay_components.settlement_policy')} />
				<Column name="definition" label={t('app.pay_components.calculation')} />
				<Column name="sequence" label={t('app.pay_components.order')} />
				<Column name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.pay_components.eyebrow')}
		title={t('app.pay_components.header_title')}
		description={t('app.pay_components.header_description')}
		actions={companyScopeActions}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'overview',
				label: t('component.tab_overview'),
				icon: 'lucide:chart-no-axes-combined',
				content: overview
			},
			{
				name: 'entries',
				label: t('app.pay_components.tab_entries'),
				icon: 'lucide:receipt-text',
				content: entries
			},
			{
				name: 'catalogue',
				label: t('app.pay_components.tab_catalogue'),
				icon: 'lucide:list-tree',
				content: catalogue
			}
		] satisfies TabConfig[]}
	/>
</Cover>
