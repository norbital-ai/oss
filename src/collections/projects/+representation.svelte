<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import ProjectRepresentation from './project-representation.svelte';

	let { record, close }: RepresentationProps = $props();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/construction/record-media/projects-banner.svg"
	/>
</svelte:head>

{#if record}
	<ProjectRepresentation {record} />
{:else}
	<CollectionForm {client} collection="projects" onAfterSubmit={close} />
{/if}
