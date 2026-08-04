<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Columns, Cover, Stack } from '@norbital-ai/ui/layout';
	import { formatHolidayScope } from '../../lib/ui/display-formatters.js';
	import { monthKey, todayKey } from '../../lib/ui/calendar.js';

	const today = todayKey();
	const currentMonth = monthKey(today);
	const rosterQuery = client.db.roster_entries.findMany({
		where: { norbital_approval_id: { isNull: true } },
		orderBy: { work_date: 'desc' },
		limit: 1000
	});
	const shiftsQuery = client.db.shift_definitions.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	// A relation column holds a uuid. The shift, employment and company labels are resolved from
	// these loaded sets rather than by mounting a lookup per row, and a miss falls back to the raw
	// id so an unloaded label never reads as missing data.
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
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const companyLabelsById = $derived(
		new Map((companiesQuery.current ?? []).map((company) => [company.norbital_id, company.name]))
	);
	const shiftLabelsById = $derived(
		new Map(
			(shiftsQuery.current ?? []).map((shift) => [
				shift.norbital_id,
				`${shift.code} · ${shift.name}`
			])
		)
	);
	const monthEntries = $derived(
		(rosterQuery.current ?? []).filter((entry) => monthKey(entry.work_date) === currentMonth)
	);
	const rosteredPeople = $derived(new Set(monthEntries.map((entry) => entry.employment_id)).size);
	const shiftUsage = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const entry of monthEntries) {
			const label = shiftLabelsById.get(entry.shift_definition_id) ?? 'Unknown shift';
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

{#snippet overview()}
	<Stack gap="lg">
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
					<p class="text-xs font-medium text-muted-foreground">Rostered days ({currentMonth})</p>
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
				{#if rosterQuery.loading || shiftsQuery.loading}
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
	</Stack>
{/snippet}

{#snippet roster()}
	<CollectionTable
		{client}
		collection="roster_entries"
		query={{ orderBy: { work_date: 'desc' } }}
		searchPlaceholder="Search roster entries…"
	>
		{#snippet columns({ Column })}
			<Column name="work_date" label="Work date" card="title" />
			<Column
				name="employment_id"
				label="Employment"
				card="subtitle"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
			/>
			<Column
				name="shift_definition_id"
				label="Underlying shift"
				render={({ value }) => shiftLabelsById.get(String(value)) ?? value}
			/>
			<Column name="assignment_code" label="Roster code" />
			<Column name="designation" label="Day type" card="badge" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet shifts()}
	<CollectionTable
		{client}
		collection="shift_definitions"
		query={{ orderBy: { code: 'asc' } }}
		searchPlaceholder="Search shifts…"
	>
		{#snippet columns({ Column })}
			<Column name="code" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="company_id"
				label="Company"
				render={({ value }) => companyLabelsById.get(String(value)) ?? value}
			/>
			<Column name="start_time" label="Start" />
			<Column name="end_time" label="End" />
			<Column name="break_minutes" label="Break (min)" />
			<Column name="pays_overtime" label="OT eligible" />
			<Column name="overtime_break_minutes" label="OT break (min)" />
			<Column name="crosses_midnight" label="Crosses midnight" />
			<Column name="effective_range" label="Effective" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet holidays()}
	<CollectionTable
		{client}
		collection="company_holidays"
		query={{ orderBy: { date: 'desc' } }}
		searchPlaceholder="Search holidays…"
	>
		{#snippet columns({ Column })}
			<Column name="date" label="Date" card="title" />
			<Column name="name" card="subtitle" />
			<Column
				name="company_id"
				label="Company"
				render={({ value }) => companyLabelsById.get(String(value)) ?? value}
			/>
			<Column name="scope" label="Scope" render={({ value }) => formatHolidayScope(value)} />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Scheduling"
		description="Reusable shift definitions, explicit monthly rosters for shift workers, and the holiday calendar that makes a day a public holiday."
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
