<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="bim_reference_matrix"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="reference_name" />
			<Field name="reference_code" />
			<Field name="project_id" />
			<Field name="category" />
			<Field name="subcategory" />
			<Field name="unit_of_measure" />
			<Field name="rate" />
			<Field name="embodied_carbon_per_unit" />
			<Field name="carbon_unit" />
			<Field name="bim_guid" />
			<Column span="all"><Field name="specification" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
