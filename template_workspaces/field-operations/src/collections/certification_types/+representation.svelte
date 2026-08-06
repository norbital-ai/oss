<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="certification_types"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? undefined : t('component.add_certification_type')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="panel">
			<Field name="code" />
			<Field name="name" />
			<Field name="category" />
			<Field name="issuing_body" label={t('component.issuing_body')} />
			<Column span="all"><Field name="description" /></Column>
			<Field name="active" />
		</Grid>
	{/snippet}
</CollectionForm>
