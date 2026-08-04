<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { CollectionRelationOptions } from '@norbital-ai/platform-utils/collection';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="contacts"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="account_id"
				label="Account"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'accounts',
					options: {
						label: (record) =>
							record.name != null && record.name !== '' ? String(record.name) : '—',
						orderBy: { name: 'asc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field name="first_name" label="First name" />
			<Field name="last_name" label="Last name" />
			<Field name="email" />
			<Field name="title" />
			<Field name="department" />
			<Field name="active" />
		</Grid>
	{/snippet}
</CollectionForm>
