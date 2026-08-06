<script lang="ts">
	/**
	 * A company is its pay calendar plus the two facts the calendar cannot state: how settlement
	 * deviates from it, and which statutory risk class the entity is rated in.
	 *
	 * The auto form painted `jurisdiction_id` as an editable uuid. It is a relationship, and it
	 * reads as the regime's name — a company belongs to one payroll regime, and the operator picks
	 * the regime, never its key.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="companies"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_company') : t('component.create_company')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field name="name" label={t('component.legal_name')} />
			<Field name="registration_number" label={t('component.registration_number')} />
			<Field
				name="jurisdiction_id"
				label={t('component.payroll_regime')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'jurisdictions',
					options: {
						label: (jurisdiction) =>
							[jurisdiction.code, jurisdiction.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="pay_cutoff_day" label={t('component.attendance_cutoff_day')} />
			<Field name="pay_day" label={t('component.pay_day')} />
			<Field name="leave_year_start_month" label={t('component.leave_year_starts_in_month')} />
			<Field name="overtime_calculation_method" label={t('component.overtime_calculation')} />
			<Stack gap="xs">
				<Field name="risk_class" label={t('component.statutory_risk_class')} />
				<p class="text-xs text-muted-foreground">
					The occupational risk group the entity is rated in, where its regime prices a contribution
					by risk. Indonesia's JKK is the one such scheme here: class
					<span class="font-medium">IV</span>
					is charged at 0.89% and class <span class="font-medium">I</span> at 0.24%, so an Indonesian
					entity left blank matches no band and its payroll run stops by name rather than quietly charging
					nothing. Malaysian and Philippine entities have no risk-keyed contribution and correctly leave
					this empty.
				</p>
			</Stack>
			<Column span="all"
				><Field name="settlement_policy" label={t('component.settlement_policy')} /></Column
			>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
