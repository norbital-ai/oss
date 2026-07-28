<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="job_assignments"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="assignment_code" />
			<Field name="status" />
			<Field name="job_id" />
			<Field name="worker_id" />
			<Field name="site_location_id" />
			<Field name="role" />
			<Field name="assignment_range" />
			<Field name="hours_per_day" />
		</Grid>
	{/snippet}
</CollectionForm>
