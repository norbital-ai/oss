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
	collection="purchase_invoices"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="doc_no" label="Doc #" />
			<Field
				name="purchase_order_id"
				label="Purchase order"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'purchase_orders',
					options: {
						label: (record) =>
							record.doc_no != null && record.doc_no !== '' ? String(record.doc_no) : '—',
						orderBy: { doc_no: 'desc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field name="invoice_reference" label="Supplier invoice #" />
			<Field name="invoice_date" label="Invoice date" />
			<Field name="status" />
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
		</Grid>
	{/snippet}
</CollectionForm>
