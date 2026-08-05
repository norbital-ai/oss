<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="employment_statutory_facts"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? 'Save registration' : 'Record registration'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="employment_id"
				label="Employment"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'employments',
					options: {
						label: (employment) =>
							employment.employee_number != null && employment.employee_number !== ''
								? String(employment.employee_number)
								: '—',
						orderBy: { employee_number: 'asc' },
						limit: 1000
					}
				}}
			/>
			<Field
				name="statutory_contribution_id"
				label="Statutory scheme"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'statutory_contributions',
					options: {
						label: (contribution) =>
							[contribution.code, contribution.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { sequence: 'asc' },
						limit: 500
					}
				}}
			/>
			<Column span="all"><Field name="status" label="Registration" /></Column>
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
