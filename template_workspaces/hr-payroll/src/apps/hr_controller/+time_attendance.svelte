<script lang="ts">
	import { client } from '$pod/client';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Grid } from '@norbital-ai/ui/layout';
	import { startOfIsoWeekDate } from '../../lib/ui/calendar.js';

	const recentEntriesQuery = client.db.time_entries.findMany({
		orderBy: { work_date: 'desc' },
		limit: 500
	});
	// The employment column holds a uuid. Employee numbers are resolved from one loaded set rather
	// than a lookup mounted per row, and a miss falls back to the raw id rather than to nothing.
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
	/** An exception is a day whose clock never closed — payroll cannot measure hours from it. */
	const attendanceTrend = $derived.by(() => {
		const entries = (recentEntriesQuery.current ?? []).flatMap((entry) => {
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
		loading: recentEntriesQuery.loading,
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

{#snippet overview()}
	<Grid gap="xl" minimum="panel">
		<div class="space-y-4">
			<div>
				<h2 class="text-lg font-semibold">Attendance readiness</h2>
				<p class="text-sm text-muted-foreground">
					A CLOSED entry with both stamps can be measured into payroll. State only describes the
					clock. Overtime authorised is the separate day-level decision that lets a clock overrun
					reach payroll; the platform approval stamp governs edits to the whole attendance row.
				</p>
			</div>
		</div>
		<div class="rounded-lg border bg-card p-4 shadow-card">
			<Display spec={attendanceChart} class="min-h-[18rem]" />
		</div>
	</Grid>
{/snippet}

{#snippet entries()}
	<CollectionTable
		{client}
		collection="time_entries"
		query={{ orderBy: { work_date: 'desc' } }}
		searchPlaceholder="Search time entries…"
	>
		{#snippet columns({ Column })}
			<Column name="work_date" label="Work date" card="title" />
			<Column
				name="employment_id"
				label="Employment"
				card="subtitle"
				render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
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
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Time &amp; Attendance"
		description="Compare actual clocks with the rostered shift before they reach payroll."
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
