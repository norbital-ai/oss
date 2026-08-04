<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import JobAssignmentRepresentation from './job-assignment-representation.svelte';

	let { record, close, refresh }: RepresentationProps = $props();
</script>

{#if record}
	<JobAssignmentRepresentation {record} {refresh} />
{:else}
	<CollectionForm
		{client}
		collection="job_assignments"
		submitLabel="Create assignment"
		onAfterSubmit={close}
	>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field
					name="job_id"
					label="Job"
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
					label="Contractor"
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
