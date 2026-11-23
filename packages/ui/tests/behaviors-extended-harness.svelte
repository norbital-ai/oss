<script lang="ts">
	import {
		create_accordion,
		create_clipboard,
		create_dismiss,
		create_field,
		create_focus_trap,
		create_listbox,
		create_pagination,
		create_resize,
		create_shortcuts,
		create_slider,
		create_stick_to_bottom,
		create_tree,
		type TreeNode
	} from '../src/behaviors/index.js';

	let {
		on_shortcut = (_name: string) => {},
		on_copy = (_ok: boolean, _val: string) => {}
	}: {
		on_shortcut?: (name: string) => void;
		on_copy?: (ok: boolean, val: string) => void;
	} = $props();

	const acc = create_accordion({
		items: () => ['sec1', 'sec2', 'sec3'],
		mode: 'single',
		collapsible: true,
		default_open: ['sec1'],
		control: { id: 'acc:test', label: 'FAQ' }
	});

	const listbox = create_listbox({
		items: () => [
			{ value: 'sg', label: 'Singapore', keywords: 'asia' },
			{ value: 'my', label: 'Malaysia', keywords: 'asia' },
			{ value: 'jp', label: 'Japan', disabled: true },
			{ value: 'us', label: 'United States', keywords: 'america' }
		],
		mode: 'single'
	});

	const treeNodes: readonly TreeNode[] = [
		{
			id: 'root-a',
			label: 'Engineering',
			children: [
				{ id: 'a-1', label: 'Platform' },
				{ id: 'a-2', label: 'Design' }
			]
		},
		{ id: 'root-b', label: 'Operations' }
	];
	const tree = create_tree({ nodes: () => treeNodes });

	let outerOpen = $state(false);
	let innerOpen = $state(false);
	let outerTrigger = $state<HTMLButtonElement | null>(null);
	const outerDismiss = create_dismiss({
		open: () => outerOpen,
		on_dismiss: () => (outerOpen = false),
		ignore: () => [outerTrigger]
	});
	const innerDismiss = create_dismiss({
		open: () => innerOpen,
		on_dismiss: () => (innerOpen = false)
	});

	let trapOpen = $state(false);
	const trap = create_focus_trap({ active: () => trapOpen });

	create_shortcuts([
		{ keys: 'mod+k', handler: () => on_shortcut('palette') },
		{ keys: 'mod+enter', allow_in_input: true, handler: () => on_shortcut('submit') }
	]);

	let panelWidth = $state(400);
	const resizer = create_resize({
		value: () => panelWidth,
		on_change: (next) => (panelWidth = next),
		min: 200,
		max: 600,
		step: 20,
		invert: true,
		label: 'Panel width'
	});

	const slider = create_slider({ default_value: 25, min: 0, max: 100, step: 5, label: 'Volume' });

	const pager = create_pagination({
		default_page: 2,
		total_pages: () => 10,
		control: { id: 'pager:test', label: 'Pages' }
	});

	const clip = create_clipboard({
		text: 'NORB-42',
		timeout_ms: 50,
		on_copy: (ok, val) => on_copy(ok, val)
	});

	let fieldErr = $state<string | undefined>('Required field');
	const field = create_field({
		id: 'emp-code',
		has_description: () => true,
		error: () => fieldErr,
		required: () => true
	});

	const tail = create_stick_to_bottom({ threshold: 20 });
</script>

<!-- Accordion -->
<div data-testid="acc" {...acc.root_attrs()}>
	{#each ['sec1', 'sec2', 'sec3'] as key (key)}
		<button data-acc-trigger={key} {@attach acc.item(key)} {...acc.trigger_attrs(key)}>
			{key}
		</button>
		<div data-acc-content={key} {...acc.content_attrs(key)}>Panel {key}</div>
	{/each}
</div>

<!-- Listbox -->
<input data-testid="lb-search" bind:value={listbox.query} />
<div data-testid="lb" {...listbox.list_attrs()}>
	{#each listbox.items as item (item.value)}
		<div data-lb-opt={item.value} {@attach listbox.item(item.value)} {...listbox.option_attrs(item.value)}>
			{item.label}
		</div>
	{/each}
</div>

<!-- Tree -->
<div data-testid="tree" {...tree.root_attrs()}>
	{#each tree.rows as row (row.id)}
		<div data-tree-row={row.id} {@attach tree.item(row.id)} {...tree.item_attrs(row.id)}>
			{row.label}
		</div>
	{/each}
</div>

<!-- LIFO Dismiss Layers -->
<button type="button" bind:this={outerTrigger} data-testid="open-outer" onclick={() => (outerOpen = true)}>
	Open Outer
</button>
<button type="button" data-testid="open-inner" onclick={() => (innerOpen = true)}>Open Inner</button>
<div data-testid="outside-area">Outside</div>
{#if outerOpen}
	<div data-testid="outer-layer" {@attach outerDismiss.surface}>Outer</div>
{/if}
{#if innerOpen}
	<div data-testid="inner-layer" {@attach innerDismiss.surface}>Inner</div>
{/if}

<!-- Focus Trap -->
<button type="button" data-testid="trap-opener" onclick={() => (trapOpen = !trapOpen)}>Trap</button>
{#if trapOpen}
	<div data-testid="trap-dialog" {@attach trap.container}>
		<button type="button" data-testid="trap-first">First</button>
		<button type="button" data-testid="trap-last">Last</button>
	</div>
{/if}

<!-- Shortcuts input -->
<input data-testid="shortcut-input" />

<!-- Resize handle -->
<div data-testid="resize-handle" {...resizer.handle_attrs()} data-width={panelWidth}></div>

<!-- Slider -->
<div data-testid="slider-track" {@attach slider.track}>
	<div data-testid="slider-thumb" {...slider.thumb_attrs()} data-percent={slider.percent}></div>
</div>

<!-- Pagination -->
<div data-testid="pager" data-page={pager.page} data-range={pager.range.join(',')}>
	<button type="button" data-testid="pager-prev" onclick={() => pager.previous()}>Prev</button>
	<button type="button" data-testid="pager-next" onclick={() => pager.next()}>Next</button>
	<button type="button" data-testid="pager-last" onclick={() => pager.last()}>Last</button>
</div>

<!-- Clipboard -->
<button
	type="button"
	data-testid="clip-btn"
	data-copied={clip.copied ? 'true' : 'false'}
	onclick={() => void clip.copy()}
>
	Copy
</button>

<!-- Field -->
<label data-testid="field-label" {...field.label_attrs()}>Code</label>
<input data-testid="field-input" {...field.control_attrs()} />
<p data-testid="field-desc" {...field.description_attrs()}>Help</p>
<p data-testid="field-err" {...field.error_attrs()}>{field.error}</p>
<button type="button" data-testid="field-clear-err" onclick={() => (fieldErr = undefined)}>
	Clear
</button>

<!-- Stick to bottom -->
<div data-testid="tail" data-stuck={tail.stuck ? 'true' : 'false'} {@attach tail.viewport}>
	<div>msg</div>
</div>
<button type="button" data-testid="tail-jump" onclick={() => tail.scroll_to_bottom()}>Jump</button>
