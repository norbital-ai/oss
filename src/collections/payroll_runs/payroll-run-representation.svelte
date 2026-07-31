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
	import type { Row } from './$types.js';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { toast } from 'svelte-sonner';
	import { formatNumeric } from '../../lib/ui/display-formatters.js';

	let { record, refresh }: { record: Row; refresh(): Promise<void> } = $props();
	let pendingAction = $state<'recalculate' | 'pay' | null>(null);

	const companyQuery = $derived(
		client.db.companies.findFirst({ where: { norbital_id: { eq: record.company_id } } })
	);
	const company = $derived(companyQuery.current);
	const payslipCountQuery = $derived(
		client.db.payslips.count({ where: { payroll_run_id: { eq: record.norbital_id } } })
	);
	// A payslip's employment column holds a uuid. The run belongs to one company, so that company's
	// employments are the only ones the table below can show; the employee number is resolved from
	// that one set rather than by mounting a lookup per row, and a miss falls back to the raw id so
	// an unloaded label never reads as missing data.
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
			await refresh();
			toast.success(action === 'pay' ? 'Payroll marked as paid.' : 'Draft payroll recalculated.');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Payroll update failed.');
		} finally {
			pendingAction = null;
		}
	}
</script>

<Scroll name="Payroll run detail">
	<Stack gap="lg">
		<Stack as="section" gap="sm" aria-label="Payroll run summary">
			<Cluster align="start" justify="between" gap="sm">
				<Stack gap="none" class="min-w-0">
					<h2 class="truncate text-lg font-semibold">{company?.name ?? 'Company'}</h2>
					<p class="text-sm text-muted-foreground">
						Period {record.period} · {payslipCountQuery.current ?? 0} payslips
					</p>
				</Stack>
				<Inline gap="xs" justify="end" class="shrink-0">
					<span class="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">
						{record.lifecycle}
					</span>
					{#if record.lifecycle === 'DRAFT' && client.db.payroll_runs.update}
						<Button
							variant="outline"
							size="sm"
							disabled={pendingAction !== null}
							onclick={() => updateDraft('recalculate')}
						>
							{pendingAction === 'recalculate' ? 'Recalculating…' : 'Recalculate draft'}
						</Button>
						<Button size="sm" disabled={pendingAction !== null} onclick={() => updateDraft('pay')}>
							{pendingAction === 'pay' ? 'Marking paid…' : 'Mark paid'}
						</Button>
					{/if}
				</Inline>
			</Cluster>
			<Grid as="dl" gap="sm" minimum="compact">
				<div>
					<dt class="text-xs text-muted-foreground">Attendance window</dt>
					<dd class="mt-1 font-medium tabular-nums">
						{record.attendance_from} → {record.attendance_to}
					</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Pay date</dt>
					<dd class="mt-1 font-medium tabular-nums">{record.pay_date}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Configuration hash</dt>
					<dd class="mt-1 truncate font-mono text-xs">{record.configuration_hash}</dd>
				</div>
			</Grid>
		</Stack>

		<Stack as="section" gap="sm" aria-labelledby="run-payslips-heading">
			<h3 id="run-payslips-heading" class="text-sm font-semibold">Payslips</h3>
			<Bound size="tall">
				<CollectionTable
					{client}
					collection="payslips"
					title="Payslips"
					description="Open a payslip for its line items and the source records payroll consumed."
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
							render={({ value }) => employmentLabelsById.get(String(value)) ?? value}
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
</Scroll>
