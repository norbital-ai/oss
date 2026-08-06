<script lang="ts">
	/**
	 * A job and a certification its workers must hold. Both sides are relationships: without this
	 * file the auto `CollectionForm` is two uuid text boxes and nothing else.
	 */
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
	collection="jobs_certification_types"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="job_id"
				label={t('component.job')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'jobs',
					options: {
						label: (record) => {
							const code = record.job_number;
							const name = record.job_title;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { job_number: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="certification_type_id"
				label={t('component.certification')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'certification_types',
					options: {
						label: (record) => {
							const code = record.certification_code;
							const name = record.certification_name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { certification_code: 'asc' },
						limit: 500
					}
				}}
			/>
		</Grid>
	{/snippet}
</CollectionForm>
