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
		formatLeaveAccrual,
		formatLeavePayrollEffect,
		formatNumeric
	} from '../../lib/ui/display-formatters.js';
	import { todayKey, todayInstant } from '../../lib/ui/calendar.js';

	let companyId = $state<string | null>(null);
	const today = todayKey();
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

	/**
	 * Leave types are effective-dated, so the catalogue opens on the entitlements in force *today*
	 * and widens to superseded versions only when the operator asks. The legal-entity selector below
	 * keeps `activeRange` whatever this is set to: it is the page's scope picker, not a listing, and
	 * it has to default to an entity that still exists.
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
			<span class="text-sm font-medium text-muted-foreground">Leave types</span>
			<ToggleGroup
				type="single"
				size="sm"
				value={effectiveWindow}
				onValueChange={(value) => {
					effectiveWindow = value === 'history' ? 'history' : 'current';
				}}
			>
				<ToggleGroupItem value="current" aria-label="Show only leave types in force today">
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
		<p class="text-sm text-muted-foreground">Select a legal entity to load leave activity.</p>
	{:else}
		<Grid gap="xl" minimum="panel">
			<Stack gap="md">
				<div>
					<h2 class="text-lg font-semibold">Leave activity</h2>
					<p class="text-sm text-muted-foreground">
						{analytics.total.toLocaleString()} time-off requests. Balances are derived directly from approved
						leave events at read time — there is no duplicate ledger, stored balance, or accrual job.
					</p>
				</div>
				<ApprovalSummaryTable
					title="Leave decisions"
					asOfDate={analytics.as_of_date}
					summary={analytics.summary}
					note="Counts use the leave period start date. Approval speed is shown only when completed workflow history exists; imported records do not invent a duration."
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
		<p class="text-sm text-muted-foreground">Select a legal entity to review its leave requests.</p>
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
			searchPlaceholder="Search leave requests…"
		>
			{#snippet columns({ Column })}
				<Column
					name="leave_type_id"
					label="Leave type"
					card="title"
					render={({ row }) => leaveTypeLabel(row)}
				/>
				<Column
					name="employment_id"
					label="Employment"
					card="subtitle"
					render={({ row }) => employmentLabel(row)}
				/>
				<Column name="from_date" label="From" render={({ value }) => formatCalendarDate(value)} />
				<Column name="to_date" label="To" render={({ value }) => formatCalendarDate(value)} />
				<Column name="kind" label="Event" card="badge" />
				<Column name="days" label="Days" render={({ value }) => formatNumeric(value)} />
				<Column
					name="certificate_file"
					label="Certificate"
					render={({ value }) => (value == null || value === '' ? '—' : 'Attached')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet types()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its leave types.</p>
	{:else}
		<CollectionTable
			{client}
			collection="leave_types"
			view={`hr_controller:leave:types:${selectedCompanyId}`}
			query={{
				where: {
					company_id: { eq: selectedCompanyId },
					...effectiveRange
				},
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder="Search leave types…"
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="accrual" label="Accrual" render={({ value }) => formatLeaveAccrual(value)} />
				<Column name="entitlement" label="Entitlement matrix" />
				<Column
					name="payroll_effect"
					label="Payroll effect"
					render={({ value }) => formatLeavePayrollEffect(value)}
				/>
				<Column name="encash_on_exit" label="Encash on exit" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Leave"
		description="Decide time-off requests against the leave type's layered entitlement matrix — scoped to one legal entity."
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
			{ name: 'requests', label: 'Requests', icon: 'lucide:calendar-check-2', content: requests },
			{ name: 'types', label: 'Leave types', icon: 'lucide:palmtree', content: types }
		] satisfies TabConfig[]}
	/>
</Cover>
