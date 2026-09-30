<script lang="ts">
	// Mounts one kit part under a scripted `bolt` and catalog, for the kit's default display (the template UI audit).
	import { provideKinds } from '../src/kinds/context.js';
	import Show from '../src/kinds/show.svelte';
	import Form from '../src/form/form.svelte';
	import ReadonlyMarkdown from '../src/editors/readonly-markdown.svelte';
	import { Sheet } from '../src/primitives/sheet/index.js';
	import { provideBolt, type ViewBolt } from '../src/views/bolt.js';
	import CustomView from '../src/views/CustomView.svelte';
	import RecordShell from '../src/views/RecordShell.svelte';
	import Table from '../src/views/Table.svelte';

	let { bolt, catalog, part, props = {} }: { bolt: ViewBolt; catalog: never; part: 'table' | 'record' | 'form' | 'show' | 'custom' | 'markdown'; props?: never } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({ get catalog() { return catalog; }, read: (c, o) => bolt.read(c, o) as never, locale: 'en', zone: 'UTC', currency: 'SGD' });
</script>

{#snippet rows(list: readonly object[])}<p data-custom-rows>{list.length}</p>{/snippet}

{#if part === 'table'}<Table {...props} />
{:else if part === 'record'}<Sheet open title="record"><RecordShell {...props} /></Sheet>
{:else if part === 'form'}<Form {...props} />
{:else if part === 'show'}<Show {...props} />
{:else if part === 'custom'}<CustomView {...props} children={rows} />
{:else}<ReadonlyMarkdown value="**bold**" data-probe="md" />{/if}
