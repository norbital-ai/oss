<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import SiteRepresentation from './site-representation.svelte';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

{#if record}
	<SiteRepresentation {record} />
{:else}
	<CollectionForm
		{client}
		collection="sites"
		submitLabel={t('component.add_site')}
		onAfterSubmit={close}
	>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field name="name" />
				<Field name="client_name" label={t('component.client_tenant')} />
				<Field name="house_type" label={t('component.site_type')} />
				<Field name="floor_area_sqm" label={t('component.floor_area_sqm')} />
				<Column span="all"><Field name="location" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
