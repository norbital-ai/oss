<script lang="ts">
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
	collection="work_patterns"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="compact">
			<Field
				name="company_id"
				label={t('component.company')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'companies',
					options: {
						label: (record) =>
							record.name != null && record.name !== '' ? String(record.name) : '—',
						orderBy: { name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="code" />
			<Field name="name" />
			<Field
				name="default_shift_definition_id"
				label={t('component.default_shift')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'shift_definitions',
					options: {
						label: (record) =>
							[record.code, record.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Column span="all"><Field name="variant" label={t('component.shape_of_week')} /></Column>
			<Field name="min_rest_days_per_week" label={t('component.minimum_rest_days_per_week')} />
			<Field
				name="max_consecutive_work_days"
				label={t('component.maximum_consecutive_working_days')}
			/>
			<Field name="max_daily_work_minutes" label={t('component.maximum_daily_work_min')} />
			<Field
				name="min_minutes_between_shifts"
				label={t('component.minimum_rest_between_shifts_min')}
			/>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
