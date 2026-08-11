<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import AppHeaderActions from '@norbital-ai/pod/client/app-header-actions';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import {
		formatCalendarDate,
		formatLeaveAccrual,
		formatLeavePayrollEffect,
		formatNumeric
	} from '../../lib/ui/display-formatters.js';
	import { inForceTodayFilter, todayInstant, todayKey } from '../../lib/ui/calendar.js';

	const { t } = useI18n<TenantI18nKeys>();

	let companyId = $state<string | null>(null);
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	/**
	 * The leave-type catalogue opens on the entitlements in force today, as a filter chip the
	 * operator can drop to reach superseded versions. The legal-entity selector keeps `activeRange`
	 * in its own query: it is the page's scope picker, not a listing, and it has to default to an
	 * entity that still exists.
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
	const analyticsQuery = client.invoke.approval_analytics({ subject: 'LEAVE' });
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
	const leaveTrendChart = $derived({
		kind: 'line',
		loading: analyticsQuery.loading,
		title: t('app.leave.chart_title'),
		description: t('app.leave.chart_description'),
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

	type NestedLeaveRequest = {
		readonly leave_request_type?: {
			readonly code?: string | null;
			readonly name?: string | null;
		} | null;
		readonly leave_request_employment?: { readonly employee_number?: string | null } | null;
	};

	function nestedLeaveRequest(row: unknown): NestedLeaveRequest {
		return row as NestedLeaveRequest;
	}

	function leaveTypeLabel(row: unknown): string {
		const leaveType = nestedLeaveRequest(row).leave_request_type;
		if (leaveType?.code && leaveType.name) return `${leaveType.code} · ${leaveType.name}`;
		if (leaveType?.code) return leaveType.code;
		return '—';
	}

	function employmentLabel(row: unknown): string {
		return nestedLeaveRequest(row).leave_request_employment?.employee_number ?? '—';
	}
</script>

<svelte:head>
	<title>Leave</title>
	<meta name="description" content="Review leave events and the leave types that entitle them" />
	<meta name="pod:icon" content="lucide:calendar-check-2" />
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/hr-payroll/app-media/leave-banner.webp"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/app-media/leave-banner.webp"
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

{#snippet overview()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.leave.empty_overview')}</p>
	{:else}
		<Grid gap="xl" minimum="panel">
			<Stack gap="md">
				<div>
					<h2 class="text-lg font-semibold">{t('app.leave.leave_activity')}</h2>
					<p class="text-sm text-muted-foreground">
						{t('app.leave.leave_activity_description', { count: analytics.total.toLocaleString() })}
					</p>
				</div>
				<ApprovalSummaryTable
					title={t('app.leave.leave_decisions')}
					asOfDate={analytics.as_of_date}
					summary={analytics.summary}
					note={t('app.leave.leave_decisions_note')}
				/>
			</Stack>
			<div class="min-w-0 rounded-lg border bg-card p-4 shadow-card">
				<Display spec={leaveTrendChart} class="min-h-[18rem]" />
			</div>
		</Grid>
	{/if}
{/snippet}

{#snippet requests()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.leave.empty_requests')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="leave_requests"
			view={`hr_controller:leave:requests:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { from_date: 'desc' },
				with: {
					leave_request_type: { columns: { code: true, name: true } },
					leave_request_employment: { columns: { employee_number: true } }
				}
			}}
			searchPlaceholder={t('app.leave.search_requests')}
		>
			{#snippet columns({ Column })}
				<Column
					name="leave_type_id"
					label={t('component.leave_type')}
					card="title"
					render={({ row }) => leaveTypeLabel(row)}
				/>
				<Column
					name="employment_id"
					label={t('component.employment')}
					card="subtitle"
					render={({ row }) => employmentLabel(row)}
				/>
				<Column
					name="from_date"
					label={t('component.from')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column
					name="to_date"
					label={t('component.to')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column name="kind" label={t('component.event')} card="badge" />
				<Column
					name="days"
					label={t('component.days')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column
					name="certificate_file"
					label={t('component.certificate')}
					render={({ value }) => (value == null || value === '' ? '—' : t('app.leave.attached'))}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet types()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.leave.empty_types')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="leave_types"
			view={`hr_controller:leave:types:${selectedCompanyId}`}
			initialFilters={inForceTodayFilter()}
			query={{
				where: {
					company_id: { eq: selectedCompanyId }
				},
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder={t('app.leave.search_types')}
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column
					name="accrual"
					label={t('app.leave.accrual')}
					render={({ value }) => formatLeaveAccrual(value, t)}
				/>
				<Column name="entitlement" label={t('app.leave.entitlement_matrix')} />
				<Column
					name="payroll_effect"
					label={t('app.leave.payroll_effect')}
					render={({ value }) => formatLeavePayrollEffect(value, t)}
				/>
				<Column name="encash_on_exit" label={t('app.leave.encash_on_exit')} />
				<Column name="effective_range" label={t('component.effective')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

<AppHeaderActions>
	{@render companyScopeActions()}
</AppHeaderActions>

<Cover>
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
				name: 'requests',
				label: t('app.leave.tab_requests'),
				icon: 'lucide:calendar-check-2',
				content: requests
			},
			{
				name: 'types',
				label: t('app.leave.tab_types'),
				icon: 'lucide:palmtree',
				content: types
			}
		] satisfies TabConfig[]}
	/>
</Cover>
