<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { CollectionRelationOptions } from '@norbital-ai/platform-utils/collection';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="activities"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field, form })}
		{@const values = form.values()}
		<Grid minimum="compact">
			<Field name="subject" />
			<Field name="type" />
			<Field name="regarding_type" label="Regarding type" />
			{#key values.regarding_type}
				{#if values.regarding_type === 'quotes'}
					<Field
						name="regarding_id"
						label="Quote"
						renderer={RelationshipRenderer}
						rendererProps={{
							target: 'quotes',
							options: {
								label: (record) => {
									const docNo = record.doc_no;
									const title = record.title;
									if (docNo && title) return `${docNo}: ${title}`;
									return docNo != null && docNo !== '' ? String(docNo) : '—';
								},
								orderBy: { doc_no: 'desc' },
								limit: 5000
							} satisfies CollectionRelationOptions
						}}
					/>
				{:else}
					<Field
						name="regarding_id"
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
				{/if}
			{/key}
			<Field name="due_date" label="Due date" />
			<Field name="completed_at" label="Completed" />
			<Field
				name="owner_id"
				label="Owner"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'user',
					options: {
						label: (record) =>
							record.name != null && record.name !== '' ? String(record.name) : '—',
						orderBy: { name: 'asc' },
						limit: 500
					} satisfies CollectionRelationOptions
				}}
			/>
			<Column span="all"><Field name="description" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
