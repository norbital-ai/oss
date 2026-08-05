<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { ToggleGroup, ToggleGroupItem } from '@norbital-ai/ui/toggle-group';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import {
		formatCalendarDate,
		formatEntryOrigin,
		formatNumeric
	} from '../../lib/ui/display-formatters.js';
	import { todayKey, todayInstant } from '../../lib/ui/calendar.js';

	let companyId = $state<string | null>(null);
	const today = todayKey();
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	/**
	 * The catalogue is effective-dated, so it opens on the components in force *today* and widens to
	 * superseded versions only when the operator asks. The legal-entity selector below keeps
	 * `activeRange` whatever this is set to: it is the page's scope picker, not a listing, and it has
	 * to default to an entity that still exists.
	 */
	let effectiveWindow = $state<'current' | 'history'>('current');
	const effectiveRange: { effective_range?: { contains_date: string } } = $derived(
		effectiveWindow === 'history' ? {} : activeRange
	);

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

{#snippet companyScopeActions()}
	<Inline gap="md" align="end">
		<label class="grid gap-1.5 text-sm">
			<span class="font-medium text-muted-foreground">Legal entity</span>
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
		</label>
		<Stack gap="xs">
			<span class="text-sm font-medium text-muted-foreground">Catalogue</span>
			<ToggleGroup
				type="single"
				size="sm"
				value={effectiveWindow}
				onValueChange={(value) => {
					effectiveWindow = value === 'history' ? 'history' : 'current';
				}}
			>
				<ToggleGroupItem value="current" aria-label="Show only components in force today">
					In force today
				</ToggleGroupItem>
				<ToggleGroupItem value="history" aria-label="Show every version, including superseded ones">
					All history
				</ToggleGroupItem>
			</ToggleGroup>
		</Stack>
	</Inline>
{/snippet}

{#snippet overview()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load claim activity.</p>
	{:else}
		<Grid gap="xl" minimum="panel">
			<Stack gap="md">
				<div>
					<h2 class="text-lg font-semibold">Reimbursement claims</h2>
					<p class="text-sm text-muted-foreground">
						{analytics.total.toLocaleString()} claim entries in the ledger. Every other pay component
						— recurring allowances, one-offs, arrears, reversals, loan instalments — arrives through the
						same entry stream and is listed under Entries.
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
	{/if}
{/snippet}

{#snippet entries()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			Select a legal entity to review its pay-component entries.
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
			searchPlaceholder="Search entries…"
		>
			{#snippet columns({ Column })}
				<Column
					name="pay_component_id"
					label="Component"
					card="title"
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (payComponentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="employment_id"
					label="Employment"
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="amount" label="Amount" render={({ value }) => formatNumeric(value)} />
				<Column name="quantity" label="Quantity" />
				<Column
					name="event_date"
					label="Event date"
					render={({ value }) => formatCalendarDate(value)}
				/>
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
	{/if}
{/snippet}

{#snippet catalogue()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			Select a legal entity to manage its pay-component catalogue.
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="pay_components"
			view={`hr_controller:pay_components:catalogue:${selectedCompanyId}`}
			query={{
				where: {
					company_id: { eq: selectedCompanyId },
					...effectiveRange
				},
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder="Search the catalogue…"
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="nature" card="badge" />
				<Column name="policy" label="Settlement and statutory policy" />
				<Column name="definition" label="Calculation" />
				<Column name="sequence" label="Order" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Pay components"
		description="The company catalogue and the single entry stream money reaches payroll through — scoped to one legal entity. A live entry is one with no open approval; there is no separate requested/approved state."
		actions={companyScopeActions}
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
