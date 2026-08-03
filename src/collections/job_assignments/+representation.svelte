<script lang="ts">
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import JobAssignmentRepresentation from './job-assignment-representation.svelte';

	let { record, close, refresh }: RepresentationProps = $props();
</script>

{#if record}
	<JobAssignmentRepresentation {record} {refresh} />
{:else}
	<CollectionForm {client} collection="job_assignments" onAfterSubmit={close} />
{/if}
