<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid } from '@norbital-ai/ui/layout';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import {
		formatLeaveAccrual,
		formatLeavePayrollEffect,
		formatNumeric
	} from '../../lib/ui/display-formatters.js';
	import { todayKey } from '../../lib/ui/calendar.js';

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
	const leaveTypesQuery = client.db.leave_types.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	const leaveTypeLabelsById = $derived(
		new Map(
			(leaveTypesQuery.current ?? []).map((leaveType) => [
				leaveType.norbital_id,
				`${leaveType.code} · ${leaveType.name}`
			])
		)
	);
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const companyLabelsById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company.name]))
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
		title: 'Annual leave applications',
		description:
			'Application volume across the five completed calendar years, with a least-squares regression line.',
		data: analytics.annual_trend,
		xKey: 'year',
		series: ['applications', 'regression'],
		config: {
			applications: { label: 'Applications', color: 'var(--color-primary)' },
			regression: { label: 'Regression trend', color: 'var(--color-muted-foreground)' }
		},
		valueFormat: { style: 'number', maximumFractionDigits: 1 },
		curve: 'linear'
	} satisfies ChartDisplaySpec);
</script>

<svelte:head>
	<title>Leave</title>
	<meta
		name="description"
		content="Review leave requests, the leave ledger, and the leave types that entitle them"
	/>
	<meta name="pod:icon" content="lucide:calendar-check-2" />
</svelte:head>

{#snippet overview()}
	<Grid gap="xl" minimum="panel">
		<div class="space-y-4">
			<div>
				<h2 class="text-lg font-semibold">Leave activity</h2>
				<p class="text-sm text-muted-foreground">
					{analytics.total.toLocaleString()} requests. Balances are derived from the ledger at read time
					— there is no stored balance and no accrual job.
				</p>
			</div>
			<ApprovalSummaryTable
				title="Leave decisions"
				asOfDate={analytics.as_of_date}
				summary={analytics.summary}
				note="Counts use the leave period start date. Approval speed is shown only when completed workflow history exists; imported records do not invent a duration."
			/>
		</div>
		<div class="min-w-0 rounded-lg border bg-card p-4 shadow-card">
			<Display spec={leaveTrendChart} class="min-h-[18rem]" />
		</div>
	</Grid>
{/snippet}

{#snippet requests()}
	<CollectionTable
		{client}
		collection="leave_requests"
		query={{ orderBy: { from_date: 'desc' } }}
		searchPlaceholder="Search leave requests…"
	>
		{#snippet columns({ Column })}
			<Column
				name="leave_type_id"
				label="Leave type"
				card="title"
				render={({ value }) => leaveTypeLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="employment_id"
				label="Employment"
				card="subtitle"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
			/>
			<Column name="from_date" label="From" />
			<Column name="to_date" label="To" />
			<Column name="days" label="Days" render={({ value }) => formatNumeric(value)} />
			<Column name="certificate_file" label="Certificate" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet ledger()}
	<CollectionTable
		{client}
		collection="leave_ledger"
		query={{ orderBy: { entry_date: 'desc' } }}
		searchPlaceholder="Search ledger movements…"
	>
		{#snippet columns({ Column })}
			<Column name="entry_date" label="Date" card="title" />
			<Column
				name="employment_id"
				label="Employment"
				card="subtitle"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="leave_type_id"
				label="Leave type"
				render={({ value }) => leaveTypeLabelsById.get(String(value)) ?? value}
			/>
			<Column name="kind" label="Kind" card="badge" />
			<Column name="days" label="Days" render={({ value }) => formatNumeric(value)} />
			<Column name="note" label="Note" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet types()}
	<CollectionTable
		{client}
		collection="leave_types"
		query={{ orderBy: { code: 'asc' } }}
		searchPlaceholder="Search leave types…"
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="company_id"
				label="Company"
				render={({ value }) => companyLabelsById.get(String(value)) ?? value}
			/>
			<Column name="accrual" label="Accrual" render={({ value }) => formatLeaveAccrual(value)} />
			<Column
				name="payroll_effect"
				label="Payroll effect"
				render={({ value }) => formatLeavePayrollEffect(value)}
			/>
			<Column name="encash_on_exit" label="Encash on exit" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Leave"
		description="Decide requests against the leave type, its accrual bands, and the ledger effective on the leave dates."
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'overview',
				label: 'Overview',
				icon: 'lucide:chart-no-axes-combined',
				content: overview
			},
			{ name: 'requests', label: 'Requests', icon: 'lucide:calendar-check-2', content: requests },
			{ name: 'ledger', label: 'Ledger', icon: 'lucide:list-ordered', content: ledger },
			{ name: 'types', label: 'Leave types', icon: 'lucide:palmtree', content: types }
		] satisfies TabConfig[]}
	/>
</Cover>
