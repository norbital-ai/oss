<script lang="ts">
	/**
	 * One money event, and whether payroll has already consumed it.
	 *
	 * The consumption question is answered from the entry's nested source links, not inferred from a
	 * candidate payroll run. The generated relation key exposes the provenance arm without copying
	 * mutable state, so the whole path to the run is one bounded relational query.
	 */
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import type { RepresentationProps } from './$types.js';

	let { record, close }: RepresentationProps = $props();

	const consumptionQuery = $derived(
		record
			? client.db.component_entries.findFirst({
					where: { norbital_id: { eq: record.norbital_id } },
					columns: { norbital_id: true, pay_period: true },
					with: {
						entry_payslip_sources: {
							columns: { norbital_id: true },
							with: {
								payslip_line_source_line: {
									columns: { norbital_id: true },
									with: {
										payslip_line_payslip: {
											columns: { norbital_id: true },
											with: {
												payslip_payroll_run: { columns: { period: true } }
											}
										}
									}
								}
							}
						}
					}
				})
			: null
	);
	type ConsumptionRow = {
		readonly entry_payslip_sources?: readonly {
			readonly payslip_line_source_line?: {
				readonly payslip_line_payslip?: {
					readonly payslip_payroll_run?: { readonly period?: string | null } | null;
				} | null;
			} | null;
		}[];
	};

	/**
	 * A human consumption label, but only once a line has actually claimed this entry. A drafted run
	 * that has not reached this entry yet must not read as though it had.
	 */
	const consumedByPayslip = $derived.by((): string => {
		if (!record) return '—';
		if (!record.pay_period) return 'Settled outside payroll';
		if (consumptionQuery?.loading) return 'Loading…';
		const consumption = consumptionQuery?.current as ConsumptionRow | null | undefined;
		const source = consumption?.entry_payslip_sources?.[0];
		if (!source) return '—';
		const period =
			source.payslip_line_source_line?.payslip_line_payslip?.payslip_payroll_run?.period;
		return `Paid in ${period ?? 'a payroll run'}`;
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
