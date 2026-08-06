<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="permits_to_work"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="permit_number" />
			<Field name="permit_type" />
			<Field
				name="project_id"
				label={t('component.project')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'projects',
					options: {
						label: (record) => {
							const number = record.project_number;
							const name = record.project_name;
							if (number && name) return `${number} · ${name}`;
							const v = record.project_name;
							return v != null && v !== '' ? String(v) : '—';
						},
						orderBy: { project_number: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="site_location_id"
				label={t('component.site_location')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'site_locations',
					options: {
						label: (record) => {
							const code = record.location_code;
							const name = record.location_name;
							if (code && name) return `${code} · ${name}`;
							const v = record.location_name;
							return v != null && v !== '' ? String(v) : '—';
						},
						orderBy: { location_code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="job_id"
				label={t('component.job')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'jobs',
					options: {
						label: (record) => {
							const v = record.job_title;
							return v != null && v !== '' ? String(v) : '—';
						},
						orderBy: { job_title: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="worker_id"
				label={t('component.worker')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'workers',
					options: {
						label: (record) => {
							const number = record.worker_number;
							const name = record.worker_name;
							if (number && name) return `${number} · ${name}`;
							const v = record.worker_name;
							return v != null && v !== '' ? String(v) : '—';
						},
						orderBy: { worker_number: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="status" />
			<Field name="requested_date" />
			<Field name="validity_range" />
			<Field name="approved_by" />
		</Grid>
	{/snippet}
</CollectionForm>
