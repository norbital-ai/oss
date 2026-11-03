<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Layer, ManagedRuntime } from 'effect';
	import { mountEdge } from '../../../ui/src/effect/index.js';
	import { provideBolt } from '../../../ui/src/client/context.js';
	import type { ViewBolt } from '../../../ui/src/client/contract.js';
	import type { ModelExposure } from '../../../ui/src/kinds/context.js';
	import type { FilterVariables } from '../../../ui/src/filter/filter.js';
	import { provideKinds } from '../../../ui/src/kinds/context.js';
	import { filterCatalog as baseCatalog } from './filter-catalog.ts';
	import FilterEditor, { type FilterValue } from '../../../ui/src/filter/FilterEditor.svelte';

	let {
		bolt,
		initial,
		model = 'people',
		catalog = baseCatalog,
		variables,
		readonly = false
	}: {
		bolt: ViewBolt;
		initial?: FilterValue;
		model?: string;
		catalog?: Record<string, ModelExposure>;
		variables?: FilterVariables;
		readonly?: boolean;
	} = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get catalog() {
			return catalog;
		},
		zone: 'Asia/Singapore'
	});
	let value = $state<FilterValue>(untrack(() => initial ?? { where: { name: { eq: 'Before' } } }));
	let submitted = $state(0);
</script>

<form
	class="p-4"
	onsubmit={(event) => {
		event.preventDefault();
		submitted++;
	}}
>
	<FilterEditor {model} {value} {variables} {readonly} onChange={(next) => (value = next)} />
	<output data-saved-filter>{JSON.stringify(value)}</output>
	<output data-submitted>{submitted}</output>
</form>
