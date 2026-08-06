<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import JobAssignmentRepresentation from './job-assignment-representation.svelte';

	let { record, close, refresh }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

{#if record}
	<JobAssignmentRepresentation {record} {refresh} />
{:else}
	<CollectionForm
		{client}
		collection="job_assignments"
		submitLabel={t('component.create_assignment')}
		onAfterSubmit={close}
	>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field
					name="job_id"
					label={t('component.job')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'jobs',
						options: {
							label: (record) => {
								const v = record.title;
								return v != null && v !== '' ? String(v) : '—';
							},
							orderBy: { title: 'asc' },
							limit: 500
						}
					}}
				/>
				<Field
					name="contractor_profile_id"
					label={t('component.contractor')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'contractor_profiles',
						options: {
							label: (record) => {
								const v = record.company_name;
								return v != null && v !== '' ? String(v) : '—';
							},
							orderBy: { company_name: 'asc' },
							limit: 500
						}
					}}
				/>
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
