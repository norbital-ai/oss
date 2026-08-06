<script lang="ts">
	/**
	 * A request to change approved scope, raised against one job assignment. `job_assignment_id` was
	 * an editable uuid on the auto form; it reads as the assignment’s job and contractor.
	 *
	 * Approval, rejection and rollback are not here: they live only in the native approval system.
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
	collection="variation_requests"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="job_assignment_id"
				label={t('component.job_assignment')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'job_assignments',
					options: {
						label: (record) => {
							const status = record.status;
							const dispatched = record.dispatched_at;
							const when = dispatched == null ? null : String(dispatched).slice(0, 10);
							return (
								[when, status].filter((part) => part != null && part !== '').join(' · ') || '—'
							);
						},
						orderBy: { dispatched_at: 'desc' },
						limit: 500
					}
				}}
			/>
			<Field name="title" label={t('component.title')} />
			<Field name="requested_at" label={t('component.requested_at')} />
			<Field name="amount" label={t('component.amount')} />
			<Column span="all"><Field name="description" label={t('component.description')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
