<script lang="ts">
	import { client } from '$pod/client';
	import { getPlatformStateContext } from '@norbital-ai/pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cluster, Cover, Grid } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { watch } from 'runed';
	import {
		formatEntryOrigin,
		formatNumeric,
		formatRepaymentSchedule
	} from '../lib/ui/display-formatters.js';
	import {
		daysBetweenKeys,
		monthKey,
		payDateFor,
		shiftMonthKey,
		todayKey
	} from '../lib/ui/calendar.js';

	const user = getPlatformStateContext()().user;
	const today = todayKey();
	const employeeQuery = client.db.employees.findFirst({ where: { email: { eq: user.email } } });
	const employeeId = $derived(employeeQuery.current?.norbital_id);
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const companyById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company]))
	);
	// A relation column holds a uuid and would render as one. These catalogues are small and load
	// once per page, so the label is resolved from memory rather than by mounting a lookup per row.
	// A miss falls back to the raw id — a label the page has not loaded must not read as no data.
	const leaveTypesQuery = client.db.leave_types.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	const leaveTypeLabelsById = $derived(
		new Map(
			(leaveTypesQuery.current ?? []).map((leaveType) => [leaveType.norbital_id, leaveType.name])
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
	const payrollRunsQuery = client.db.payroll_runs.findMany({
		where: { norbital_approval_id: { isNull: true } },
		orderBy: { period: 'desc' },
		limit: 500
	});
	const payrollRunLabelsById = $derived(
		new Map((payrollRunsQuery.current ?? []).map((run) => [run.norbital_id, run.period]))
	);
	// svelte-ignore state_referenced_locally -- this initial handle is replaced by the identity watch below.
	let employmentsQuery = $state(
		employeeId
			? client.db.employments.findMany({
					where: { employee_id: { eq: employeeId }, norbital_approval_id: { isNull: true } },
					limit: 10
				})
			: null
	);
	watch(
		() => employeeId,
		(id) => {
			employmentsQuery = id
				? client.db.employments.findMany({
						where: { employee_id: { eq: id }, norbital_approval_id: { isNull: true } },
						limit: 10
					})
				: null;
		},
		{ lazy: true }
	);
	const activeEmployments = $derived(
		(employmentsQuery?.current ?? []).filter(
			(employment) =>
				employment.effective_range != null &&
				employment.effective_range.start.slice(0, 10) <= today &&
				(employment.effective_range.end == null ||
					employment.effective_range.end.slice(0, 10) >= today)
		)
	);
	let selectedEmploymentId = $state<string | null>(null);
	const employmentOptions = $derived(
		activeEmployments.map((employment) => ({
			value: employment.norbital_id,
			label: `${companyById.get(employment.company_id)?.name ?? 'Company'} · Employee ${employment.employee_number}`,
			search_term: `${companyById.get(employment.company_id)?.name ?? ''} ${employment.employee_number}`
		}))
	);
	const selectedEmployment = $derived(
		activeEmployments.find((employment) => employment.norbital_id === selectedEmploymentId)
	);
	const employmentId = $derived(
		activeEmployments.length === 1
			? activeEmployments[0]?.norbital_id
			: selectedEmployment?.norbital_id
	);
	const activeEmployment = $derived(
		activeEmployments.find((employment) => employment.norbital_id === employmentId)
	);
	const needsEmploymentChoice = $derived(activeEmployments.length > 1 && !employmentId);
	const company = $derived(
		activeEmployment ? companyById.get(activeEmployment.company_id) : undefined
	);
	/** The next occurrence of the company's pay day — a calendar reading, not a payroll decision. */
	const nextPayDate = $derived.by(() => {
		if (!company) return null;
		const thisMonth = payDateFor(monthKey(today), company.pay_day);
		return thisMonth >= today
			? thisMonth
			: payDateFor(shiftMonthKey(monthKey(today), 1), company.pay_day);
	});
	const daysToPayday = $derived(
		nextPayDate ? Math.max(0, daysBetweenKeys(today, nextPayDate)) : null
	);
</script>

<svelte:head>
	<title>Employee Self-Service</title>
	<meta
		name="description"
		content="View your schedule, leave, pay components, loans, payslips, and profile"
	/>
	<meta name="pod:icon" content="lucide:user-round" />
</svelte:head>

{#snippet contextGate()}
	{#if needsEmploymentChoice}
		<div class="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
			<div class="space-y-1">
				<p class="text-sm font-medium">Choose the employment you are working in</p>
				<p class="text-sm text-muted-foreground">
					Your requests, time, loans, and payslips will be scoped to this employment.
				</p>
			</div>
			<label class="grid gap-1.5 text-sm font-medium">
				Working as
				<Combobox
					options={employmentOptions}
					bind:value={selectedEmploymentId}
					searchPlaceholder="Search by company or employee number…"
					emptyPlaceholder="No matching employment"
				/>
			</label>
		</div>
	{:else if activeEmployments.length > 1 && selectedEmployment}
		<Cluster class="rounded-xl border bg-card p-4 shadow-sm" gap="md" align="end" justify="between">
			<div class="space-y-1">
				<p class="text-sm font-medium">Working in</p>
				<p class="text-sm text-muted-foreground">
					{companyById.get(selectedEmployment.company_id)?.name ?? 'Company'} · Employee
					{selectedEmployment.employee_number}
				</p>
			</div>
			<label class="grid w-full gap-1.5 text-sm font-medium">
				Switch employment
				<Combobox
					options={employmentOptions}
					bind:value={selectedEmploymentId}
					searchPlaceholder="Search by company or employee number…"
					emptyPlaceholder="No matching employment"
				/>
			</label>
		</Cluster>
	{/if}
{/snippet}

{#snippet home()}
	<div class="space-y-4">
		{@render contextGate()}
		{#if employeeQuery.loading}
			<div
				class="h-56 animate-pulse rounded-lg bg-muted/40"
				aria-label="Loading your profile"
			></div>
		{:else if employeeQuery.current}
			<section class="rounded-lg border bg-card shadow-card" aria-labelledby="my-profile-heading">
				<header
					class="flex flex-wrap items-start justify-between gap-4 border-b bg-muted/30 px-5 py-4"
				>
					<div>
						<p class="text-tiny font-medium uppercase tracking-wide text-muted-foreground">
							My profile
						</p>
						<h2 id="my-profile-heading" class="mt-1 text-heading">
							{employeeQuery.current.name}
						</h2>
						<p class="mt-1 text-sm text-muted-foreground">
							{company?.name ?? 'No active company'}{activeEmployment
								? ` · Employee ${activeEmployment.employee_number}`
								: ''}
						</p>
					</div>
					{#if nextPayDate}
						<div class="text-right">
							<p class="text-xs font-medium text-muted-foreground">Next payday</p>
							<p class="mt-1 text-lg font-semibold tabular-nums">
								{daysToPayday === 0 ? 'Today' : `${daysToPayday} days`}
							</p>
							<p class="text-xs text-muted-foreground">
								{new Date(`${nextPayDate}T00:00:00.000Z`).toLocaleDateString()}
							</p>
						</div>
					{/if}
				</header>
				<Grid class="gap-px bg-border" gap="none" minimum="compact">
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">Email</p>
						<p class="mt-1 truncate text-sm font-medium">{employeeQuery.current.email}</p>
					</div>
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">Phone</p>
						<p class="mt-1 text-sm font-medium">{employeeQuery.current.phone ?? 'Not provided'}</p>
					</div>
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">Nationality</p>
						<p class="mt-1 text-sm font-medium">
							{employeeQuery.current.nationality ?? 'Not provided'}
						</p>
					</div>
				</Grid>
			</section>
		{/if}
	</div>
{/snippet}

{#snippet time()}
	<Cover gap="md" top={contextGate}>
		<CollectionTable
			{client}
			collection="time_entries"
			title="My time and schedule"
			description="Raw clock events keyed by employment and explicit local work date."
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { work_date: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="work_date" label="Work date" />
				<Column name="clock_in" label="Clock in" />
				<Column name="clock_out" label="Clock out" />
				<Column name="state" label="State" />
			{/snippet}
			{#snippet ListCard(entry)}
				<p class="font-medium">{entry.work_date}</p>
				<p class="mt-1 text-sm text-muted-foreground">{entry.state}</p>
			{/snippet}
		</CollectionTable>
	</Cover>
{/snippet}

{#snippet leave()}
	<Cover gap="md" top={contextGate}>
		<CollectionTable
			{client}
			collection="leave_requests"
			title="My leave"
			description="Submit leave and track the ledger movements it creates."
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { from_date: 'desc' }
			}}
			searchPlaceholder="Search leave type…"
		>
			{#snippet columns({ Column })}
				<Column
					name="leave_type_id"
					label="Leave type"
					card="title"
					render={({ value }) => leaveTypeLabelsById.get(String(value)) ?? value}
				/>
				<Column name="from_date" label="From" />
				<Column name="to_date" label="To" />
				<Column name="days" label="Days" render={({ value }) => formatNumeric(value)} />
			{/snippet}
		</CollectionTable>
	</Cover>
{/snippet}

{#snippet claims()}
	<Cover gap="md" top={contextGate}>
		<CollectionTable
			{client}
			collection="component_entries"
			title="My pay components"
			description="Claims, allowances, arrears, and loan instalments, with why each entry exists."
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { event_date: 'desc' }
			}}
			searchPlaceholder="Search pay component…"
		>
			{#snippet columns({ Column })}
				<Column
					name="pay_component_id"
					label="Component"
					card="title"
					render={({ value }) => payComponentLabelsById.get(String(value)) ?? value}
				/>
				<Column name="amount" label="Amount" render={({ value }) => formatNumeric(value)} />
				<Column name="event_date" label="Date" />
				<Column
					name="origin"
					label="Origin"
					card="subtitle"
					render={({ value }) => formatEntryOrigin(value)}
				/>
			{/snippet}
		</CollectionTable>
	</Cover>
{/snippet}

{#snippet loans()}
	<Cover gap="md" top={contextGate}>
		<CollectionTable
			{client}
			collection="repayment_agreements"
			features={{ create: false }}
			title="My loans"
			description="Review the agreed principal and the instalments it is being repaid by."
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { disbursed_on: 'desc' }
			}}
			searchPlaceholder="Search loans…"
		>
			{#snippet columns({ Column })}
				<Column name="reference" card="title" />
				<Column name="principal" label="Principal" render={({ value }) => formatNumeric(value)} />
				<Column
					name="schedule"
					label="Schedule"
					card="subtitle"
					render={({ value }) => formatRepaymentSchedule(value)}
				/>
				<Column name="disbursed_on" label="Disbursed" />
			{/snippet}
		</CollectionTable>
	</Cover>
{/snippet}

{#snippet payslips()}
	<Cover gap="md" top={contextGate}>
		<CollectionTable
			{client}
			collection="payslips"
			features={{ create: false }}
			title="My payslips"
			description="Review payroll results and a safe explanation of every line."
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { norbital_created_at: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="payroll_run_id"
					label="Pay run"
					render={({ value }) => payrollRunLabelsById.get(String(value)) ?? value}
				/>
				<Column name="gross" label="Gross" render={({ value }) => formatNumeric(value)} />
				<Column
					name="total_deductions"
					label="Deductions"
					render={({ value }) => formatNumeric(value)}
				/>
				<Column name="net" label="Net" render={({ value }) => formatNumeric(value)} />
				<Column name="currency" />
			{/snippet}
			{#snippet ListCard(payslip)}
				<p class="truncate font-medium">
					{payrollRunLabelsById.get(payslip.payroll_run_id) ?? payslip.payroll_run_id}
				</p>
				<p class="mt-1 text-sm text-muted-foreground">
					{payslip.currency}
					{formatNumeric(payslip.net)}
				</p>
			{/snippet}
		</CollectionTable>
	</Cover>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Employee Self-Service"
		title="My HR"
		description="Your schedule, leave, pay components, loans, payslips, and employment history in one place."
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{ name: 'home', label: 'Home', icon: 'lucide:user-round', content: home },
			{ name: 'time', label: 'My time', icon: 'lucide:clock', content: time },
			{ name: 'leave', label: 'My leave', icon: 'lucide:calendar-check', content: leave },
			{ name: 'claims', label: 'My claims', icon: 'lucide:receipt', content: claims },
			{ name: 'loans', label: 'My loans', icon: 'lucide:hand-coins', content: loans },
			{
				name: 'payslips',
				label: 'My payslips',
				icon: 'lucide:badge-dollar-sign',
				content: payslips
			}
		] satisfies TabConfig[]}
	/>
</Cover>
