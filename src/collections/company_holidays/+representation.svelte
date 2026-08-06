<script lang="ts">
	/**
	 * A holiday belongs to the company that observes it, so the auto form asked for `company_id` as
	 * an editable uuid. It is a relationship and reads as the entity's name.
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
	collection="company_holidays"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_holiday') : t('component.create_holiday')}
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
			<Field name="name" label={t('component.holiday')} />
			<Field name="date" label={t('component.observed_on')} />
			<Field name="substitutes_date" label={t('component.substitute_for')} />
			<Column span="all"><Field name="scope" label={t('component.who_observes_it')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
