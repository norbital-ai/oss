<script lang="ts">
	import { useBolt } from '../client/context.js';
	import type { ModelExposure } from '../kinds/context.js';
	import ToolbarFilter from '../model/toolbar/ToolbarFilter.svelte';
	import { msg } from '../text/messages.js';
	import { complete } from './filter.js';
	import FilterPanel from './FilterPanel.svelte';
	import type { ViewState } from './view-state.svelte.js';
	import type { Json } from '../client/contract.js';

	let {
		view,
		catalog,
		model,
		author,
		sortable
	}: {
		view: ViewState;
		catalog: { readonly [model: string]: ModelExposure };
		model: string;
		author?: Json;
		sortable: readonly string[];
	} = $props();
	const bolt = useBolt();
	let open = $state(false);
	const count = $derived(view.rows.filter(complete).length + view.order.length);
</script>

<ToolbarFilter
	bind:open
	{count}
	label={msg(bolt, 'view.filterSort', 'Filter and sort')}
	panelClass="w-[min(46rem,calc(100vw-2rem))]"
>
	<FilterPanel {view} {catalog} {model} {author} {sortable} active={open} />
</ToolbarFilter>
