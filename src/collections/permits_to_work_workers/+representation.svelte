<script lang="ts">
	/**
	 * A permit and a worker named on it. Both sides are relationships: without this file the auto
	 * `CollectionForm` is two uuid text boxes and nothing else.
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
	collection="permits_to_work_workers"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="permits_to_work_id"
				label={t('component.permit_to_work')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'permits_to_work',
					options: {
						label: (record) =>
							record.permit_number != null && record.permit_number !== ''
								? String(record.permit_number)
								: '—',
						orderBy: { permit_number: 'asc' },
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
							const code = record.worker_number;
							const name = record.worker_name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { worker_number: 'asc' },
						limit: 500
					}
				}}
			/>
		</Grid>
	{/snippet}
</CollectionForm>
