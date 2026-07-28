<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
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
			<Field name="project_id" />
			<Field name="site_location_id" />
			<Field name="job_id" />
			<Field name="worker_id" />
			<Field name="status" />
			<Field name="requested_date" />
			<Field name="validity_range" />
			<Field name="approved_by" />
		</Grid>
	{/snippet}
</CollectionForm>
