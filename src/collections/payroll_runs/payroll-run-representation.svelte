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
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { Row } from './$types.js';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cluster, Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { toast } from 'svelte-sonner';
	import { formatCalendarDate, formatNumeric } from '../../lib/ui/display-formatters.js';

	let { record, refresh, close }: { record: Row; refresh(): Promise<void>; close(): void } =
		$props();

	const { t } = useI18n<TenantI18nKeys>();

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
			toast.error(t('component.cannot_update'));
			return;
		}
		pendingAction = action;
		try {
			await update(record.norbital_id, {
				lifecycle: action === 'pay' ? 'PAID' : 'DRAFT'
			});
			toast.success(action === 'pay' ? t('component.marked_paid') : t('component.recalculated'));
			void refresh().catch(() => {
				toast.error(t('component.no_refresh'));
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('component.update_failed'));
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
			if (manifest.length === 0) throw new Error(t('component.build_before_export'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('component.export_failed'));
		} finally {
			pendingAction = null;
		}
	}

	async function deleteDraft(): Promise<void> {
		const remove = client.db.payroll_runs.delete;
		if (!remove) {
			toast.error(t('component.cannot_delete'));
			return;
		}
		pendingAction = 'delete';
		try {
			await remove(record.norbital_id);
			toast.success(t('component.draft_deleted', { period: record.period }));
			close();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('component.delete_failed'));
		} finally {
			pendingAction = null;
		}
	}
</script>

<Stack gap="lg">
	<Stack as="section" gap="sm" aria-label={t('component.payroll_run_summary')}>
		<Cluster align="start" justify="between" gap="sm">
			<Stack gap="none" class="min-w-0">
				<h2 class="truncate text-lg font-semibold">{company?.name ?? t('component.company')}</h2>
				<p class="text-sm text-muted-foreground">
					{t('component.period_line', {
						period: record.period,
						count: payslipCountQuery.current ?? 0
					})}
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
						{pendingAction === 'export'
							? t('component.exporting')
							: t('component.export_salary_listing')}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={pendingAction !== null}
						onclick={() => updateDraft('recalculate')}
					>
						{pendingAction === 'recalculate'
							? t('component.recalculating')
							: t('component.recalculate_draft')}
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
							? t('component.locking')
							: lockArmed
								? t('component.confirm_lock_pay')
								: t('component.lock_payroll')}
					</Button>
					{#if client.db.payroll_runs.delete}
						<Button
							variant="outline"
							size="sm"
							disabled={pendingAction !== null}
							onclick={deleteDraft}
						>
							{pendingAction === 'delete' ? t('component.deleting') : t('component.delete_draft')}
						</Button>
					{/if}
				{/if}
			</Inline>
		</Cluster>
		<Grid as="dl" gap="sm" minimum="compact">
			<div>
				<dt class="text-xs text-muted-foreground">{t('component.attendance_window')}</dt>
				<dd class="mt-1 font-medium tabular-nums">
					{formatCalendarDate(record.attendance_from)} → {formatCalendarDate(record.attendance_to)}
				</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">{t('app.payroll.pay_date')}</dt>
				<dd class="mt-1 font-medium tabular-nums">{formatCalendarDate(record.pay_date)}</dd>
			</div>
			<div>
				<dt class="text-xs text-muted-foreground">{t('component.run_snapshot')}</dt>
				<dd class="mt-1 text-sm font-medium">
					{record.configuration_snapshot?.kind === 'CAPTURED'
						? t('component.captured_at_run_time')
						: t('component.legacy_snapshot')}
				</dd>
			</div>
		</Grid>
	</Stack>

	{#if lockArmed && record.lifecycle === 'DRAFT'}
		<p class="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
			{t('component.lock_warning')}
		</p>
	{/if}

	<Stack as="section" gap="sm" aria-labelledby="run-payslips-heading">
		<h3 id="run-payslips-heading" class="text-sm font-semibold">{t('component.payslips')}</h3>
		<Bound size="tall">
			<CollectionTable
				{client}
				collection="payslips"
				title={t('component.payslips')}
				description={t('component.payslips_description')}
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
						label={t('component.employee')}
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
						label={t('component.deductions')}
						render={({ value }) => formatNumeric(value)}
					/>
					<Column name="net" card="subtitle" render={({ value }) => formatNumeric(value)} />
					<Column
						name="employer_cost"
						label={t('component.employer_cost')}
						render={({ value }) => formatNumeric(value)}
					/>
				{/snippet}
			</CollectionTable>
		</Bound>
	</Stack>
</Stack>
