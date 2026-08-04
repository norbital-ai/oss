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
	collection="quote_lines"
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
			<Field
				name="product_id"
				label="Product"
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'products',
					options: {
						label: (record) => {
							const code = record.code;
							const name = record.name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { name: 'asc' },
						limit: 5000
					} satisfies CollectionRelationOptions
				}}
			/>
			<Field name="product_code" label="Code" />
			<Field name="product_name" label="Product name" />
			<Field name="quantity" />
			<Field name="unit_price" label="Unit price" />
			<Field name="discount_pct" label="Discount %" />
			<Field name="line_total" label="Line total" />
		</Grid>
	{/snippet}
</CollectionForm>
