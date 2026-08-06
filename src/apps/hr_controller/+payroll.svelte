<script lang="ts">
	import { client } from '$pod/client';
	import { downloadCollectionExport } from '@norbital-ai/pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import { formatCalendarDate } from '../../lib/ui/display-formatters.js';
	import {
		daysBetweenKeys,
		payDateFor,
		periodWindow,
		todayKey,
		todayInstant
	} from '../../lib/ui/calendar.js';

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
	type PayrollCompanyRow = { norbital_id: string; pay_day: number };
	const selectedCompany = $derived(
		(companies.find((company) => company.norbital_id === selectedCompanyId) as
			PayrollCompanyRow | undefined) ?? null
	);

	const payrollRunsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.payroll_runs.findMany({
					where: { company_id: { eq: selectedCompanyId } },
					orderBy: { period: 'desc' },
					limit: 500
				})
	);

	interface CycleRow {
		period: string;
		payDate: string;
		status: 'late' | 'current' | 'next';
		runState: string | null;
		attendance: string | null;
	}

	/**
	 * Three months back, the current month and three ahead for the selected company. The pay date is
	 * the company's `pay_day` on that month's calendar; the attendance window shown is the one the
	 * engine actually stored on the run, never a second derivation of it.
	 */
	const cycleBoard = $derived.by((): CycleRow[] => {
		if (selectedCompanyId == null || selectedCompany == null) return [];
		const runByCycle = new Map((payrollRunsQuery?.current ?? []).map((run) => [run.period, run]));
		const open = periodWindow(7, 3)
			.map((period) => {
				const run = runByCycle.get(period);
				return {
					period,
					payDate: payDateFor(period, selectedCompany.pay_day),
					runState: run?.lifecycle ?? null,
					attendance: run
						? `${formatCalendarDate(run.attendance_from)} → ${formatCalendarDate(run.attendance_to)}`
						: null
				};
			})
			.filter((row) => row.runState !== 'PAID')
			.toSorted((left, right) => left.payDate.localeCompare(right.payDate));
		const currentIndex = open.findIndex((row) => row.payDate >= today);
		return open.map((row, index) => ({
			...row,
			status: row.payDate < today ? 'late' : index === currentIndex ? 'current' : ('next' as const)
		}));
	});

	const lateCount = $derived(cycleBoard.filter((row) => row.status === 'late').length);
	const draftRunCount = $derived(
		(payrollRunsQuery?.current ?? []).filter((run) => run.lifecycle === 'DRAFT').length
	);
	const analyticsQuery = client.invoke.approval_analytics({ subject: 'PAYROLL' });
	const analytics = $derived(
		analyticsQuery.current ?? {
			as_of_date: today,
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

	function timingLabel(row: CycleRow): string {
		const days = daysBetweenKeys(today, row.payDate);
		if (row.status === 'late') {
			return days === 0
				? t('app.payroll.due_today')
				: t('app.payroll.days_late', { days: Math.abs(days) });
		}
		if (days <= 0) return t('app.payroll.due_today');
		if (days === 1) return t('app.payroll.due_tomorrow');
		return t('app.payroll.in_days', { days });
	}

	function statusLabel(status: CycleRow['status']): string {
		switch (status) {
			case 'late':
				return t('app.payroll.status_late');
			case 'current':
				return t('app.payroll.status_current');
			case 'next':
				return t('app.payroll.status_upcoming');
			default:
				return status satisfies never;
		}
	}
</script>

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
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.payroll.empty_overview')}</p>
	{:else}
		<Grid minimum="card">
			<Stack as="section" gap="md" aria-labelledby="payroll-cycles-heading">
				<Inline align="end" justify="between" gap="md">
					<Stack gap="xs">
						<h2 id="payroll-cycles-heading" class="text-lg font-semibold">
							{t('app.payroll.payroll_cycles')}
						</h2>
						<p class="text-sm text-muted-foreground">
							{t('app.payroll.payroll_cycles_description')}
						</p>
					</Stack>
					<p class="shrink-0 text-sm text-muted-foreground">
						{#if lateCount > 0}
							<span class="font-medium text-destructive">
								{t('app.payroll.late_count', { count: lateCount })}
							</span>
							·
						{/if}
						{draftRunCount === 1
							? t('app.payroll.draft_run_one')
							: t('app.payroll.draft_runs_many', { count: draftRunCount })}
					</p>
				</Inline>
				<div class="rounded-lg border">
					{#if companiesQuery.loading || payrollRunsQuery?.loading}
						<div class="p-5 text-sm text-muted-foreground">{t('app.payroll.loading_cycles')}</div>
					{:else if cycleBoard.length === 0}
						<div class="p-5 text-sm text-muted-foreground">{t('app.payroll.no_open_cycles')}</div>
					{:else}
						<!-- stupidity:allow UI3 -- derived pay dates are not collection records. -->
						<table class="w-full text-left text-sm">
							<thead class="bg-muted/40 text-xs text-muted-foreground">
								<tr>
									<th class="px-3 py-2 font-semibold">{t('app.payroll.status')}</th>
									<th class="px-3 py-2 font-semibold">{t('app.payroll.pay_date')}</th>
									<th class="px-3 py-2 font-semibold">{t('app.payroll.period')}</th>
									<th class="px-3 py-2 font-semibold">{t('app.payroll.attendance')}</th>
									<th class="px-3 py-2 font-semibold">{t('app.payroll.run')}</th>
									<th class="px-3 py-2 text-right font-semibold">{t('app.payroll.timing')}</th>
								</tr>
							</thead>
							<tbody class="divide-y">
								{#each cycleBoard as row (row.period)}
									<tr
										class={row.status === 'late'
											? 'bg-destructive/5'
											: row.status === 'current'
												? 'bg-muted/30'
												: undefined}
									>
										<td class="px-3 py-2.5">
											<span
												class="rounded-full px-2 py-0.5 text-xs font-medium {row.status === 'late'
													? 'bg-destructive text-destructive-foreground'
													: row.status === 'current'
														? 'bg-foreground text-background'
														: 'bg-muted text-muted-foreground'}"
											>
												{statusLabel(row.status)}
											</span>
										</td>
										<td class="px-3 py-2.5 font-medium">
											{formatCalendarDate(row.payDate)}
										</td>
										<td class="px-3 py-2.5 tabular-nums">{row.period}</td>
										<td class="px-3 py-2.5 text-muted-foreground">{row.attendance ?? '—'}</td>
										<td class="px-3 py-2.5">{row.runState ?? t('app.payroll.not_started')}</td>
										<td class="px-3 py-2.5 text-right font-medium">{timingLabel(row)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			</Stack>
			<Stack gap="md">
				<ApprovalSummaryTable
					title={t('app.payroll.payroll_decisions')}
					asOfDate={analytics.as_of_date}
					summary={analytics.summary}
					pendingLabel={t('app.payroll.yet_to_approve')}
					note={t('app.payroll.payroll_decisions_note')}
				/>
			</Stack>
		</Grid>
	{/if}
{/snippet}

{#snippet runs()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">{t('app.payroll.empty_runs')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="payroll_runs"
			view={`hr_controller:payroll:runs:${selectedCompanyId}`}
			title={t('app.payroll.runs_title')}
			description={t('app.payroll.runs_description')}
			query={{
				where: { company_id: { eq: selectedCompanyId } },
				orderBy: { period: 'desc' }
			}}
			exportPipelines={[
				{
					id: 'bank-files',
					label: t('app.payroll.export_bank_files'),
					description: t('app.payroll.export_bank_files_description'),
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'bank-files' }
						);
						if (manifest.length === 0) throw new Error(t('app.payroll.export_bank_files_error'));
					}
				},
				{
					id: 'payslip-pdfs',
					label: t('app.payroll.export_payslip_pdfs'),
					description: t('app.payroll.export_payslip_pdfs_description'),
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'payslip-pdfs' }
						);
						if (manifest.length === 0) throw new Error(t('app.payroll.export_pdfs_error'));
					}
				},
				{
					id: 'payroll-report-xlsx',
					label: t('app.payroll.export_workbook'),
					description: t('app.payroll.export_workbook_description'),
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'payroll-report-xlsx' }
						);
						if (manifest.length === 0) throw new Error(t('app.payroll.export_pdfs_error'));
					}
				}
			]}
		>
			{#snippet columns({ Column })}
				<Column name="period" label={t('app.payroll.period')} card="title" />
				<Column name="lifecycle" label={t('app.payroll.lifecycle')} card="badge" />
				<Column
					name="pay_date"
					label={t('app.payroll.pay_date')}
					render={({ value }) => formatCalendarDate(value)}
				/>
				<Column name="configuration_snapshot" label={t('app.payroll.policy_snapshot')} />
			{/snippet}
			{#snippet ListCard(run)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{run.period}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{run.lifecycle}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">
					{t('app.payroll.pays_line', { date: formatCalendarDate(run.pay_date) })}
				</p>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

<svelte:head>
	<title>Payroll</title>
	<meta
		name="description"
		content="Create payroll runs, review payslips, export payments, and audit calculations"
	/>
	<meta name="pod:icon" content="lucide:badge-dollar-sign" />
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/hr-payroll/app-media/payroll-banner.svg"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/app-media/payroll-banner.svg"
	/>
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.payroll.eyebrow')}
		title={t('app.payroll.header_title')}
		description={t('app.payroll.header_description')}
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
				name: 'runs',
				label: t('app.payroll.tab_runs'),
				icon: 'lucide:badge-dollar-sign',
				content: runs
			}
		] satisfies TabConfig[]}
	/>
</Cover>
