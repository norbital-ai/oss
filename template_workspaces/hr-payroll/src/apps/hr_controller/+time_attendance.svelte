<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Display, type ChartDisplaySpec } from '@norbital-ai/ui/chart';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { startOfIsoWeekDate, todayKey, todayInstant } from '../../lib/ui/calendar.js';
	import {
		formatCalendarDate,
		formatDurationHours,
		formatInstant
	} from '../../lib/ui/display-formatters.js';
	import { runWorkbookImport } from '../../lib/ui/workbook-import.js';
	import { timeEntryImportPayload } from '../../collections/time_entries/lib/import-workbook.js';

	const { t } = useI18n<TenantI18nKeys>();

	let companyId = $state<string | null>(null);
	const today = todayKey();
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;

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
		title: t('app.time_attendance.chart_title'),
		description: t('app.time_attendance.chart_description'),
		data: attendanceTrend,
		xKey: 'week',
		series: ['exceptionRate'],
		config: {
			exceptionRate: {
				label: t('app.time_attendance.chart_exception_rate'),
				color: 'var(--color-destructive)'
			}
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
		<span class="font-medium text-muted-foreground">{t('component.legal_entity')}</span>
		<Inline gap="sm">
			<Combobox
				ariaLabel={t('component.legal_entity')}
				options={companyOptions}
				value={selectedCompanyId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						companyId = value;
						return;
					}
					companyId = companies[0]?.norbital_id ?? null;
				}}
				emptyPlaceholder={t('component.select_legal_entity')}
				searchPlaceholder={t('component.search_companies')}
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
				<h2 class="text-lg font-semibold">{t('app.time_attendance.attendance_readiness')}</h2>
				<p class="text-sm text-muted-foreground">
					{t('app.time_attendance.attendance_readiness_description')}
				</p>
			</div>
		</Stack>
		{#if selectedCompanyId == null}
			<p class="text-sm text-muted-foreground">
				{t('app.time_attendance.empty_overview')}
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
		<p class="text-sm text-muted-foreground">{t('app.time_attendance.empty_entries')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="time_entries"
			view={`hr_controller:time_attendance:entries:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { work_date: 'desc' }
			}}
			searchPlaceholder={t('app.time_attendance.search_entries')}
			importPipelines={[
				{
					id: 'time-entry-workbook',
					label: t('app.time_attendance.import_pipeline'),
					description: t('app.time_attendance.import_pipeline_description'),
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
				<Column
					name="work_date"
					label={t('component.work_date')}
					card="title"
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column
					name="employment_id"
					label={t('component.employment')}
					card="subtitle"
					render={({ value }) =>
						value == null || value === '' ? '—' : (employmentLabelsById.get(String(value)) ?? '—')}
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
				<Column
					name="break_minutes"
					label={t('app.time_attendance.break_hours')}
					render={({ value }) => formatDurationHours(value)}
				/>
				<Column
					name="overtime_in"
					label={t('app.time_attendance.ot_in')}
					render={({ value }) => formatInstant(value)}
				/>
				<Column
					name="overtime_out"
					label={t('app.time_attendance.ot_out')}
					render={({ value }) => formatInstant(value)}
				/>
				<Column name="state" label={t('component.state')} card="badge" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.time_attendance.eyebrow')}
		title={t('app.time_attendance.header_title')}
		description={t('app.time_attendance.header_description')}
		actions={companyScopeActions}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'overview',
				label: t('component.tab_overview'),
				icon: 'lucide:chart-no-axes-combined',
				content: overview
			},
			{
				name: 'entries',
				label: t('app.time_attendance.tab_entries'),
				icon: 'lucide:clock-3',
				content: entries
			}
		] satisfies TabConfig[]}
	/>
</Cover>
