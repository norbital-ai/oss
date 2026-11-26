<script lang="ts">
	import { CalendarDate, type DateValue } from '@internationalized/date';
	import {
		Accordion,
		Combobox,
		TabStrip,
		Toaster,
		toast
	} from '../src/index.js';
	import {
		bind_findable,
		bind_hold,
		bind_repeat,
		bind_scroll_picker,
		create_area,
		create_async_options,
		create_calendar,
		create_cell_range,
		create_connect,
		create_focus_recovery,
		create_grid_focus,
		create_hover_intent,
		create_inline_edit,
		create_input_history,
		create_lasso,
		create_listbox,
		create_menu,
		create_move,
		create_number_input,
		create_presence,
		create_radio_group,
		create_rating,
		create_resize_box,
		create_shortcuts,
		create_slider,
		create_spans,
		create_swipe_actions,
		create_switch,
		create_toggle_group,
		create_toolbar,
		create_transfer,
		create_tree_reorder,
		create_ui_history,
		create_undo_stack,
		create_viewport,
		register_control,
		type Span,
		type TreeReorderRow
	} from '../src/behaviors/index.js';

	let {
		on_event,
		async_fetch
	}: {
		on_event: (entry: string) => void;
		async_fetch: (query: string, signal: AbortSignal, page: number) => Promise<{ items: string[]; has_more: boolean }>;
	} = $props();

	// 1. Focus recovery over dynamic list
	let dynItems = $state(['d1', 'd2', 'd3']);
	const dynEls = new Map<string, HTMLElement>();
	const recovery = create_focus_recovery({
		fallback: (lost) => {
			on_event(`recover:${lost.key}`);
			const remaining = dynItems.filter((k) => k !== lost.key);
			const nextKey = remaining[0];
			return nextKey !== undefined ? dynEls.get(nextKey) : null;
		}
	});
	function registerDynEl(key: string) {
		return (el: HTMLElement) => {
			dynEls.set(key, el);
			return () => {
				if (dynEls.get(key) === el) dynEls.delete(key);
			};
		};
	}

	// 2. Presence + findable
	let presOpen = $state(false);
	const presence = create_presence({ open: () => presOpen });
	let findOpen = $state(false);

	// 3. Hover intent
	let hoverOpen = $state(false);
	let hoverTriggerEl = $state<HTMLElement | null>(null);
	let hoverPopupEl = $state<HTMLElement | null>(null);
	const hover = create_hover_intent({
		open: () => hoverOpen,
		trigger: () => hoverTriggerEl,
		popup: () => hoverPopupEl,
		on_open: () => (hoverOpen = true),
		on_close: () => (hoverOpen = false),
		open_delay: 40,
		close_delay: 40,
		group: 'test-tips'
	});

	// 4. Async options
	const asyncOpts = create_async_options({
		debounce_ms: 20,
		load: (q, { signal, page }) => async_fetch(q, signal, page)
	});

	// 5. Menu
	let menuBold = $state(false);
	const menu = create_menu({
		label: 'Actions',
		control: { id: 'menu:test', label: 'Row actions' },
		items: () => [
			{ id: 'rename', label: 'Rename', on_select: () => on_event('menu:rename') },
			{ id: 'disabled', label: 'Disabled', disabled: true, on_select: () => on_event('menu:disabled') },
			{ id: 'bold', label: 'Bold', role: 'menuitemcheckbox', checked: menuBold, on_select: () => (menuBold = !menuBold) },
			{ id: 'delete', label: 'Delete', on_select: () => on_event('menu:delete') }
		]
	});

	// 6. Virtual-focus Listbox
	let vlbSelected = $state<string | undefined>(undefined);
	const vlb = create_listbox({
		focus: 'virtual',
		filter: false,
		items: () => [
			{ value: 'alpha', label: 'Alpha' },
			{ value: 'beta', label: 'Beta', disabled: true },
			{ value: 'gamma', label: 'Gamma' }
		],
		selected: () => (vlbSelected !== undefined ? [vlbSelected] : []),
		on_change: (ids) => {
			vlbSelected = ids[0];
			on_event(`vlb:${ids[0] ?? ''}`);
		}
	});

	// 7. Grid focus + cell range + inline edit
	const gridFocus = create_grid_focus({ rows: () => 3, cols: () => 3 });
	const cellRange = create_cell_range({ rows: () => 3, cols: () => 3 });
	let cellValues = $state<Record<string, string>>({ '0:0': '100', '0:1': '200' });
	const inlineEdit = create_inline_edit({
		value: (id) => cellValues[id] ?? '',
		commit: (id, text) => {
			cellValues = { ...cellValues, [id]: text };
			on_event(`edit:${id}=${text}`);
		},
		on_tab: (id, dir) => on_event(`edit-tab:${id}:${dir}`)
	});

	// 8. Transfer + tree reorder + resize box
	let transferLists = $state<Readonly<Record<string, readonly string[]>>>({
		todo: ['t1', 't2'],
		done: ['t3']
	});
	const transfer = create_transfer({
		containers: () => ['todo', 'done'],
		lists: () => transferLists,
		on_commit: (next) => {
			transferLists = next;
			on_event(`transfer:${(next['done'] ?? []).join(',')}`);
		}
	});

	let treeRows = $state<TreeReorderRow[]>([
		{ id: 'folder-a', depth: 0, parent: null },
		{ id: 'file-a1', depth: 1, parent: 'folder-a' },
		{ id: 'folder-b', depth: 0, parent: null }
	]);
	const treeReorder = create_tree_reorder({
		rows: () => treeRows,
		on_move: (id, place) => {
			on_event(`tree-move:${id}:${place.position}:${place.target}`);
		}
	});

	let box = $state({ width: 200, height: 150 });
	const boxResize = create_resize_box({
		size: () => box,
		min_width: 100,
		max_width: 400,
		min_height: 80,
		max_height: 300,
		step: 20,
		on_change: (next) => (box = next)
	});

	// 9. Calendar 2D keyboard
	let calVal = $state<DateValue | undefined>(new CalendarDate(2026, 6, 10));
	const calendar = create_calendar({
		value: () => calVal,
		on_select: (d) => {
			calVal = d;
			on_event(`cal:${d.toString()}`);
		}
	});

	// 10. Multi-thumb range slider + commit
	let rangeVals = $state<readonly number[]>([20, 80]);
	const rangeSlider = create_slider({
		min: 0,
		max: 100,
		step: 5,
		values: () => rangeVals,
		on_values_change: (next) => (rangeVals = next),
		on_values_commit: (next) => on_event(`slider-commit:${next.join('-')}`),
		label: 'Price range',
		control: { id: 'slider:price', label: 'Price range' }
	});

	// 11. Chord shortcuts + input history + undo stack + hold + repeat
	create_shortcuts([
		{ keys: 'g i', handler: () => on_event('chord:go-inbox') },
		{ keys: 'g p', handler: () => on_event('chord:go-projects') }
	]);

	let composer = $state('');
	const inputHist = create_input_history({
		entries: () => ['first msg', 'second msg'],
		read: () => composer,
		write: (v) => {
			composer = v;
		}
	});

	const undoStack = create_undo_stack('v0', { group_delay_ms: 500 });
	let holdCount = $state(0);
	let repeatCount = $state(0);

	// 12. Canvas & spatial behaviors
	let nodePos = $state({ x: 20, y: 30 });
	const mover = create_move({
		position: () => nodePos,
		grid: 10,
		bounds: () => ({ min_x: 0, max_x: 100, min_y: 0, max_y: 100 }),
		on_change: (pt) => (nodePos = pt)
	});
	const area = create_area({
		default_value: { x: 0.5, y: 0.5 },
		min_x: 0,
		max_x: 1,
		min_y: 0,
		max_y: 1,
		step_x: 0.1,
		step_y: 0.1
	});
	let spansData = $state<readonly Span[]>([{ id: 's1', track: 'mon', start: 9, end: 11 }]);
	const spans = create_spans({
		tracks: () => ['mon', 'tue'],
		spans: () => spansData,
		min: 8,
		max: 18,
		step: 1,
		create_span: (base) => base,
		on_commit: (next, action) => {
			spansData = next;
			on_event(`span:${action}:${next.length}`);
		}
	});
	const lasso = create_lasso({ on_change: (keys) => on_event(`lasso:${keys.join(',')}`) });
	const viewport = create_viewport({ initial: { x: 0, y: 0, zoom: 1 } });
	const connector = create_connect({ on_connect: (a, b) => on_event(`connect:${a}->${b}`) });
	const swipe = create_swipe_actions({ on_full_swipe: (k, side) => on_event(`swipe:${k}:${side}`) });
	let pickedIdx = $state(0);

	// 13. Extra headless controls
	const sw = create_switch({ label: 'Auto-sync', control: { id: 'switch:sync', label: 'Auto-sync' } });
	const radios = create_radio_group({
		items: () => ['day', 'week', 'month'],
		default_value: 'day',
		label: 'Cadence',
		control: { id: 'radio:cadence', label: 'Cadence' }
	});
	const toggles = create_toggle_group({
		items: () => ['bold', 'italic'],
		mode: 'multiple',
		label: 'Format',
		control: { id: 'toggle:format', label: 'Format' }
	});
	const numInput = create_number_input({
		default_value: 10,
		min: 0,
		max: 50,
		step: 5,
		label: 'Quantity',
		control: { id: 'number:qty', label: 'Quantity' }
	});
	const rating = create_rating({ max: 5, default_value: 3, label: 'Score' });
	const toolbar = create_toolbar({ items: () => ['cut', 'copy', 'paste'], label: 'Edit tools' });

	// 14. Agent observability & UI history
	let counter = $state(0);
	let confirmEl = $state<HTMLElement | null>(null);
	let secretEl = $state<HTMLElement | null>(null);
	let hiddenEl = $state<HTMLElement | null>(null);
	const uiHistory = create_ui_history();
	$effect(() => () => uiHistory.destroy());

	$effect(() =>
		register_control({
			id: 'custom:counter',
			kind: 'counter',
			label: 'Counter',
			element: () => confirmEl,
			state: () => ({ value: counter }),
			actions: {
				set: (v) => {
					if (typeof v === 'number') counter = v;
				}
			}
		})
	);
	$effect(() =>
		register_control({
			id: 'custom:secret',
			kind: 'input',
			label: 'API Key',
			element: () => secretEl,
			state: () => ({ value: 'sk-live-secret' })
		})
	);
	$effect(() =>
		register_control({
			id: 'custom:hidden',
			kind: 'button',
			label: 'Internal',
			element: () => hiddenEl,
			state: () => ({})
		})
	);

	// 15. Upgraded primitives
	let comboVal = $state<string | null>(null);
	let tabVal = $state('overview');
</script>

<div>
	<!-- Focus recovery -->
	<div data-testid="dyn-list">
		{#each dynItems as id (id)}
			<button
				type="button"
				data-dyn={id}
				{@attach recovery.item(id)}
				{@attach registerDynEl(id)}
				onclick={() => (dynItems = dynItems.filter((k) => k !== id))}
			>{id}</button>
		{/each}
	</div>

	<!-- Presence & findable -->
	<button type="button" data-testid="toggle-presence" onclick={() => (presOpen = !presOpen)}>pres</button>
	{#if presence.present}
		<div data-testid="pres-box" {@attach presence.attach}>{presence.state}</div>
	{/if}
	<div data-testid="findable" {@attach bind_findable({ open: () => findOpen, on_reveal: () => (findOpen = true) })}>
		Find me
	</div>

	<!-- Hover intent -->
	<button
		type="button"
		data-testid="hover-trigger"
		bind:this={hoverTriggerEl}
		onpointerenter={(e) => hover.enter(e, true)}
		onpointerleave={(e) => hover.leave(e)}
	>Hover</button>
	{#if hoverOpen}
		<div
			role="tooltip"
			data-testid="hover-popup"
			bind:this={hoverPopupEl}
			onpointerenter={(e) => hover.enter(e, false)}
			onpointerleave={(e) => hover.leave(e)}
		>Tip</div>
	{/if}

	<!-- Async options -->
	<input
		data-testid="async-input"
		value={asyncOpts.query}
		oninput={(e) => (asyncOpts.query = e.currentTarget.value)}
	/>
	<button type="button" data-testid="async-more" onclick={() => void asyncOpts.load_more()}>More</button>
	<div data-testid="async-status">{asyncOpts.status}:{asyncOpts.items.join(',')}</div>

	<!-- Menu -->
	<button data-testid="menu-trigger" {...menu.trigger_attrs()} {@attach menu.trigger}>Menu</button>
	<button type="button" data-testid="menu-ctx" onclick={() => menu.open_at({ x: 100, y: 120 })}>Ctx</button>
	{#if menu.open}
		<div data-testid="menu-list" {...menu.menu_attrs()} {@attach menu.content}>
			{#each ['rename', 'disabled', 'bold', 'delete'] as id (id)}
				<button type="button" data-menu-item={id} {...menu.item_attrs(id)} {@attach menu.item(id)}>{id}</button>
			{/each}
		</div>
	{/if}

	<!-- Virtual-focus listbox -->
	<input data-testid="vlb-input" {...vlb.input_attrs()} />
	<div data-testid="vlb-list" {...vlb.list_attrs()}>
		{#each vlb.items as opt (opt.value)}
			<div data-vlb-opt={opt.value} {...vlb.option_attrs(opt.value)}>{opt.label}</div>
		{/each}
	</div>

	<!-- Grid focus + range + inline edit -->
	<div data-testid="grid" {...gridFocus.grid_attrs()}>
		{#each [0, 1, 2] as r (r)}
			<div role="row">
				{#each [0, 1, 2] as c (c)}
					{@const cid = `${r}:${c}`}
					{@const pos = { row: r, col: c }}
					<div
						data-cell={cid}
						{...gridFocus.cell_attrs(pos)}
						{...cellRange.cell_attrs(pos)}
						{@attach gridFocus.cell(pos)}
					>
						{#if inlineEdit.is_editing(cid)}
							<input data-testid="inline-input" {@attach inlineEdit.input} {...inlineEdit.input_attrs()} />
						{:else}
							<span data-cell-edit={cid} {...inlineEdit.cell_attrs(cid)}>{cellValues[cid] ?? ''}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/each}
	</div>
	<button type="button" data-testid="range-row0" onclick={() => cellRange.select_row(0)}>Row0</button>
	<div data-testid="range-bounds">
		{cellRange.bounds ? `${cellRange.bounds.top},${cellRange.bounds.left}-${cellRange.bounds.bottom},${cellRange.bounds.right}` : 'none'}
	</div>

	<!-- Transfer + tree reorder + resize box -->
	<div data-testid="transfer">
		{#each ['todo', 'done'] as listId (listId)}
			<div data-list={listId} {@attach transfer.container(listId)}>
				{#each transfer.lists[listId] ?? [] as id (id)}
					<button type="button" data-titem={id} {@attach transfer.item(id)} {...transfer.item_attrs(id)}>{id}</button>
				{/each}
			</div>
		{/each}
	</div>
	<button type="button" data-testid="tree-move" onclick={() => treeReorder.commit('folder-a', { target: 'folder-b', position: 'after' })}>MoveBranch</button>
	<button type="button" data-testid="tree-cycle" onclick={() => treeReorder.commit('folder-a', { target: 'file-a1', position: 'inside' })}>Cycle</button>
	<div data-testid="box-size">{box.width}x{box.height}</div>
	<div data-testid="box-handle" {...boxResize.handle_attrs('xy')}></div>

	<!-- Calendar -->
	<div data-testid="calendar">
		{#each calendar.months as month (month.value.toString())}
			{#each month.weeks as week, wi (wi)}
				{#each week as date (date.toString())}
					<button
						type="button"
						data-cal-day={date.toString()}
						{@attach calendar.day_ref(date)}
						{...calendar.day_attrs(date, month.value)}
					>{date.day}</button>
				{/each}
			{/each}
		{/each}
	</div>

	<!-- Multi-thumb range slider -->
	<div data-testid="range-track" {@attach rangeSlider.track}>
		<div data-testid="range-thumb-0" {...rangeSlider.thumb_attrs(0)}></div>
		<div data-testid="range-thumb-1" {...rangeSlider.thumb_attrs(1)}></div>
	</div>
	<div data-testid="range-vals">{rangeVals.join(',')}</div>

	<!-- Input history, undo stack, hold, repeat -->
	<textarea data-testid="composer" bind:value={composer} onkeydown={inputHist.onkeydown}></textarea>
	<button type="button" data-testid="undo-rec1" onclick={() => undoStack.record('v1', { group: 'type', time: 1000 })}>r1</button>
	<button type="button" data-testid="undo-rec2" onclick={() => undoStack.record('v2', { group: 'type', time: 1200 })}>r2</button>
	<button type="button" data-testid="undo-rec3" onclick={() => undoStack.record('v3', { time: 2000 })}>r3</button>
	<button type="button" data-testid="undo-do" onclick={() => undoStack.undo()}>undo</button>
	<button type="button" data-testid="redo-do" onclick={() => undoStack.redo()}>redo</button>
	<div data-testid="undo-val">{undoStack.current}</div>
	<button type="button" data-testid="hold-btn" {@attach bind_hold({ delay: 80, on_hold: () => (holdCount += 1) })}>{holdCount}</button>
	<button type="button" data-testid="repeat-btn" {@attach bind_repeat({ delay: 50, interval: 25, on_step: () => (repeatCount += 1) })}>{repeatCount}</button>

	<!-- Canvas -->
	<div data-testid="mover" {@attach mover.handle} {...mover.handle_attrs()}>{nodePos.x},{nodePos.y}</div>
	<div data-testid="area" {@attach area.surface} {...area.thumb_attrs()}>{area.value.x},{area.value.y}</div>
	<div data-testid="spans">
		{#each spans.spans as s (s.id)}
			<div data-span={s.id} {...spans.span_attrs(s)}>{s.track}:{s.start}-{s.end}</div>
		{/each}
		<button type="button" data-testid="span-add" onclick={() => spans.create('tue', 10, 12)}>add</button>
	</div>
	<div data-testid="lasso" {@attach lasso.surface}>
		<div data-lasso-item="k1" {@attach lasso.item('k1')}>k1</div>
	</div>
	<div data-testid="viewport" {@attach viewport.surface}>{viewport.zoom}</div>
	<button type="button" data-testid="vp-zoom" onclick={() => viewport.set_camera({ zoom: 2 })}>z2</button>
	<button type="button" data-testid="port-a" {@attach connector.port('a')} {...connector.port_attrs('a')}>A</button>
	<button type="button" data-testid="port-b" {@attach connector.port('b')} {...connector.port_attrs('b')}>B</button>
	<div data-testid="swipe-row" {@attach swipe.row('r1')} {...swipe.row_attrs('r1')}>{swipe.open?.side ?? 'closed'}</div>
	<div data-testid="scroll-picker" {@attach bind_scroll_picker({ on_select: (i) => (pickedIdx = i) })}>{pickedIdx}</div>

	<!-- Extra headless controls -->
	<button data-testid="sw" {...sw.attrs()}>{sw.checked ? 'on' : 'off'}</button>
	<div data-testid="radios" {...radios.root_attrs()}>
		{#each ['day', 'week', 'month'] as v (v)}
			<button data-radio={v} {@attach radios.item(v)} {...radios.item_attrs(v)}>{v}</button>
		{/each}
	</div>
	<div data-testid="toggles" {...toggles.root_attrs()}>
		{#each ['bold', 'italic'] as v (v)}
			<button data-toggle={v} {@attach toggles.item(v)} {...toggles.item_attrs(v)}>{v}</button>
		{/each}
	</div>
	<input data-testid="num-input" {...numInput.input_attrs()} />
	<button type="button" data-testid="num-inc" {@attach numInput.increment_button}>+</button>
	<div data-testid="rating" {...rating.root_attrs()}>
		{#each rating.items as n (n)}
			<button data-star={n} {@attach rating.item(n)} {...rating.item_attrs(n)}>{n}</button>
		{/each}
	</div>
	<div data-testid="toolbar" {...toolbar.root_attrs()}>
		{#each ['cut', 'copy', 'paste'] as k (k)}
			<button type="button" data-tb={k} {@attach toolbar.item(k)} {...toolbar.item_attrs(k)}>{k}</button>
		{/each}
	</div>

	<!-- Agent marks & UI history -->
	<div bind:this={confirmEl} data-agent-confirm="Confirm counter update?" data-testid="counter-val">{counter}</div>
	<div bind:this={secretEl} data-agent-secret>secret</div>
	<div bind:this={hiddenEl} data-agent-hidden>hidden</div>
	<button type="button" data-testid="undo-agent" onclick={() => uiHistory.undo_source('agent')}>UndoAgent</button>

	<!-- Upgraded primitives -->
	<Accordion.Root type="single" value="a1">
		<Accordion.Item value="a1">
			<Accordion.Trigger data-testid="prim-acc-1">Section 1</Accordion.Trigger>
			<Accordion.Content data-testid="prim-acc-c1" hidden_until_found>First body</Accordion.Content>
		</Accordion.Item>
		<Accordion.Item value="a2">
			<Accordion.Trigger data-testid="prim-acc-2">Section 2</Accordion.Trigger>
			<Accordion.Content data-testid="prim-acc-c2" hidden_until_found>Second body</Accordion.Content>
		</Accordion.Item>
	</Accordion.Root>

	<TabStrip
		value={tabVal}
		label="Sections"
		on_value_change={(name) => (tabVal = name)}
		items={[
			{ name: 'overview', title: 'Overview' },
			{ name: 'activity', title: 'Activity' }
		]}
	/>

	<Combobox
		placeholder="Fruit"
		options={[
			{ value: 'apple', label: 'Apple' },
			{ value: 'pear', label: 'Pear' }
		]}
		value={comboVal}
		on_change={(v) => (comboVal = v)}
	/>

	<button
		type="button"
		data-testid="fire-toast"
		onclick={() => toast.info('Saved', { action: { label: 'Undo', on_click: () => on_event('toast:undo') } })}
	>Toast</button>
	<Toaster />
</div>
