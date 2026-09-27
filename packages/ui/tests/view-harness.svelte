<script lang="ts">
	// Mounts a view under a scripted `bolt` and catalog: a Table, a Board, or a RecordShell inside a Sheet.
	import { provideKinds } from '../src/kinds/context.js';
	import { Sheet } from '../src/primitives/sheet/index.js';
	import { provideBolt, type ViewBolt } from '../src/views/bolt.js';
	import Board from '../src/views/Board.svelte';
	import RecordShell from '../src/views/RecordShell.svelte';
	import Table from '../src/views/Table.svelte';

	let { bolt, catalog, part, props = {} }: { bolt: ViewBolt; catalog: never; part: 'table' | 'board' | 'record'; props?: never } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({ get catalog() { return catalog; }, read: (c, o) => bolt.read(c, o) as never });
</script>

{#if part === 'table'}
	<Table {...props} />
{:else if part === 'board'}
	<Board {...props} />
{:else}
	<Sheet open title="jobs"><RecordShell {...props} /></Sheet>
{/if}
