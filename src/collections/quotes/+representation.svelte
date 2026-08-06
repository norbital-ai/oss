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

<svelte:head>
	<meta name="pod:banner" content="/api/template-seed-assets/crm/record-media/quotes-banner.svg" />
</svelte:head>

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
			<Field name="doc_no" label={t('component.doc_no')} />
			<Field
				name="account_id"
				label={t('component.account')}
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
					label={t('component.contact')}
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
			<Field name="tax_inclusive" label={t('component.tax_inclusive')} />
			<Field name="valid_until" label={t('component.valid_until')} />
			<Field name="payment_terms" label={t('component.payment_terms')} />
			<Field name="shipping_terms" label={t('component.shipping_terms')} />
			<Field name="place_of_loading" label={t('component.place_of_loading')} />
			<Field name="place_of_delivery" label={t('component.place_of_delivery')} />
			<Field name="packaging" />
			<Field name="shipping_mark" label={t('component.shipping_mark')} />
			<Field name="time_of_shipment" label={t('component.time_of_shipment')} />
			<Column span="all"><Field name="other_terms" label={t('component.other_terms')} /></Column>
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
			<Field
				name="revision_of"
				label={t('component.revision_of')}
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
			<Field name="revision_number" label={t('component.revision_number')} />
			<Column span="all"><Field name="description" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
