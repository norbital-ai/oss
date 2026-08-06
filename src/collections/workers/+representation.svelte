<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/construction/record-media/workers-banner.svg"
	/>
</svelte:head>

<CollectionForm
	{client}
	collection="workers"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="worker_name" />
			<Field name="worker_number" />
			<Field name="trade" />
			<Field name="status" />
			<Field name="phone" />
			<Field name="email" />
			<Field name="date_of_birth" />
			<Field name="nationality" />
			<Field name="work_permit_expiry" />
			<Field name="medical_check_date" />
			<Field name="safety_induction_date" />
		</Grid>
	{/snippet}
</CollectionForm>
