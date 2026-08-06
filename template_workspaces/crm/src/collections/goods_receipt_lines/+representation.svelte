<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { CollectionRelationOptions } from '@norbital-ai/platform-utils/collection';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
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
				label={t('component.goods_receipt')}
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
				label={t('component.order_line')}
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
			<Field name="quantity_received" label={t('component.received_quantity')} />
		</Grid>
	{/snippet}
</CollectionForm>
