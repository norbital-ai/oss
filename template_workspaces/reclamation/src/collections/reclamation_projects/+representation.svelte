<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import type { RepresentationProps } from './$types.js';
	import ProjectRepresentation from './project-representation.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

{#if record}
	<ProjectRepresentation {record} />
{:else}
	<CollectionForm {client} collection="reclamation_projects" onAfterSubmit={close} />
{/if}
