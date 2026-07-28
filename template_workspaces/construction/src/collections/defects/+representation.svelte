<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';

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
			<Field name="project_id" />
			<Field name="site_location_id" />
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
