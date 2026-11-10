<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { Layer, ManagedRuntime } from 'effect';
	import { mountEdge } from '../../../ui/src/effect/index.js';
	import { provideBolt } from '../../../ui/src/client/context.js';
	import { filterCatalog as catalog } from './filter-catalog.ts';
	import type { Json } from '../../../ui/src/client/contract.js';
	import type { ViewBolt } from '../../../ui/src/client/contract.js';
	import { provideKinds } from '../../../ui/src/kinds/context.js';
	import ViewPopover from '../../../ui/src/filter/ViewPopover.svelte';
	import { viewState } from '../../../ui/src/filter/view-state.svelte.js';

	let { bolt, initialFilter }: { bolt: ViewBolt; initialFilter?: Json } = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provideBolt(() => bolt);

	provideKinds({ catalog, zone: 'Asia/Singapore' });
	const view = viewState(
		untrack(() => bolt),
		{
			key: () => 'filter-browser',
			model: () => 'people',
			catalog: () => catalog,
			initialFilter: () =>
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
