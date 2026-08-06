<script lang="ts">
	/**
	 * One money event, and whether payroll has already consumed it.
	 *
	 * The consumption question is answered from its directly related payslip lines, not inferred from a
	 * candidate payroll run. The generated relation key exposes the provenance arm without copying
	 * mutable state, so the whole path to the run is one bounded relational query.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { RepresentationProps } from './$types.js';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();

	const consumptionQuery = $derived(
		record
			? client.db.component_entries.findFirst({
					where: { norbital_id: { eq: record.norbital_id } },
					columns: { norbital_id: true, pay_period: true },
					with: {
						entry_payslip_lines: {
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
				})
			: null
	);
	type ConsumptionRow = {
		readonly entry_payslip_lines?: readonly {
			readonly payslip_line_payslip?: {
				readonly payslip_payroll_run?: { readonly period?: string | null } | null;
			} | null;
		}[];
	};

	/**
	 * A human consumption label, but only once a line has actually claimed this entry. A drafted run
	 * that has not reached this entry yet must not read as though it had.
	 */
	const consumedByPayslip = $derived.by((): string => {
		if (!record) return '—';
		if (!record.pay_period) return t('component.settled_outside_payroll');
		if (consumptionQuery?.loading) return t('component.loading');
		const consumption = consumptionQuery?.current as ConsumptionRow | null | undefined;
		const source = consumption?.entry_payslip_lines?.[0];
		if (!source) return '—';
		const period = source.payslip_line_payslip?.payslip_payroll_run?.period;
		return t('component.paid_in', { period: period ?? t('component.a_payroll_run') });
	});
</script>

<Grid gap="md" minimum="compact">
	<Column span="all">
		<div class="rounded-md border border-border bg-muted/20 p-3">
			<span class="text-xs text-muted-foreground">{t('component.payroll_consumption')}</span>
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
			<Field
				name="employment_id"
				label={t('component.employment')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'employments',
					options: {
						label: (record) =>
							record.employee_number != null && record.employee_number !== ''
								? String(record.employee_number)
								: '—',
						orderBy: { employee_number: 'asc' },
						limit: 1000
					}
				}}
			/>
			<Field
				name="pay_component_id"
				label={t('component.pay_component')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'pay_components',
					options: {
						label: (record) => {
							const code = record.code;
							const name = record.name;
							if (code && name) return `${code} · ${name}`;
							if (code) return String(code);
							if (name) return String(name);
							return '—';
						},
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="amount" />
			<Field name="quantity" />
			<Field name="event_date" />
			<Field name="pay_period" label={t('component.pay_period')} />
			<Column span="all"><Field name="description" /></Column>
			<Column span="all"><Field name="origin" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
