<script lang="ts">
	import {
		create_disclosure,
		create_reorder,
		create_roving_focus,
		create_selection,
		create_typeahead,
		register_control
	} from '../src/behaviors/index.js';
	import Surface from '../src/layout/surface.svelte';

	let {
		on_order = (_next: readonly string[]) => {}
	}: {
		on_order?: (next: readonly string[]) => void;
	} = $props();

	let ordered = $state<readonly string[]>(['alpha', 'beta', 'gamma', 'delta']);

	const disclosure = create_disclosure({ id: 'test-disc' });
	const selection = create_selection({
		order: () => ordered,
		mode: 'multiple'
	});
	const roving = create_roving_focus({
		items: () => ordered,
		orientation: 'vertical',
		disabled: (key) => key === 'gamma'
	});
	const typeahead = create_typeahead({
		items: () => ordered.map((key) => ({ key, text: key, disabled: key === 'gamma' })),
		active: () => roving.active,
		on_match: (key) => roving.focus(key)
	});
	const reorder = create_reorder({
		items: () => ordered,
		on_reorder: (_from, _to, next) => {
			ordered = next;
			on_order(next);
		}
	});

	$effect(() =>
		register_control({
			id: 'custom:list',
			kind: 'listbox',
			label: 'Items',
			state: () => ({ selected: selection.selected, open: disclosure.open }),
			actions: {
				toggle_details: () => disclosure.toggle(),
				select: (key) => {
					if (typeof key === 'string') selection.choose(key);
				}
			}
		})
	);
</script>

<Surface tone="card" padding="sm" data-testid="surface">
	<button data-testid="disc-trigger" {...disclosure.trigger_attrs()}>Details</button>
	<div data-testid="disc-content" {...disclosure.content_attrs()}>Hidden body</div>

	<div
		role="listbox"
		data-testid="list"
		tabindex="-1"
		onkeydown={(e) => {
			roving.root_attrs().onkeydown(e);
			typeahead.onkeydown(e);
		}}
	>
		{#each ordered as key (key)}
			{@const sel = selection.item_attrs(key)}
			{@const rov = roving.item_attrs(key)}
			{@const reo = reorder.item_attrs(key)}
			<div
				role="option"
				data-key={key}
				{@attach roving.item(key)}
				aria-selected={sel['aria-selected']}
				data-selected={sel['data-selected']}
				tabindex={rov.tabindex}
				draggable={reo.draggable}
				onclick={sel.onclick}
				onfocus={rov.onfocus}
				onkeydown={reo.onkeydown}
			>
				{key}
			</div>
		{/each}
	</div>
</Surface>
