<script lang="ts">
	/**
	 * A pay component belongs to one company's catalogue. The auto form asked for `company_id` as an
	 * editable uuid; it is a relationship and reads as the entity's name. `nature` is a read-only
	 * projection of `policy` and is not offered as a field.
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
	collection="pay_components"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_pay_component') : t('component.create_pay_component')}
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
			<Field name="sequence" label={t('component.applied_at')} />
			<Column span="all"><Field name="policy" label={t('component.economic_type')} /></Column>
			<Column span="all"><Field name="definition" label={t('component.how_calculated')} /></Column>
			<Column span="all"><Field name="eligibility" label={t('component.who_receives')} /></Column>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
