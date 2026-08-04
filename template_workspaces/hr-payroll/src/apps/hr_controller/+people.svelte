<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { formatDataValue } from '@norbital-ai/ui/data-renderer';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Columns, Cover, Inline, Split, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { todayKey } from '../../lib/ui/calendar.js';
	import { formatStatutoryFactStatus } from '../../lib/ui/display-formatters.js';

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
	const employeeIds = $derived([
		...new Set((employmentsQuery?.current ?? []).map((employment) => employment.employee_id))
	]);
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery?.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);
	const employeesQuery = client.db.employees.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 1000
	});
	const employeeLabelsById = $derived(
		new Map((employeesQuery.current ?? []).map((employee) => [employee.norbital_id, employee.name]))
	);
	const contributionsQuery = client.db.statutory_contributions.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const contributionLabelsById = $derived(
		new Map(
			(contributionsQuery.current ?? []).map((contribution) => [
				contribution.norbital_id,
				`${contribution.code} · ${contribution.name}`
			])
		)
	);
	/** Headcount is derived from effective employments — the schema stores no headcount column. */
	const currentEmployees = $derived(
		new Set(
			(employmentsQuery?.current ?? [])
				.filter(
					(employment) =>
						employment.effective_range != null &&
						employment.effective_range.start.slice(0, 10) <= today &&
						(employment.effective_range.end == null ||
							employment.effective_range.end.slice(0, 10) >= today)
				)
				.map((employment) => employment.employee_id)
		).size
	);
	const workforceTrend = $derived.by(() => {
		const ranges = (employmentsQuery?.current ?? []).flatMap((employment) =>
			employment.effective_range
				? [
						{
							start: employment.effective_range.start.slice(0, 10),
							end: employment.effective_range.end?.slice(0, 10) ?? '9999-12-31'
						}
					]
				: []
		);
		return Array.from({ length: 12 }, (_value, offset) => {
			const date = new Date(
				Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 11 + offset, 1)
			);
			const month = date.toISOString().slice(0, 7);
			const monthStart = `${month}-01`;
			const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
				.toISOString()
				.slice(0, 10);
			const startingHeadcount = ranges.filter(
				(range) => range.start < monthStart && range.end >= monthStart
			).length;
			const endingHeadcount = ranges.filter(
				(range) => range.start <= monthEnd && range.end >= monthEnd
			).length;
			const leavers = ranges.filter(
				(range) => range.end >= monthStart && range.end <= monthEnd
			).length;
			const hires = ranges.filter(
				(range) => range.start >= monthStart && range.start <= monthEnd
			).length;
			const averageHeadcount = (startingHeadcount + endingHeadcount) / 2;
			return {
				month,
				turnover: averageHeadcount > 0 ? leavers / averageHeadcount : 0,
				hireRate: averageHeadcount > 0 ? hires / averageHeadcount : 0
			};
		});
	});
	const averageTurnover = $derived(
		workforceTrend.reduce((total, month) => total + month.turnover, 0) / workforceTrend.length
	);
	const workforceChart = $derived({
		kind: 'line',
		loading: employmentsQuery?.loading ?? false,
		title: 'Turnover and hiring',
		description: 'Monthly leavers and joiners against average headcount.',
		data: workforceTrend,
		xKey: 'month',
		series: ['turnover', 'hireRate'],
		config: {
			turnover: { label: 'Turnover rate', color: 'var(--color-destructive)' },
			hireRate: { label: 'Hire rate', color: 'var(--color-primary)' }
		},
		valueFormat: { style: 'percent', maximumFractionDigits: 1 },
		curve: 'linear'
	} satisfies ChartDisplaySpec);

	type NestedEmployment = {
		readonly employment_employee?: { readonly name?: string | null } | null;
	};

	function nestedEmployment(row: unknown): NestedEmployment {
		return row as NestedEmployment;
	}

	function personLabel(row: unknown): string {
		return nestedEmployment(row).employment_employee?.name ?? '—';
	}
</script>

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

{#snippet workforceSummary()}
	<Stack as="section" gap="md" aria-labelledby="workforce-summary-heading">
		<div>
			<h2 id="workforce-summary-heading" class="text-lg font-semibold">Workforce</h2>
			<p class="text-sm text-muted-foreground">
				Current status is derived from effective employments, not a duplicated employee flag.
			</p>
		</div>
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">Select a legal entity to load workforce metrics.</p>
		{:else}
			<!-- stupidity:allow UI10 -- 1px hairline gutters via bg-border are not on the gap scale -->
			<Columns count={2} gap="none" class="gap-px rounded-lg border bg-border">
				<Stack gap="none" class="bg-card p-4">
					<p class="text-xs font-medium text-muted-foreground">Current</p>
					<p class="text-2xl font-semibold tabular-nums">{currentEmployees}</p>
				</Stack>
				<Stack gap="none" class="bg-card p-4">
					<p class="text-xs font-medium text-muted-foreground">12-month average turnover</p>
					<p class="text-2xl font-semibold tabular-nums">
						{averageTurnover.toLocaleString(undefined, {
							style: 'percent',
							maximumFractionDigits: 1
						})}
					</p>
				</Stack>
			</Columns>
		{/if}
	</Stack>
{/snippet}

{#snippet workforceTrendPanel()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load the trend chart.</p>
	{:else}
		<div class="min-w-0 rounded-lg border bg-card p-4 shadow-card">
			<Display spec={workforceChart} class="min-h-[18rem]" />
		</div>
	{/if}
{/snippet}

{#snippet overview()}
	<Split
		ratio="third"
		collapse="stack"
		collapseAt="narrow"
		gap="lg"
		start={workforceSummary}
		end={workforceTrendPanel}
	/>
{/snippet}

{#snippet directory()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to browse its people.</p>
	{:else}
		<CollectionTable
			{client}
			collection="employees"
			view={`hr_controller:people:directory:${selectedCompanyId}`}
			title="People directory"
			description="Facts true of the human being. Everything job-shaped lives on employments."
			query={{
				where: { norbital_id: { in: employeeIds } },
				orderBy: { name: 'asc' }
			}}
			searchPlaceholder="Search people…"
		>
			{#snippet columns({ Column })}
				<Column name="name" />
				<Column name="email" />
				<Column name="phone" />
				<Column name="nationality" />
				<Column name="date_of_birth" label="Date of birth" />
				<Column name="dependents_count" label="Dependents" />
			{/snippet}
			{#snippet ListCard(person)}
				<p class="truncate font-medium">{person.name}</p>
				<p class="mt-1 truncate text-sm text-muted-foreground">{person.email}</p>
				<p class="mt-1 truncate text-sm">
					{person.phone
						? formatDataValue({ name: 'phone', kind: 'phone', nullable: true }, person.phone)
						: (person.nationality ?? '')}
				</p>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet engagements()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its employments.</p>
	{:else}
		<CollectionTable
			{client}
			collection="employments"
			view={`hr_controller:people:employments:${selectedCompanyId}`}
			title="Employments"
			description="One person working for one company. hire_date drives service months and every leave accrual."
			query={{
				where: { company_id: { eq: selectedCompanyId }, ...activeRange },
				orderBy: { employee_number: 'asc' },
				with: { employment_employee: { columns: { name: true } } }
			}}
			searchPlaceholder="Search employments…"
		>
			{#snippet columns({ Column })}
				<Column name="employee_number" card="title" />
				<Column
					name="employee_id"
					label="Person"
					card="subtitle"
					render={({ row }) => personLabel(row)}
				/>
				<Column name="hire_date" label="Hired" />
				<Column name="exit_date" label="Exited" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet terms()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			Select a legal entity to manage its contractual terms.
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="employment_terms"
			view={`hr_controller:people:terms:${selectedCompanyId}`}
			title="Contractual terms"
			description="Effective-dated pay and classification. End-date and insert a successor; never update in place."
			query={{
				where: { employment_id: { in: employmentIds }, ...activeRange },
				orderBy: { norbital_created_at: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="employment_id"
					label="Employment"
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="base_salary" label="Base salary" />
				<Column name="pay_frequency" label="Frequency" card="badge" />
				<Column name="work_classification" label="Classification" />
				<Column name="employment_type" label="Type" />
				<Column name="rest_day" label="Rest day" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet statutoryFacts()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">
			Select a legal entity to manage statutory registrations for its employments.
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="employment_statutory_facts"
			view={`hr_controller:people:statutory-facts:${selectedCompanyId}`}
			title="Statutory registrations"
			description="Per-employment registration status against regime contributions — scoped to the selected legal entity."
			query={{
				where: { employment_id: { in: employmentIds }, ...activeRange },
				orderBy: { norbital_created_at: 'desc' }
			}}
			searchPlaceholder="Search statutory facts…"
		>
			{#snippet columns({ Column })}
				<Column
					name="employment_id"
					label="Employment"
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="statutory_contribution_id"
					label="Contribution"
					card="subtitle"
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (contributionLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="status"
					label="Registration"
					render={({ value }) => formatStatutoryFactStatus(value)}
				/>
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

<svelte:head>
	<title>People</title>
	<meta
		name="description"
		content="Manage the employee directory, employment history, contractual terms, and workforce health"
	/>
	<meta name="pod:icon" content="lucide:users" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="People"
		description="Keep personal details separate from legal engagements, contractual terms, and dated changes — scoped to one legal entity."
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
			{ name: 'directory', label: 'Directory', icon: 'lucide:users', content: directory },
			{ name: 'employments', label: 'Employments', icon: 'lucide:briefcase', content: engagements },
			{ name: 'terms', label: 'Terms', icon: 'lucide:file-signature', content: terms },
			{
				name: 'statutory-facts',
				label: 'Statutory facts',
				icon: 'lucide:id-card',
				content: statutoryFacts
			}
		] satisfies TabConfig[]}
	/>
</Cover>
