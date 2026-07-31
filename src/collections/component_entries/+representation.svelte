<script lang="ts">
	/**
	 * One money event, and whether payroll has already consumed it.
	 *
	 * The consumption question is answered from the link rows, not from a column: an entry settles in
	 * the run for its own `pay_period`, so that run's payslip for this employment is the only
	 * candidate, and the entry is only truly consumed if one of that payslip's lines wrote a
	 * `COMPONENT_ENTRY` link back to it. Narrowing to the candidate first keeps this a bounded read
	 * instead of a scan of every link row in the tenant.
	 */
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import type { RepresentationProps } from './$types.js';
	import { linesConsumingEntry } from '../../lib/ui/payslip-sources.js';

	let { record, close }: RepresentationProps = $props();

	const employmentQuery = $derived(
		record
			? client.db.employments.findFirst({
					where: { norbital_id: { eq: record.employment_id } }
				})
			: null
	);
	const employment = $derived(employmentQuery?.current ?? null);

	// An entry with no pay_period settles outside payroll (COMPANY_DIRECT) and has no payslip.
	const runQuery = $derived(
		employment && record?.pay_period
			? client.db.payroll_runs.findFirst({
					where: {
						company_id: { eq: employment.company_id },
						period: { eq: record.pay_period },
						norbital_approval_id: { isNull: true }
					}
				})
			: null
	);
	const run = $derived(runQuery?.current ?? null);

	const payslipQuery = $derived(
		run && record
			? client.db.payslips.findFirst({
					where: {
						payroll_run_id: { eq: run.norbital_id },
						employment_id: { eq: record.employment_id }
					}
				})
			: null
	);
	const payslip = $derived(payslipQuery?.current ?? null);

	const linesQuery = $derived(
		payslip
			? client.db.payslip_lines.findMany({
					where: { payslip_id: { eq: payslip.norbital_id } },
					limit: 500
				})
			: null
	);
	const lineIds = $derived((linesQuery?.current ?? []).map((line) => line.norbital_id));
	const sourcesQuery = $derived(
		lineIds.length === 0
			? null
			: client.db.payslip_line_sources.findMany({
					where: { payslip_line_id: { in: lineIds } },
					limit: 2000
				})
	);

	const loading = $derived(
		Boolean(
			employmentQuery?.loading ||
			runQuery?.loading ||
			payslipQuery?.loading ||
			linesQuery?.loading ||
			sourcesQuery?.loading
		)
	);

	/**
	 * A human consumption label, but only once a line has actually claimed this entry. A drafted run
	 * that has not reached this entry yet must not read as though it had.
	 */
	const consumedByPayslip = $derived.by((): string => {
		if (!record) return '—';
		if (!record.pay_period) return 'Settled outside payroll';
		if (loading) return 'Loading…';
		if (!payslip) return '—';
		const claimed = linesConsumingEntry(sourcesQuery?.current ?? [], record.norbital_id);
		return claimed.length > 0 ? `Paid in ${run?.period ?? 'a payroll run'}` : '—';
	});
</script>

<Grid gap="md" minimum="compact">
	<Column span="all">
		<div class="rounded-md border border-border bg-muted/20 p-3">
			<span class="text-xs text-muted-foreground">Payroll consumption</span>
			<span aria-live="polite" class="mt-1 block text-sm">{consumedByPayslip}</span>
		</div>
	</Column>
</Grid>

<CollectionForm
	{client}
	collection="component_entries"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="compact">
			<Field name="employment_id" />
			<Field name="pay_component_id" label="Pay component" />
			<Field name="amount" />
			<Field name="quantity" />
			<Field name="event_date" />
			<Field name="pay_period" label="Pay period" />
			<Column span="all"><Field name="description" /></Column>
			<Column span="all"><Field name="origin" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
