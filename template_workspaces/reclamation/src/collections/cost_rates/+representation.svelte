<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import type { RepresentationProps } from './$types.js';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="cost_rates"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="substrate" />
			<Field name="label" />
			<Field name="unit" />
			<Field name="rate" />
			<Field name="rate_basis" />
			<Field name="source" />
			<Column span="all"><Field name="validity_range" /></Column>
			<Column span="all"><Field name="notes" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
