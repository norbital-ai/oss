<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid, Stack } from '@norbital-ai/ui/layout';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import { formatEntryOrigin, formatNumeric } from '../../lib/ui/display-formatters.js';
	import { todayKey } from '../../lib/ui/calendar.js';

	// A relation column holds a uuid. These reference sets load once per page and the label is
	// resolved from memory rather than by mounting a lookup per row; a miss falls back to the raw
	// id so an unloaded label never reads as missing data. The employment column shows the employee
	// number alone — it is the identifier the rest of HR quotes, and nothing is appended to it.
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
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const companyLabelsById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company.name]))
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
		title: 'Annual claim applications',
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
	<title>Pay components</title>
	<meta
		name="description"
		content="Review pay-component entries — allowances, claims, arrears, reversals, and loan instalments — and their payroll linkage"
	/>
	<meta name="pod:icon" content="lucide:coins" />
</svelte:head>

{#snippet overview()}
	<Grid gap="xl" minimum="panel">
		<Stack gap="md">
			<div>
				<h2 class="text-lg font-semibold">Reimbursement claims</h2>
				<p class="text-sm text-muted-foreground">
					{analytics.total.toLocaleString()} claim entries in the ledger. Every other pay component —
					recurring allowances, one-offs, arrears, reversals, loan instalments — arrives through the same
					entry stream and is listed under Entries.
				</p>
			</div>
			<ApprovalSummaryTable
				title="Claim decisions"
				asOfDate={analytics.as_of_date}
				summary={analytics.summary}
				note="Counts use the claim's incurred date from its origin variant. Approval speed is shown only when completed workflow history exists; imported records do not invent a duration."
			/>
		</Stack>
		<div class="min-w-0 rounded-lg border bg-card p-4 shadow-card">
			<Display spec={claimTrendChart} class="min-h-[18rem]" />
		</div>
	</Grid>
{/snippet}

{#snippet entries()}
	<CollectionTable
		{client}
		collection="component_entries"
		query={{ orderBy: { event_date: 'desc' } }}
		searchPlaceholder="Search entries…"
	>
		{#snippet columns({ Column })}
			<Column
				name="pay_component_id"
				label="Component"
				card="title"
				render={({ value }) => payComponentLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="employment_id"
				label="Employment"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
			/>
			<Column name="amount" label="Amount" render={({ value }) => formatNumeric(value)} />
			<Column name="quantity" label="Quantity" />
			<Column name="event_date" label="Event date" />
			<Column name="pay_period" label="Pay period" />
			<Column name="usage_mode" label="Payslip usage" card="badge" />
			<Column name="description" label="Description" />
			<Column
				name="origin"
				label="Origin"
				card="subtitle"
				render={({ value }) => formatEntryOrigin(value)}
			/>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet catalogue()}
	<CollectionTable
		{client}
		collection="pay_components"
		query={{ orderBy: { code: 'asc' } }}
		searchPlaceholder="Search the catalogue…"
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="company_id"
				label="Company"
				render={({ value }) => companyLabelsById.get(String(value)) ?? value}
			/>
			<Column name="nature" card="badge" />
			<Column name="policy" label="Settlement and statutory policy" />
			<Column name="definition" label="Calculation" />
			<Column name="sequence" label="Order" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Pay components"
		description="The company catalogue and the single entry stream money reaches payroll through. A live entry is one with no open approval; there is no separate requested/approved state."
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
			{ name: 'entries', label: 'Entries', icon: 'lucide:receipt-text', content: entries },
			{ name: 'catalogue', label: 'Catalogue', icon: 'lucide:list-tree', content: catalogue }
		] satisfies TabConfig[]}
	/>
</Cover>
