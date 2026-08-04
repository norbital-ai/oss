<script lang="ts">
	import { client } from '$pod/client';
	import { downloadCollectionExport } from '@norbital-ai/pod/client';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import ApprovalSummaryTable from '../../lib/ui/approval-summary-table.svelte';
	import { daysBetweenKeys, payDateFor, periodWindow, todayKey } from '../../lib/ui/calendar.js';

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
					attendance: run ? `${run.attendance_from} → ${run.attendance_to}` : null
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
		if (row.status === 'late') return days === 0 ? 'Due today' : `${Math.abs(days)}d late`;
		if (days <= 0) return 'Due today';
		if (days === 1) return 'Due tomorrow';
		return `In ${days} days`;
	}

	function statusLabel(status: CycleRow['status']): string {
		switch (status) {
			case 'late':
				return 'Late';
			case 'current':
				return 'Current';
			case 'next':
				return 'Upcoming';
			default:
				return status satisfies never;
		}
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

{#snippet overview()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load payroll cycles.</p>
	{:else}
		<Grid minimum="card">
			<Stack as="section" gap="md" aria-labelledby="payroll-cycles-heading">
				<Inline align="end" justify="between" gap="md">
					<Stack gap="xs">
						<h2 id="payroll-cycles-heading" class="text-lg font-semibold">Payroll cycles</h2>
						<p class="text-sm text-muted-foreground">
							Pay dates from the company's pay day. Late means the pay date passed without a paid
							run.
						</p>
					</Stack>
					<p class="shrink-0 text-sm text-muted-foreground">
						{#if lateCount > 0}
							<span class="font-medium text-destructive">{lateCount} late</span>
							·
						{/if}
						{draftRunCount} draft run{draftRunCount === 1 ? '' : 's'}
					</p>
				</Inline>
				<div class="rounded-lg border">
					{#if companiesQuery.loading || payrollRunsQuery?.loading}
						<div class="p-5 text-sm text-muted-foreground">Loading payroll cycles…</div>
					{:else if cycleBoard.length === 0}
						<div class="p-5 text-sm text-muted-foreground">
							No open payroll cycles. Configure a company pay day, or every period is already paid.
						</div>
					{:else}
						<!-- stupidity:allow UI3 -- derived pay dates are not collection records. -->
						<table class="w-full text-left text-sm">
							<thead class="bg-muted/40 text-xs text-muted-foreground">
								<tr>
									<th class="px-3 py-2 font-semibold">Status</th>
									<th class="px-3 py-2 font-semibold">Pay date</th>
									<th class="px-3 py-2 font-semibold">Period</th>
									<th class="px-3 py-2 font-semibold">Attendance</th>
									<th class="px-3 py-2 font-semibold">Run</th>
									<th class="px-3 py-2 text-right font-semibold">Timing</th>
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
											{new Date(`${row.payDate}T00:00:00.000Z`).toLocaleDateString()}
										</td>
										<td class="px-3 py-2.5 tabular-nums">{row.period}</td>
										<td class="px-3 py-2.5 text-muted-foreground">{row.attendance ?? '—'}</td>
										<td class="px-3 py-2.5">{row.runState ?? 'Not started'}</td>
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
					title="Payroll decisions"
					asOfDate={analytics.as_of_date}
					summary={analytics.summary}
					pendingLabel="Yet to approve"
					note="Draft runs and runs held by an approval request count as yet to approve; paid runs count as approved. Speed is the mean completed workflow duration this year."
				/>
			</Stack>
		</Grid>
	{/if}
{/snippet}

{#snippet runs()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to review its payroll runs.</p>
	{:else}
		<CollectionTable
			{client}
			collection="payroll_runs"
			view={`hr_controller:payroll:runs:${selectedCompanyId}`}
			title="Payroll runs"
			description="Review payslips against their shared run-level policy snapshot, reconcile totals, export, and pay."
			query={{
				where: { company_id: { eq: selectedCompanyId } },
				orderBy: { period: 'desc' }
			}}
			exportPipelines={[
				{
					id: 'bank-files',
					label: 'Bank files',
					description:
						'Download bank instructions from stored payslips and the effective employment bank details.',
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'bank-files' }
						);
						if (manifest.length === 0)
							throw new Error('The selected payroll has no bank payments to download.');
					}
				},
				{
					id: 'payslip-pdfs',
					label: 'Payslip PDFs',
					description: 'Download employee payslips for any selected run with built results.',
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'payslip-pdfs' }
						);
						if (manifest.length === 0)
							throw new Error('The selected payroll runs do not contain built payslips yet.');
					}
				},
				{
					id: 'payroll-report-xlsx',
					label: 'Payroll workbook',
					description: 'Download the clean Infotech-style salary listing and complete breakdown.',
					requiresSelection: true,
					run: async ({ selectedRows }) => {
						const manifest = await downloadCollectionExport(
							{
								collection_name: 'payroll_runs',
								record_ids: selectedRows.map((record) => record.norbital_id)
							},
							{ includeAction: (action) => action.metadata?.kind === 'payroll-report-xlsx' }
						);
						if (manifest.length === 0)
							throw new Error('The selected payroll runs do not contain built payslips yet.');
					}
				}
			]}
		>
			{#snippet columns({ Column })}
				<Column name="period" label="Period" card="title" />
				<Column name="lifecycle" label="Lifecycle" card="badge" />
				<Column name="pay_date" label="Pay date" />
				<Column name="configuration_snapshot" label="Policy snapshot" />
			{/snippet}
			{#snippet ListCard(run)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{run.period}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{run.lifecycle}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">Pays {run.pay_date}</p>
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
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Payroll"
		description="Create a payroll run for a company period, resolve calculation blockers, then review and export employee results — scoped to one legal entity."
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
			{ name: 'runs', label: 'Payroll runs', icon: 'lucide:badge-dollar-sign', content: runs }
		] satisfies TabConfig[]}
	/>
</Cover>
