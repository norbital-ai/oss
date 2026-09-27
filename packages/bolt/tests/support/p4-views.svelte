<script lang="ts">
	// One ui next view over a real `$bolt` (G5): a paged Table, or a Matrix page of a month.
	import { provideKinds, type KindsHost } from '../../../ui/src/kinds/context.js';
	import { provideBolt, type ViewBolt } from '../../../ui/src/views/bolt.js';
	import Matrix from '../../../ui/src/views/Matrix.svelte';
	import Table from '../../../ui/src/views/Table.svelte';
	import type { Json } from '../../../ui/src/views/bolt.js';

	let { bolt, kinds, view, cols = [] }: { bolt: ViewBolt; kinds: KindsHost; view: 'table' | 'matrix'; cols?: readonly Json[] } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	// svelte-ignore state_referenced_locally
	provideKinds(kinds);
</script>

{#if view === 'table'}
	<section data-test="table"><Table of="people" columns={['name']} pageSize={10} orderBy={{ name: 'asc' }} /></section>
{:else}
	<section data-test="matrix"><Matrix rows="people" rowLabel="name" of="entries" row="person" col="day" {cols} select={['hours']} colWidth={48} /></section>
{/if}
