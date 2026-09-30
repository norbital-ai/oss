<script lang="ts">
	// Mounts a view under a scripted `bolt` and catalog: a Table, a Board, a Form, or a RecordShell inside a Sheet.
	import { provideKinds, type Geocoder } from '../src/kinds/context.js';
	import PointInput from '../src/kinds/point-input.svelte';
	import Picker from '../src/kinds/picker.svelte';
	import { Sheet } from '../src/primitives/sheet/index.js';
	import { provideBolt, type ViewBolt } from '../src/views/bolt.js';
	import Board from '../src/views/Board.svelte';
	import Form from '../src/form/form.svelte';
	import RecordShell from '../src/views/RecordShell.svelte';
	import Table from '../src/views/Table.svelte';

	let { bolt, catalog, geocoder, part, props = {} }: { bolt: ViewBolt; catalog: never; geocoder?: Geocoder; part: 'table' | 'board' | 'record' | 'point' | 'picker' | 'form'; props?: never } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({ get catalog() { return catalog; }, read: (c, o) => bolt.read(c, o) as never, geocoder });
</script>

{#if part === 'table'}
	<Table {...props} />
{:else if part === 'board'}
	<Board {...props} />
{:else if part === 'point'}
	<PointInput {...props} />
{:else if part === 'form'}
	<Form {...props} />
{:else if part === 'picker'}
	<Picker {...props} />
{:else}
	<Sheet open title="jobs"><RecordShell {...props} /></Sheet>
{/if}
