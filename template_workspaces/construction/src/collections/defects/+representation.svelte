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
	collection="defects"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="defect_number" />
			<Field name="title" />
			<Field
				name="project_id"
				label="Project"
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
				label="Site location"
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
			<Field name="category" />
			<Field name="severity" />
			<Field name="status" />
			<Field name="assigned_to" />
			<Field name="due_date" />
			<Field name="closed_date" />
			<Column span="all"><Field name="description" /></Column>
			<Column span="all"><Field name="resolution_notes" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
