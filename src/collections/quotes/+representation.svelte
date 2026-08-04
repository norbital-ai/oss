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
	collection="quotes"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field, form })}
		{@const values = form.values()}
		<Grid minimum="compact">
			<Field name="doc_no" label="Doc #" />
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
			{#key values.account_id}
				<Field
					name="contact_id"
					label="Contact"
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'contacts',
						options: {
							label: (record) => {
								const first = record.first_name;
								const last = record.last_name;
								if (first && last) return `${first} ${last}`;
								return first != null && first !== '' ? String(first) : '—';
							},
							...(values.account_id ? { where: { account_id: { eq: values.account_id } } } : {}),
							orderBy: { last_name: 'asc' },
							limit: 5000
						} satisfies CollectionRelationOptions
					}}
				/>
			{/key}
			<Field name="title" />
			<Field name="status" />
			<Field name="currency" />
			<Field name="tax_inclusive" label="Tax inclusive" />
			<Field name="valid_until" label="Valid until" />
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
			<Field
				name="revision_of"
				label="Revision of"
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
			<Field name="revision_number" label="Revision number" />
			<Column span="all"><Field name="description" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
