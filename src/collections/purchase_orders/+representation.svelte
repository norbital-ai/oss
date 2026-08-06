<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { CollectionRelationOptions } from '@norbital-ai/platform-utils/collection';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="purchase_orders"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="doc_no" label={t('component.doc_no')} />
			<Field
				name="supplier_id"
				label={t('component.supplier')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'suppliers',
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
			<Field name="status" />
			<Field name="currency" />
			<Field name="tax_inclusive" label={t('component.tax_inclusive')} />
			<Field name="expected_date" label={t('component.expected_date')} />
			<Field
				name="owner_id"
				label={t('component.owner')}
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
