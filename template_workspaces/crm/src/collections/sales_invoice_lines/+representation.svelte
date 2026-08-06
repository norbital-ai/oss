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
	collection="sales_invoice_lines"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="sales_invoice_id"
				label="Sales invoice"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'sales_invoices',
					options: {
						label: (record) =>
							record.doc_no != null && record.doc_no !== '' ? String(record.doc_no) : '—',
						orderBy: { doc_no: 'desc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field
				name="quote_line_id"
				label="Quote line"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'quote_lines',
					options: {
						label: (record) => {
							const name = record.product_name;
							const quantity = record.quantity;
							if (name && quantity != null) return `${name} × ${quantity}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { product_name: 'asc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field name="quantity" />
			<Field name="unit_price" label="Unit price" />
			<Field name="tax_rate" label="Tax rate %" />
			<Field name="line_total" label="Line total" />
		</Grid>
	{/snippet}
</CollectionForm>
