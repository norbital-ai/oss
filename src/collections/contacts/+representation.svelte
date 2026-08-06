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
	collection="contacts"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
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
			<Field name="first_name" label={t('component.first_name')} />
			<Field name="last_name" label={t('component.last_name')} />
			<Field name="email" />
			<Field name="title" />
			<Field name="department" />
			<Field name="active" />
		</Grid>
	{/snippet}
</CollectionForm>
