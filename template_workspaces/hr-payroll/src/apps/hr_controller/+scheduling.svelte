<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Columns, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { formatHolidayScope } from '../../lib/ui/display-formatters.js';
	import { monthKey, todayKey } from '../../lib/ui/calendar.js';

	let companyId = $state<string | null>(null);
	const today = todayKey();
	const currentMonth = monthKey(today);
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
	const shiftsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.shift_definitions.findMany({
					where: {
						norbital_approval_id: { isNull: true },
						company_id: { eq: selectedCompanyId },
						...activeRange
					},
					limit: 200
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
	const shiftLabelsById = $derived(
		new Map(
			(shiftsQuery?.current ?? []).map((shift) => [
				shift.norbital_id,
				`${shift.code} · ${shift.name}`
			])
		)
	);

	const rosterQuery = $derived(
		selectedCompanyId == null || employmentIds.length === 0
			? null
			: client.db.roster_entries.findMany({
					where: {
						norbital_approval_id: { isNull: true },
						employment_id: { in: employmentIds }
					},
					orderBy: { work_date: 'desc' },
					limit: 1000
				})
	);

	const monthEntries = $derived(
		(rosterQuery?.current ?? []).filter((entry) => monthKey(entry.work_date) === currentMonth)
	);
	const rosteredPeople = $derived(new Set(monthEntries.map((entry) => entry.employment_id)).size);
	const shiftUsage = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of monthEntries) {
			const shiftId = entry.shift_definition_id;
			const label =
				shiftId == null || shiftId === '' ? '—' : (shiftLabelsById.get(String(shiftId)) ?? '—');
			if (label === '—') continue;
			counts.set(label, (counts.get(label) ?? 0) + 1);
		}
		return [...counts].toSorted((left, right) => right[1] - left[1]);
	});
</script>

<svelte:head>
	<title>Scheduling</title>
	<meta
		name="description"
		content="Manage shift definitions, the monthly roster, and the company holiday calendar"
	/>
	<meta name="pod:icon" content="lucide:calendar-clock" />
</svelte:head>

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

{#snippet overview()}
	<Stack gap="lg">
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">Select a legal entity to load its roster.</p>
		{:else}
			<Stack as="section" gap="sm" aria-labelledby="roster-summary-heading">
				<div>
					<h2 id="roster-summary-heading" class="text-lg font-semibold">This month's roster</h2>
					<p class="text-sm text-muted-foreground">
						A roster entry is optional: staff on a fixed week have none, and the day type is derived
						from the company holidays and the term's rest day rather than stored.
					</p>
				</div>
				<!-- stupidity:allow UI10 -- 1px hairline gutters via bg-border are not on the gap scale -->
				<Columns count={2} gap="none" class="gap-px rounded-lg border bg-border">
					<Stack gap="none" class="bg-card p-4">
						<p class="text-xs font-medium text-muted-foreground">
							Rostered days ({currentMonth})
						</p>
						<p class="text-2xl font-semibold tabular-nums">{monthEntries.length}</p>
					</Stack>
					<Stack gap="none" class="bg-card p-4">
						<p class="text-xs font-medium text-muted-foreground">People on a roster</p>
						<p class="text-2xl font-semibold tabular-nums">{rosteredPeople}</p>
					</Stack>
				</Columns>
			</Stack>
			<Stack as="section" gap="sm" aria-labelledby="shift-usage-heading">
				<h3 id="shift-usage-heading" class="text-sm font-semibold">Shift usage</h3>
				<div class="rounded-lg border">
					{#if rosterQuery?.loading || shiftsQuery?.loading}
						<p class="p-5 text-sm text-muted-foreground">Loading the roster…</p>
					{:else if shiftUsage.length === 0}
						<p class="p-5 text-sm text-muted-foreground">No roster entries this month.</p>
					{:else}
						<!-- stupidity:allow UI3 -- a derived per-shift tally is not collection data. -->
						<table class="w-full text-left text-sm">
							<thead class="bg-muted/40 text-xs text-muted-foreground">
								<tr>
									<th class="px-3 py-2 font-semibold">Shift</th>
									<th class="px-3 py-2 text-right font-semibold">Rostered days</th>
								</tr>
							</thead>
							<tbody class="divide-y">
								{#each shiftUsage as [label, count] (label)}
									<tr>
										<td class="px-3 py-2.5">{label}</td>
										<td class="px-3 py-2.5 text-right tabular-nums">{count}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			</Stack>
		{/if}
	</Stack>
{/snippet}

{#snippet roster()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its roster.</p>
	{:else}
		<CollectionTable
			{client}
			collection="roster_entries"
			view={`hr_controller:scheduling:roster:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { work_date: 'desc' }
			}}
			searchPlaceholder="Search roster entries…"
		>
			{#snippet columns({ Column })}
				<Column name="work_date" label="Work date" card="title" />
				<Column
					name="employment_id"
					label="Employment"
					card="subtitle"
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
				/>
				<Column
					name="shift_definition_id"
					label="Underlying shift"
					render={({ value }) =>
						value == null || value === '' ? '—' : (shiftLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="assignment_code" label="Roster code" />
				<Column name="designation" label="Day type" card="badge" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet shifts()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its shifts.</p>
	{:else}
		<CollectionTable
			{client}
			collection="shift_definitions"
			view={`hr_controller:scheduling:shifts:${selectedCompanyId}`}
			query={{
				where: {
					company_id: { eq: selectedCompanyId },
					...activeRange
				},
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder="Search shifts…"
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="start_time" label="Start" />
				<Column name="end_time" label="End" />
				<Column name="break_minutes" label="Break (min)" />
				<Column name="pays_overtime" label="OT eligible" />
				<Column name="overtime_break_minutes" label="OT break (min)" />
				<Column name="crosses_midnight" label="Crosses midnight" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet holidays()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its holidays.</p>
	{:else}
		<CollectionTable
			{client}
			collection="company_holidays"
			view={`hr_controller:scheduling:holidays:${selectedCompanyId}`}
			query={{
				where: { company_id: { eq: selectedCompanyId } },
				orderBy: { date: 'desc' }
			}}
			searchPlaceholder="Search holidays…"
		>
			{#snippet columns({ Column })}
				<Column name="date" label="Date" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="scope" label="Scope" render={({ value }) => formatHolidayScope(value)} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Scheduling"
		description="Reusable shift definitions, explicit monthly rosters for shift workers, and the holiday calendar that makes a day a public holiday — scoped to one legal entity."
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
			{ name: 'roster', label: 'Monthly roster', icon: 'lucide:calendar-clock', content: roster },
			{ name: 'shifts', label: 'Shift definitions', icon: 'lucide:clock-4', content: shifts },
			{ name: 'holidays', label: 'Holidays', icon: 'lucide:party-popper', content: holidays }
		] satisfies TabConfig[]}
	/>
</Cover>
