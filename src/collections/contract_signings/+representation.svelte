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
	collection="contract_signings"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="quote_id"
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
			<Field name="variant" />
			<Field name="status" />
			<Field name="generated_file" label="Generated contract" />
			<Field name="counterparty_file" label="Counterparty-stamped copy" />
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
			<Column span="all"><Field name="void_reason" label="Void reason" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
