<script lang="ts">
	/**
	 * A leave type belongs to one company's catalogue. The auto form asked for `company_id` as an
	 * editable uuid; it is a relationship and reads as the entity's name.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="leave_types"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_leave_type') : t('component.create_leave_type')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="company_id"
				label={t('component.legal_entity')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'companies',
					options: {
						label: (company) =>
							company.name != null && company.name !== '' ? String(company.name) : '—',
						orderBy: { name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="code" label={t('component.code')} />
			<Field name="name" label={t('component.name')} />
			<Field name="aggregates_with" label={t('component.aggregates_with')} />
			<Field name="encash_on_exit" label={t('component.encashed_on_exit')} />
			<Field
				name="requires_certificate_after_days"
				label={t('component.certificate_required_after_days')}
			/>
			<Column span="all"><Field name="eligibility" label={t('component.who_may_take_it')} /></Column
			>
			<Column span="all"
				><Field name="entitlement" label={t('component.entitlement_matrix')} /></Column
			>
			<Column span="all"><Field name="accrual" label={t('component.accrual_and_carry')} /></Column>
			<Column span="all"
				><Field name="payroll_effect" label={t('component.effect_on_pay')} /></Column
			>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
