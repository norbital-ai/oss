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
	submitLabel={record ? undefined : 'Add certification'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="panel">
			<Field name="code" />
			<Field name="name" />
			<Field name="category" />
			<Field name="issuing_body" label="Issuing body" />
			<Column span="all"><Field name="description" /></Column>
			<Field name="active" />
		</Grid>
	{/snippet}
</CollectionForm>
