<script lang="ts">
	// Mounts one kit part under a scripted `bolt`, catalog, custom fields and representation registry.
	import { provideKinds } from '../src/kinds/context.js';
	import Show from '../src/kinds/show.svelte';
	import Controls from './controls-harness.svelte';
	import Form from '../src/form/form.svelte';
	import { provideBolt, provideRepresentations, type ViewBolt } from '../src/views/bolt.js';
	import RecordShell from '../src/views/RecordShell.svelte';
	import Table from '../src/views/Table.svelte';

	let { bolt, catalog, customFields = {}, representations = {}, part, props = {} }: {
		bolt: ViewBolt; catalog: never; customFields?: never; representations?: never; part: 'form' | 'table' | 'show' | 'record' | 'controls'; props?: never;
	} = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	// svelte-ignore state_referenced_locally
	provideKinds({ get catalog() { return catalog; }, get customFields() { return customFields; }, read: (c, o) => bolt.read(c, o) as never });
	// svelte-ignore state_referenced_locally
	provideRepresentations(representations);
</script>

{#if part === 'form'}<Form {...props} />
{:else if part === 'table'}<Table {...props} />
{:else if part === 'show'}<Show {...props} />
{:else if part === 'controls'}<Controls {...props} />
{:else}<RecordShell {...props} />{/if}
