<script lang="ts">
	/**
	 * One payroll run: the window it was built against and the payslips it produced.
	 *
	 * The window, the configuration hash and the period are the engine's — they are shown, never
	 * edited, because a run that could be re-pointed after it was calculated would be untraceable.
	 * Draft recalculation and the final paid transition are explicit actions. Permission checks,
	 * approval locks, request-change reasons, and audit history belong to the platform.
	 */
	import { client } from '$pod/client';
	import { downloadCollectionExport } from '@norbital-ai/pod/client';
	import type { Row } from './$types.js';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cluster, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { toast } from 'svelte-sonner';
	import { formatCalendarDate, formatNumeric } from '../../lib/ui/display-formatters.js';

	let { record, refresh, close }: { record: Row; refresh(): Promise<void>; close(): void } =
		$props();
	let pendingAction = $state<'recalculate' | 'pay' | 'delete' | 'export' | null>(null);
	let lockArmed = $state(false);

	const companyQuery = $derived(
		client.db.companies.findFirst({ where: { norbital_id: { eq: record.company_id } } })
	);
	const company = $derived(companyQuery.current);
	const payslipCountQuery = $derived(
		client.db.payslips.count({ where: { payroll_run_id: { eq: record.norbital_id } } })
	);
	// A payslip's employment column holds a uuid. The run belongs to one company, so that company's
	// employments are the only ones the table below can show; the employee number is resolved from
	// that one set rather than by mounting a lookup per row, and a miss renders as an em dash.
	const employmentsQuery = $derived(
		client.db.employments.findMany({
			where: { company_id: { eq: record.company_id }, norbital_approval_id: { isNull: true } },
			limit: 1000
		})
	);
	const employmentLabelsById = $derived(
		new Map(
			(employmentsQuery.current ?? []).map((employment) => [
				employment.norbital_id,
				employment.employee_number
			])
		)
	);

	async function updateDraft(action: 'recalculate' | 'pay'): Promise<void> {
		const update = client.db.payroll_runs.update;
		if (!update) {
			toast.error('Payroll runs cannot be updated in this workspace.');
			return;
		}
		pendingAction = action;
		try {
			await update(record.norbital_id, {
				lifecycle: action === 'pay' ? 'PAID' : 'DRAFT'
			});
			toast.success(action === 'pay' ? 'Payroll marked as paid.' : 'Draft payroll recalculated.');
			void refresh().catch(() => {
				toast.error('Payroll updated, but the detail did not refresh.');
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Payroll update failed.');
		} finally {
			pendingAction = null;
		}
	}

	async function downloadReport(): Promise<void> {
		pendingAction = 'export';
		try {
			const manifest = await downloadCollectionExport(
				{ collection_name: 'payroll_runs', record_ids: [record.norbital_id] },
				{ includeAction: (action) => action.metadata?.kind === 'payroll-report-xlsx' }
			);
			if (manifest.length === 0) throw new Error('Build this run before exporting its report.');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Payroll report export failed.');
		} finally {
			pendingAction = null;
		}
	}

	async function deleteDraft(): Promise<void> {
		const remove = client.db.payroll_runs.delete;
		if (!remove) {
			toast.error('Payroll runs cannot be deleted in this workspace.');
			return;
		}
		pendingAction = 'delete';
		try {
			await remove(record.norbital_id);
			toast.success(`Draft payroll ${record.period} deleted.`);
			close();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Payroll run deletion failed.');
		} finally {
			pendingAction = null;
		}
	}
</script>

<Stack gap="lg">
	<Stack as="section" gap="sm" aria-label="Payroll run summary">
		<Cluster align="start" justify="between" gap="sm">
			<Stack gap="none" class="min-w-0">
				<h2 class="truncate text-lg font-semibold">{company?.name ?? 'Company'}</h2>
				<p class="text-sm text-muted-foreground">
					Period {record.period} · {payslipCountQuery.current ?? 0} payslips
				</p>
			</Stack>
			<Inline gap="xs" justify="end" shrink={false}>
				<span class="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
					{record.lifecycle}
				</span>
				{#if record.lifecycle === 'DRAFT' && client.db.payroll_runs.update}
					<Button
						variant="outline"
						size="sm"
						disabled={pendingAction !== null}
						onclick={downloadReport}
					>
						{pendingAction === 'export' ? 'Exporting…' : 'Export salary listing'}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={pendingAction !== null}
						onclick={() => updateDraft('recalculate')}
					>
						{pendingAction === 'recalculate' ? 'Recalculating…' : 'Recalculate draft'}
					</Button>
					<Button
						size="sm"
						disabled={pendingAction !== null}
						onclick={() => {
							if (!lockArmed) {
								lockArmed = true;
								return;
							}
							void updateDraft('pay');
						}}
					>
						{pendingAction === 'pay'
							? 'Locking…'
							: lockArmed
								? 'Confirm lock & pay'
								: 'Lock payroll'}
					</Button>
					{#if client.db.payroll_runs.delete}
						<Button
							variant="outline"
							size="sm"
							disabled={pendingAction !== null}
							onclick={deleteDraft}
						>
							{pendingAction === 'delete' ? 'Deleting…' : 'Delete draft'}
						</Button>
					{/if}
				{/if}
			</Inline>
		</Cluster>
		<Grid as="dl" gap="sm" minimum="compact">
			<div>
				<dt class="text-xs text-muted-foreground">Attendance window</dt>
				<dd class="mt-1 font-medium tabular-nums">
					{formatCalendarDate(record.attendance_from)} → {formatCalendarDate(record.attendance_to)}
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Pay date</dt>
				<dd class="mt-1 font-medium tabular-nums">{formatCalendarDate(record.pay_date)}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">Run-level configuration snapshot</dt>
				<dd class="mt-1 text-sm font-medium">
					{record.configuration_snapshot?.kind === 'CAPTURED'
						? 'Captured at run time'
						: 'Legacy snapshot'}
				</dd>
			</div>
		</Grid>
	</Stack>

	{#if lockArmed && record.lifecycle === 'DRAFT'}
		<p class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
			Locking marks this payroll paid and makes its snapshot and payslips immutable. Select “Confirm
			lock & pay” to continue.
		</p>
	{/if}

	<Stack as="section" gap="sm" aria-labelledby="run-payslips-heading">
		<h3 id="run-payslips-heading" class="text-sm font-semibold">Payslips</h3>
		<Bound size="tall">
			<CollectionTable
				{client}
				collection="payslips"
				title="Payslips"
				description="Open a payslip for its direct component and statutory line breakdown."
				features={{ create: false }}
				query={{
					where: { payroll_run_id: { eq: record.norbital_id } },
					orderBy: { norbital_created_at: 'asc' },
					limit: 100
				}}
			>
				{#snippet columns({ Column })}
					<Column
						name="employment_id"
						label="Employee"
						card="title"
						render={({ value }) =>
							value == null || value === ''
								? '—'
								: (employmentLabelsById.get(String(value)) ?? '—')}
					/>
					<Column name="currency" card="badge" />
					<Column name="gross" render={({ value }) => formatNumeric(value)} />
					<Column
						name="total_deductions"
						label="Deductions"
						render={({ value }) => formatNumeric(value)}
					/>
					<Column name="net" card="subtitle" render={({ value }) => formatNumeric(value)} />
					<Column
						name="employer_cost"
						label="Employer cost"
						render={({ value }) => formatNumeric(value)}
					/>
				{/snippet}
			</CollectionTable>
		</Bound>
	</Stack>
</Stack>
