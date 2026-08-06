<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import DurationHoursRenderer from '../../lib/ui/duration-hours-renderer.svelte';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="shift_definitions"
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
			<Field name="start_time" label={t('component.start_time')} />
			<Field name="end_time" label={t('component.end_time')} />
			<Field
				name="break_minutes"
				label={t('component.break_hours')}
				renderer={DurationHoursRenderer}
			/>
			<Field name="crosses_midnight" label={t('component.crosses_midnight')} />
			<Field name="pays_overtime" label={t('component.overtime_eligible')} />
			<Field
				name="overtime_break_minutes"
				label={t('component.overtime_break_hours')}
				renderer={DurationHoursRenderer}
			/>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
