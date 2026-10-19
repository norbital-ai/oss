<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	import { provideKinds, type CollectionExposure } from '../src/kinds/context.js';
	import { provideBolt } from '../src/client/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import RecordShell from '../src/record/RecordShell.svelte';
	import Form from '../src/form/form.svelte';
	let { bolt, catalog }: { bolt: ViewBolt; catalog: Record<string, CollectionExposure> } = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get catalog() {
			return catalog;
		}
	});
</script>

<RecordShell of="jobs" id="j1">
	{#snippet children(view)}
		<div data-record-mode={view.mode}>
			<div data-custom-title><Form of="jobs" id="j1" fields={['title']} /></div>
			<div data-custom-crew><Form of="jobs" id="j1" fields={['crew']} /></div>
		</div>
	{/snippet}
</RecordShell>
