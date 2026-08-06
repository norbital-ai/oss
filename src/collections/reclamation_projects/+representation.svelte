<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import type { RepresentationProps } from './$types.js';
	import ProjectRepresentation from './project-representation.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/reclamation/record-media/reclamation_projects-banner.svg"
	/>
</svelte:head>

{#if record}
	<ProjectRepresentation {record} />
{:else}
	<CollectionForm {client} collection="reclamation_projects" onAfterSubmit={close} />
{/if}
