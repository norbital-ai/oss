<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Layer, ManagedRuntime } from 'effect';
	import { mount_edge } from '../../../ui/src/effect/index.js';
	import { provide_bolt } from '../../../ui/src/client/context.js';
	import { filter_catalog as catalog } from './filter-catalog.ts';
	import type { Json } from '../../../ui/src/client/contract.js';
	import type { ViewBolt } from '../../../ui/src/client/contract.js';
	import { provide_kinds } from '../../../ui/src/kinds/context.js';
	import ViewPopover from '../../../ui/src/filter/ViewPopover.svelte';
	import { viewState } from '../../../ui/src/filter/view-state.svelte.js';

	let { bolt, initialFilter }: { bolt: ViewBolt; initialFilter?: Json } = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provide_bolt(() => bolt);

	provide_kinds({ catalog, zone: 'Asia/Singapore' });
	const view = viewState(
		untrack(() => bolt),
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
		{view}
		{catalog}
		model="people"
		author={{ name: { ne: 'Archived' } }}
		sortable={['name']}
	/>
</div>
