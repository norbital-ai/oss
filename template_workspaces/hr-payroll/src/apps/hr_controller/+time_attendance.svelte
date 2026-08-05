<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { startOfIsoWeekDate, todayKey } from '../../lib/ui/calendar.js';
	import { runWorkbookImport } from '../../lib/ui/workbook-import.js';
	import { timeEntryImportPayload } from '../../collections/time_entries/lib/import-workbook.js';

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
	// The employment column holds a uuid. Employee numbers are resolved from one loaded set rather
	// than a lookup mounted per row, and a miss renders as an em dash.
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery?.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);
	const recentEntriesQuery = $derived(
		selectedCompanyId == null || employmentIds.length === 0
			? null
			: client.db.time_entries.findMany({
					where: { employment_id: { in: employmentIds } },
					orderBy: { work_date: 'desc' },
					limit: 500
				})
	);
	/** An exception is a day whose clock never closed — payroll cannot measure hours from it. */
	const attendanceTrend = $derived.by(() => {
		const entries = (recentEntriesQuery?.current ?? []).flatMap((entry) => {
			const week = startOfIsoWeekDate(entry.work_date);
			return week
				? [{ week, incomplete: entry.state === 'OPEN' || !entry.clock_in || !entry.clock_out }]
				: [];
		});
		return [...new Set(entries.map((entry) => entry.week))]
			.toSorted((left, right) => left.localeCompare(right))
			.slice(-8)
			.map((week) => {
				const weekEntries = entries.filter((entry) => entry.week === week);
				return {
					week,
					exceptionRate: weekEntries.filter((entry) => entry.incomplete).length / weekEntries.length
				};
			});
	});
	const attendanceChart = $derived({
		kind: 'line',
		loading: recentEntriesQuery?.loading ?? false,
		title: 'Weekly attendance exception rate',
		description:
			'Open or incomplete punches as a share of recorded attendance over the latest eight weeks.',
		data: attendanceTrend,
		xKey: 'week',
		series: ['exceptionRate'],
		config: {
			exceptionRate: { label: 'Exception rate', color: 'var(--color-destructive)' }
		},
		valueFormat: { style: 'percent', maximumFractionDigits: 1 },
		curve: 'linear'
	} satisfies ChartDisplaySpec);
</script>

<svelte:head>
	<title>Time &amp; Attendance</title>
	<meta
		name="description"
		content="Review missing punches, schedule mismatches, time entries, and overtime"
	/>
	<meta name="pod:icon" content="lucide:clock-3" />
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
	<Grid gap="xl" minimum="panel">
		<Stack gap="md">
			<div>
				<h2 class="text-lg font-semibold">Attendance readiness</h2>
				<p class="text-sm text-muted-foreground">
					A CLOSED entry with both stamps can be measured into payroll. State only describes the
					clock. Overtime authorised is the separate day-level decision that lets a clock overrun
					reach payroll; the platform approval stamp governs edits to the whole attendance row.
				</p>
			</div>
		</Stack>
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">
				Select a legal entity to load its attendance trend.
			</p>
		{:else}
			<Display
				spec={attendanceChart}
				class="min-h-[18rem] rounded-lg border bg-card p-4 shadow-card"
			/>
		{/if}
	</Grid>
{/snippet}

{#snippet entries()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to review its time entries.</p>
	{:else}
		<CollectionTable
			{client}
			collection="time_entries"
			view={`hr_controller:time_attendance:entries:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { work_date: 'desc' }
			}}
			searchPlaceholder="Search time entries…"
			importPipelines={[
				{
					id: 'time-entry-workbook',
					label: 'Time entry workbook',
					description:
						'Import clock punches from the time-entries template — one row per person per day on its "Time entries" sheet, read as local wall time in the zone its "Settings" sheet names.',
					icon: 'lucide:clock-arrow-up',
					run: async () => {
						await runWorkbookImport({
							collectionName: 'time_entries',
							recordLabel: 'time entries',
							buildPayload: timeEntryImportPayload
						});
					}
				}
			]}
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
				<Column name="clock_in" label="Clock in" />
				<Column name="clock_out" label="Clock out" />
				<Column name="break_minutes" label="Break (min)" />
				<Column name="overtime_authorized" label="OT authorised" />
				<Column name="overtime_in" label="OT in" />
				<Column name="overtime_out" label="OT out" />
				<Column name="state" label="State" card="badge" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Time &amp; Attendance"
		description="Compare actual clocks with the rostered shift before they reach payroll — scoped to one legal entity."
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
			{ name: 'entries', label: 'Entries', icon: 'lucide:clock-3', content: entries }
		] satisfies TabConfig[]}
	/>
</Cover>
