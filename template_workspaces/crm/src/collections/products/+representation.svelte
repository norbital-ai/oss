<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import type { CollectionRelationOptions } from '@norbital-ai/platform-utils/collection';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="products"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="code" label={t('component.code')} />
			<Field name="name" />
			<Field name="external_code" />
			<Field name="unit" label={t('component.unit')} />
			<Field name="unit_price" label={t('component.unit_price')} />
			<Field name="tax_rate" label={t('component.tax_rate')} />
			<Field name="qty_on_hand" label={t('component.on_hand')} />
			<Field name="active" />
			<Field
				name="main_supplier_id"
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
			<Column span="all"><Field name="description" /></Column>
			<Column span="all"><Field name="spec" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
