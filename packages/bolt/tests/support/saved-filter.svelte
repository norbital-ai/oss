<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Layer, ManagedRuntime } from 'effect';
	import { mount_edge } from '../../../ui/src/effect/index.js';
	import { provide_bolt } from '../../../ui/src/client/context.js';
	import type { ViewBolt } from '../../../ui/src/client/contract.js';
	import type { ModelExposure } from '../../../ui/src/kinds/context.js';
	import type { FilterVariables } from '../../../ui/src/filter/filter.js';
	import { provide_kinds } from '../../../ui/src/kinds/context.js';
	import { filter_catalog as baseCatalog } from './filter-catalog.ts';
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
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provide_bolt(() => bolt);
	provide_kinds({
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
	<FilterEditor {model} {value} {variables} {readonly} on_change={(next) => (value = next)} />
	<output data-saved-filter>{JSON.stringify(value)}</output>
	<output data-submitted>{submitted}</output>
</form>
