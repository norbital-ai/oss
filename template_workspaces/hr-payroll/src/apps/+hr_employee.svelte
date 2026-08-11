<script lang="ts">
	import { client } from '$pod/client';
	import { getPlatformStateContext } from '@norbital-ai/pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cluster, Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import {
		formatCalendarDate,
		formatEntryOrigin,
		formatInstant,
		formatNumeric,
		formatRepaymentSchedule
	} from '../lib/ui/display-formatters.js';
	import {
		daysBetweenKeys,
		inForceTodayFilter,
		monthKey,
		payDateFor,
		shiftMonthKey,
		todayKey
	} from '../lib/ui/calendar.js';

	const user = getPlatformStateContext()().user;
	const today = todayKey();

	const { t } = useI18n<TenantI18nKeys>();

	/**
	 * My loans opens on the agreements still being repaid today, as a filter chip the reader can drop
	 * to see settled ones.
	 */
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
	// A miss renders as an em dash — never the underlying uuid.
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
	const employmentsQuery = $derived(
		employeeId
			? client.db.employments.findMany({
					where: { employee_id: { eq: employeeId }, norbital_approval_id: { isNull: true } },
					limit: 10
				})
			: null
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
			label: `${companyById.get(employment.company_id)?.name ?? t('app.hr_employee.company_fallback')}${t('app.hr_employee.employment_affiliation', { number: employment.employee_number })}`,
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
	/**
	 * Every table on this page is scoped by `employmentId`, so a reader with no active employment has
	 * nothing to scope to and each table is handed `disabled`. That disables the create button along
	 * with search, filter and refresh — and on its own it renders as a dead page whose greyed
	 * `New Time Entry` reads as "you are not allowed to do this", which is the one thing it does not
	 * mean. An employee who *does* hold an employment may create here; the create is gated on their
	 * direct manager, and a gated create is still a create.
	 *
	 * The gate below states the real reason instead. It is held false while either query is still in
	 * flight so the explanation cannot flash before the rows that would contradict it. A resolved
	 * employee with no `employments` row and no employee row at all land in the same place, and
	 * correctly so: neither can be scoped to an employment, and both are fixed by HR, not by the
	 * reader.
	 */
	const employmentContextResolved = $derived(
		!employeeQuery.loading && !(employmentsQuery?.loading ?? false)
	);
	const hasNoActiveEmployment = $derived(
		employmentContextResolved && activeEmployments.length === 0
	);
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

	type NestedPayslip = {
		readonly payslip_payroll_run?: { readonly period?: string | null } | null;
	};

	function nestedPayslip(row: unknown): NestedPayslip {
		return row as NestedPayslip;
	}

	function payrollRunPeriod(row: unknown): string {
		return nestedPayslip(row).payslip_payroll_run?.period ?? '—';
	}
</script>

<svelte:head>
	<title>Employee Self-Service</title>
	<meta
		name="description"
		content="View your schedule, leave, pay components, loans, payslips, and profile"
	/>
	<meta name="pod:icon" content="lucide:user-round" />
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/hr-payroll/app-media/hr_employee-banner.webp"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/app-media/hr_employee-banner.webp"
	/>
</svelte:head>

{#snippet contextGate()}
	{#if hasNoActiveEmployment}
		<Stack gap="none" class="rounded-xl border bg-card p-4 shadow-sm">
			<p class="text-sm font-medium">{t('app.hr_employee.no_active_employment')}</p>
			<p class="text-sm text-muted-foreground">
				{t('app.hr_employee.no_active_employment_description')}
			</p>
		</Stack>
	{:else if needsEmploymentChoice}
		<Stack gap="sm" class="rounded-xl border bg-card p-4 shadow-sm">
			<Stack gap="none">
				<p class="text-sm font-medium">{t('app.hr_employee.choose_employment')}</p>
				<p class="text-sm text-muted-foreground">
					{t('app.hr_employee.choose_employment_description')}
				</p>
			</Stack>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('app.hr_employee.working_as')}
				<Combobox
					options={employmentOptions}
					bind:value={selectedEmploymentId}
					searchPlaceholder={t('app.hr_employee.search_employment')}
					emptyPlaceholder={t('app.hr_employee.no_matching_employment')}
				/>
			</label>
		</Stack>
	{:else if activeEmployments.length > 1 && selectedEmployment}
		<Cluster class="rounded-xl border bg-card p-4 shadow-sm" gap="md" align="end" justify="between">
			<Stack gap="none">
				<p class="text-sm font-medium">{t('app.hr_employee.working_in')}</p>
				<p class="text-sm text-muted-foreground">
					{companyById.get(selectedEmployment.company_id)?.name ??
						t('app.hr_employee.company_fallback')}
					{t('app.hr_employee.employment_affiliation', {
						number: selectedEmployment.employee_number
					})}
				</p>
			</Stack>
			<label class="grid w-full gap-1.5 text-sm font-medium">
				{t('app.hr_employee.switch_employment')}
				<Combobox
					options={employmentOptions}
					bind:value={selectedEmploymentId}
					searchPlaceholder={t('app.hr_employee.search_employment')}
					emptyPlaceholder={t('app.hr_employee.no_matching_employment')}
				/>
			</label>
		</Cluster>
	{/if}
{/snippet}

{#snippet home()}
	<Stack gap="md">
		{@render contextGate()}
		{#if employeeQuery.loading}
			<div
				class="h-56 animate-pulse rounded-lg bg-muted/40"
				aria-label={t('component.loading_profile')}
			></div>
		{:else if employeeQuery.current}
			<section class="rounded-lg border bg-card shadow-card" aria-labelledby="my-profile-heading">
				<Cluster align="start" justify="between" gap="md" class="border-b bg-muted/30 px-5 py-4">
					<Stack gap="none">
						<p class="text-tiny font-medium uppercase tracking-wide text-muted-foreground">
							{t('app.hr_employee.my_profile')}
						</p>
						<h2 id="my-profile-heading" class="text-heading">
							{employeeQuery.current.name}
						</h2>
						<p class="text-sm text-muted-foreground">
							{company?.name ?? t('app.hr_employee.no_active_company')}{activeEmployment
								? t('app.hr_employee.employee_of', {
										number: activeEmployment.employee_number
									})
								: ''}
						</p>
					</Stack>
					{#if nextPayDate && daysToPayday != null}
						<Stack gap="none" class="text-right">
							<p class="text-xs font-medium text-muted-foreground">
								{t('app.hr_employee.next_payday')}
							</p>
							<p class="text-lg font-semibold tabular-nums">
								{daysToPayday === 0
									? t('app.hr_employee.today')
									: t('app.hr_employee.days_until', { days: daysToPayday })}
							</p>
							<p class="text-xs text-muted-foreground">
								{formatCalendarDate(nextPayDate)}
							</p>
						</Stack>
					{/if}
				</Cluster>
				<!-- stupidity:allow UI10 -- 1px hairline gutters via bg-border are not on the gap scale -->
				<Grid class="gap-px bg-border" gap="none" minimum="compact">
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">{t('component.email')}</p>
						<p class="mt-1 truncate text-sm font-medium">{employeeQuery.current.email}</p>
					</div>
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">{t('component.phone')}</p>
						<p class="mt-1 text-sm font-medium">
							{employeeQuery.current.phone ?? t('app.hr_employee.not_provided')}
						</p>
					</div>
					<div class="bg-card px-5 py-4">
						<p class="text-xs font-medium text-muted-foreground">{t('component.nationality')}</p>
						<p class="mt-1 text-sm font-medium">
							{employeeQuery.current.nationality ?? t('app.hr_employee.not_provided')}
						</p>
					</div>
				</Grid>
			</section>
		{/if}
	</Stack>
{/snippet}

{#snippet time()}
	<Stack gap="md">
		{@render contextGate()}
		<CollectionTable
			{client}
			collection="time_entries"
			title={t('app.hr_employee.my_time_title')}
			description={t('app.hr_employee.my_time_description')}
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { work_date: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="work_date"
					label={t('component.work_date')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column
					name="clock_in"
					label={t('component.clock_in')}
					render={({ value }) => formatInstant(value)}
				/>
				<Column
					name="clock_out"
					label={t('component.clock_out')}
					render={({ value }) => formatInstant(value)}
				/>
				<Column name="state" label={t('component.state')} />
			{/snippet}
			{#snippet ListCard(entry)}
				<p class="font-medium">{formatCalendarDate(entry.work_date)}</p>
				<p class="mt-1 text-sm text-muted-foreground">{entry.state}</p>
			{/snippet}
		</CollectionTable>
	</Stack>
{/snippet}

{#snippet leave()}
	<Stack gap="md">
		{@render contextGate()}
		<CollectionTable
			{client}
			collection="leave_requests"
			title={t('app.hr_employee.my_leave_title')}
			description={t('app.hr_employee.my_leave_description')}
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { from_date: 'desc' }
			}}
			searchPlaceholder={t('app.hr_employee.search_leave_type')}
		>
			{#snippet columns({ Column })}
				<Column
					name="leave_type_id"
					label={t('component.leave_type')}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (leaveTypeLabelsById.get(String(value)) ?? '—')}
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
				<Column
					name="days"
					label={t('component.days')}
					render={({ value }) => formatNumeric(value)}
				/>
			{/snippet}
		</CollectionTable>
	</Stack>
{/snippet}

{#snippet claims()}
	<Stack gap="md">
		{@render contextGate()}
		<CollectionTable
			{client}
			collection="component_entries"
			title={t('app.hr_employee.my_components_title')}
			description={t('app.hr_employee.my_components_description')}
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { event_date: 'desc' }
			}}
			searchPlaceholder={t('app.hr_employee.search_pay_component')}
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
					name="amount"
					label={t('component.amount')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column
					name="event_date"
					label={t('component.date')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column
					name="origin"
					label={t('component.origin')}
					card="subtitle"
					render={({ value }) => formatEntryOrigin(value, t)}
				/>
			{/snippet}
		</CollectionTable>
	</Stack>
{/snippet}

{#snippet loans()}
	<Stack gap="md">
		{@render contextGate()}
		<CollectionTable
			{client}
			collection="repayment_agreements"
			features={{ create: false }}
			title={t('app.hr_employee.my_loans_title')}
			description={t('app.hr_employee.my_loans_description')}
			disabled={!employmentId}
			initialFilters={inForceTodayFilter()}
			query={{
				where: {
					employment_id: employmentId ? { eq: employmentId } : undefined
				},
				orderBy: { disbursed_on: 'desc' }
			}}
			searchPlaceholder={t('app.hr_employee.search_loans')}
		>
			{#snippet columns({ Column })}
				<Column name="reference" card="title" />
				<Column
					name="principal"
					label={t('component.principal')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column
					name="schedule"
					label={t('component.schedule')}
					card="subtitle"
					render={({ value }) => formatRepaymentSchedule(value, t)}
				/>
				<Column
					name="disbursed_on"
					label={t('component.disbursed')}
					render={({ value }) => formatCalendarDate(value)}
				/>
			{/snippet}
		</CollectionTable>
	</Stack>
{/snippet}

{#snippet payslips()}
	<Stack gap="md">
		{@render contextGate()}
		<CollectionTable
			{client}
			collection="payslips"
			features={{ create: false }}
			title={t('app.hr_employee.my_payslips_title')}
			description={t('app.hr_employee.my_payslips_description')}
			disabled={!employmentId}
			query={{
				where: { employment_id: employmentId ? { eq: employmentId } : undefined },
				orderBy: { norbital_created_at: 'desc' },
				with: { payslip_payroll_run: { columns: { period: true } } }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="payroll_run_id"
					label={t('app.hr_employee.pay_run')}
					render={({ row }) => payrollRunPeriod(row)}
				/>
				<Column
					name="gross"
					label={t('component.gross')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column
					name="total_deductions"
					label={t('component.deductions')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column
					name="net"
					label={t('component.net')}
					render={({ value }) => formatNumeric(value)}
				/>
				<Column name="currency" />
			{/snippet}
			{#snippet ListCard(payslip)}
				<p class="truncate font-medium">{payrollRunPeriod(payslip)}</p>
				<p class="mt-1 text-sm text-muted-foreground">
					{payslip.currency}
					{formatNumeric(payslip.net)}
				</p>
			{/snippet}
		</CollectionTable>
	</Stack>
{/snippet}

<Cover>
	<Tabs
		animate={false}
		config={[
			{
				name: 'home',
				label: t('app.hr_employee.tab_home'),
				icon: 'lucide:user-round',
				content: home
			},
			{ name: 'time', label: t('app.hr_employee.tab_time'), icon: 'lucide:clock', content: time },
			{
				name: 'leave',
				label: t('app.hr_employee.tab_leave'),
				icon: 'lucide:calendar-check',
				content: leave
			},
			{
				name: 'claims',
				label: t('app.hr_employee.tab_claims'),
				icon: 'lucide:receipt',
				content: claims
			},
			{
				name: 'loans',
				label: t('app.hr_employee.tab_loans'),
				icon: 'lucide:hand-coins',
				content: loans
			},
			{
				name: 'payslips',
				label: t('app.hr_employee.tab_payslips'),
				icon: 'lucide:badge-dollar-sign',
				content: payslips
			}
		] satisfies TabConfig[]}
	/>
</Cover>
