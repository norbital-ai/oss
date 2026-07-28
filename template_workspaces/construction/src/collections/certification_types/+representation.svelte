<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="certification_types"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="certification_name" />
			<Field name="certification_code" />
			<Field name="category" />
			<Field name="issuing_body" />
			<Field name="validity_period_months" />
			<Field name="requires_refresher" />
			<Column span="all"><Field name="description" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
