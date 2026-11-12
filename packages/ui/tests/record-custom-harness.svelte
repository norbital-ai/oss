<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import { type ModelExposure } from '../src/kinds/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import RecordShell from '../src/record/RecordShell.svelte';
	import Form from '../src/form/form.svelte';
	let { bolt, catalog }: { bolt: ViewBolt; catalog: Record<string, ModelExposure> } = $props();
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { bolt: bolt, kinds: {
		get catalog() {
			return catalog;
		}
	} } };
</script>

<RecordShell {ctx} of="jobs" id="j1">
	{#snippet children(view)}
		<div data-record-mode={view.mode}>
			<div data-custom-title><Form {ctx} of="jobs" id="j1" fields={['title']} /></div>
			<div data-custom-crew><Form {ctx} of="jobs" id="j1" fields={['crew']} /></div>
		</div>
	{/snippet}
</RecordShell>
