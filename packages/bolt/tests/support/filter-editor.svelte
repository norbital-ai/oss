<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Layer, ManagedRuntime } from 'effect';
	import { mount_edge } from '../../../ui/src/effect/index.js';
	import { filter_catalog as catalog } from './filter-catalog.ts';
	import type { Json } from '../../../ui/src/client/contract.js';
	import type { UiContext, ViewBolt } from '../../../ui/src/client/contract.js';
	import ViewPopover from '../../../ui/src/filter/ViewPopover.svelte';
	import { viewState } from '../../../ui/src/filter/view-state.svelte.js';

	let { bolt, initialFilter }: { bolt: ViewBolt; initialFilter?: Json } = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	const ctx: UiContext = { ui: { get bolt() { return bolt; }, kinds: { catalog, zone: 'Asia/Singapore' } } };
	const view = viewState(
		() => ctx,
		{
			key: () => 'filter-browser',
			model: () => 'people',
			catalog: () => catalog,
			initial_filter: () =>
				initialFilter ?? {
					employer: { eq: 'company_1' },
					contracts: {
						some: {
							or: [{ status: { eq: 'active' } }, { status: { eq: 'on_leave' } }]
						}
					}
				}
		}
	);
</script>

<div class="p-4">
	<ViewPopover
		{ctx}
		{view}
		{catalog}
		model="people"
		author={{ name: { ne: 'Archived' } }}
		sortable={['name']}
	/>
</div>
