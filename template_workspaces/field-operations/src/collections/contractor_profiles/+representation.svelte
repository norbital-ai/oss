<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import ContractorProfileRepresentation from './contractor-profile-representation.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

{#if record}
	<ContractorProfileRepresentation {record} />
{:else}
	<CollectionForm
		{client}
		collection="contractor_profiles"
		submitLabel="Add contractor"
		onAfterSubmit={close}
	>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field name="company_name" />
				<Field name="user_id" label="Portal user" />
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
