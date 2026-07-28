<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import SiteRepresentation from './site-representation.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

{#if record}
	<SiteRepresentation {record} />
{:else}
	<CollectionForm {client} collection="sites" submitLabel="Add site" onAfterSubmit={close}>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field name="name" />
				<Field name="client_name" label="Client / tenant" />
				<Field name="house_type" label="Site type" />
				<Field name="floor_area_sqm" label="Floor area (sqm)" />
				<Column span="all"><Field name="location" /></Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
