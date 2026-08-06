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
	collection="goods_receipt_lines"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="goods_receipt_id"
				label="Goods receipt"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'goods_receipts',
					options: {
						label: (record) =>
							record.doc_no != null && record.doc_no !== '' ? String(record.doc_no) : '—',
						orderBy: { doc_no: 'desc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field
				name="purchase_order_line_id"
				label="Order line"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'purchase_order_lines',
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
			<Field name="quantity_received" label="Received quantity" />
		</Grid>
	{/snippet}
</CollectionForm>
