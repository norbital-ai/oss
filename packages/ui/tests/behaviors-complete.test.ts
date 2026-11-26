import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import BehaviorsCompleteHarness from './behaviors-complete-harness.svelte';
import {
	announce,
	aria_keyshortcuts,
	bridge_between,
	cell_bounds,
	cells_to_text,
	format_shortcut,
	inert_outside,
	input_hints,
	invoke_control,
	is_span_free,
	lock_scroll,
	nearest_in_direction,
	observe_controls,
	page_controls,
	prepare_announcements,
	resolve_control,
	set_announcer,
	spatial_move,
	stack_spans,
	subtree_end,
	text_to_cells,
	toggle_tree_checked,
	tree_checked_states,
	tree_from_paths,
	with_source
} from '../src/behaviors/index.js';

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`Expected ${label}`);
	return value;
}

it('verifies announcer, modal inert_outside & lock_scroll ref-counting, bridge_between and pure behavior helpers', () => {
	// 1. Announcer live regions & custom override
	prepare_announcements();
	const polite = document.querySelector('[data-norbital-announcer="polite"]');
	const assertive = document.querySelector('[data-norbital-announcer="assertive"]');
	expect(polite).not.toBeNull();
	expect(assertive).not.toBeNull();

	const heard: string[] = [];
	set_announcer((msg, priority) => heard.push(`${priority}:${msg}`));
	try {
		announce('Row moved');
		announce('Validation error', { priority: 'assertive' });
	} finally {
		set_announcer(undefined);
	}
	expect(heard).toEqual(['polite:Row moved', 'assertive:Validation error']);

	// 2. inert_outside ref-counting + live-region exemption + .keep()
	const app = document.body.appendChild(document.createElement('div'));
	const toastHost = document.body.appendChild(document.createElement('div'));
	const dialogA = document.body.appendChild(document.createElement('div'));
	const dialogB = document.body.appendChild(document.createElement('div'));
	const lockA = inert_outside(dialogA);
	lockA.keep(toastHost);
	expect(app.inert).toBe(true);
	expect(dialogA.inert).toBe(false);
	expect(toastHost.inert).toBe(false);
	expect(polite instanceof HTMLElement && polite.inert).toBe(false);

	const lockB = inert_outside(dialogB);
	expect(app.inert).toBe(true);
	lockA();
	// Still inert while dialogB holds a lock
	expect(app.inert).toBe(true);
	lockB();
	expect(app.inert).toBe(false);
	app.remove();
	toastHost.remove();
	dialogA.remove();
	dialogB.remove();

	// 3. lock_scroll ref-counting
	const s1 = lock_scroll();
	const s2 = lock_scroll();
	expect(document.body.style.overflow).toBe('hidden');
	s1();
	expect(document.body.style.overflow).toBe('hidden');
	s2();
	expect(document.body.style.overflow).toBe('');

	// 4. bridge_between safe corridor
	const inCorridor = bridge_between(
		{ left: 0, right: 100, top: 0, bottom: 30 },
		{ left: 140, right: 260, top: 0, bottom: 180 }
	);
	expect(inCorridor(120, 40)).toBe(true);
	expect(inCorridor(10, 170)).toBe(false);

	// 5. Tree helpers: tree_from_paths + cascading tri-state checkboxes
	const nodes = tree_from_paths(['src/b.ts', 'src/a.ts', 'README.md', 'src/sub/c.ts']);
	expect(nodes.map((n) => n.id)).toEqual(['src', 'README.md']);
	expect(nodes[0]?.children?.map((n) => n.id)).toEqual(['src/sub', 'src/a.ts', 'src/b.ts']);

	let checked = toggle_tree_checked(nodes, [], 'src', 'leaf');
	expect([...checked].sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/sub/c.ts']);
	checked = toggle_tree_checked(nodes, checked, 'src/a.ts', 'leaf');
	const states = tree_checked_states(nodes, checked);
	expect(states.get('src')).toBe('indeterminate');
	expect(states.get('src/sub')).toBe(true);
	expect(states.get('src/a.ts')).toBe(false);

	// 6. Grid TSV serialization + bounds
	const b = cell_bounds({ anchor: { row: 2, col: 1 }, end: { row: 0, col: 0 } });
	expect(b).toEqual({ top: 0, bottom: 2, left: 0, right: 1 });
	const tsv = cells_to_text({ top: 0, bottom: 1, left: 0, right: 1 }, ({ row, col }) => `${row}-${col}`);
	expect(tsv).toBe('0-0\t0-1\n1-0\t1-1');
	expect(text_to_cells(tsv)).toEqual([['0-0', '0-1'], ['1-0', '1-1']]);

	// 7. Shortcuts ARIA & formatting
	expect(aria_keyshortcuts('mod+k', 'mac')).toBe('Meta+K');
	expect(aria_keyshortcuts('mod+k', 'other')).toBe('Control+K');
	expect(aria_keyshortcuts('g i', 'mac')).toBe('G I');
	expect(format_shortcut('mod+shift+k', 'mac')).toBe('⌘⇧K');
	expect(format_shortcut('mod+k', 'other')).toBe('Ctrl+K');

	// 8. Subtree end, span helpers, input hints, spatial navigation
	expect(
		subtree_end(
			[
				{ id: 'a', depth: 0, parent: null },
				{ id: 'a1', depth: 1, parent: 'a' },
				{ id: 'a1a', depth: 2, parent: 'a1' },
				{ id: 'b', depth: 0, parent: null }
			],
			0
		)
	).toBe(3);
	expect(is_span_free([{ id: '1', track: 't1', start: 9, end: 11 }], 't1', 11, 12)).toBe(true);
	expect(is_span_free([{ id: '1', track: 't1', start: 9, end: 11 }], 't1', 10, 12)).toBe(false);
	const stacked = stack_spans([
		{ id: '1', track: 't1', start: 9, end: 12 },
		{ id: '2', track: 't1', start: 10, end: 13 },
		{ id: '3', track: 't1', start: 12, end: 14 }
	]);
	expect(stacked.map((s) => s.lane)).toEqual([0, 1, 0]);
	expect(stacked[0]?.lanes).toBe(2);

	expect(input_hints('one-time-code')).toMatchObject({ inputmode: 'numeric', autocomplete: 'one-time-code' });
	expect(input_hints('email')).toMatchObject({ inputmode: 'email', autocomplete: 'email', spellcheck: false });
	const rects = [
		{ left: 0, top: 0, width: 40, height: 40 },
		{ left: 60, top: 0, width: 40, height: 40 },
		{ left: 0, top: 60, width: 40, height: 40 }
	];
	const firstRect = must(rects[0], 'rect 0');
	expect(nearest_in_direction(firstRect, rects, 'right')).toBe(1);
	expect(nearest_in_direction(firstRect, rects, 'down')).toBe(2);

	const elA = document.createElement('button');
	const elB = document.createElement('button');
	elA.getBoundingClientRect = () => new DOMRect(0, 0, 40, 40);
	elB.getBoundingClientRect = () => new DOMRect(60, 0, 40, 40);
	expect(spatial_move(elA, [elA, elB], 'right')).toBe(elB);
});

it('exercises P0/P1/P2 interactive behaviors, agent observability and upgraded UI primitives', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
	try {
		const events: string[] = [];
		const fetchedQueries: string[] = [];
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(BehaviorsCompleteHarness, {
			target,
			props: {
				on_event: (e) => events.push(e),
				async_fetch: async (q, _signal, page) => {
					fetchedQueries.push(`${q}@${page}`);
					return { items: [`${q}-p${page}`], has_more: page === 0 };
				}
			}
		});
		await tick();

		// 1. Focus recovery when focused button unmounts
		const d1 = must(target.querySelector<HTMLButtonElement>('[data-dyn="d1"]'), 'd1');
		d1.focus();
		d1.click();
		flushSync();
		await Promise.resolve();
		expect(events).toContain('recover:d1');
		expect(document.activeElement).toBe(target.querySelector('[data-dyn="d2"]'));

		// 2. Presence + bind_findable
		must(target.querySelector<HTMLButtonElement>('[data-testid="toggle-presence"]'), 'pres btn').click();
		flushSync();
		expect(target.querySelector('[data-testid="pres-box"]')).not.toBeNull();
		const findable = must(target.querySelector<HTMLElement>('[data-testid="findable"]'), 'findable');
		findable.dispatchEvent(new Event('beforematch', { bubbles: true }));
		flushSync();
		expect(findable.hasAttribute('hidden')).toBe(false);

		// 3. Hover intent delay
		const hTrig = must(target.querySelector<HTMLButtonElement>('[data-testid="hover-trigger"]'), 'hover trigger');
		hTrig.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(50);
		flushSync();
		expect(target.querySelector('[data-testid="hover-popup"]')).not.toBeNull();

		// 4. Async options debounce + load_more
		const aInput = must(target.querySelector<HTMLInputElement>('[data-testid="async-input"]'), 'async-input');
		aInput.value = 'sg';
		aInput.dispatchEvent(new Event('input', { bubbles: true }));
		await vi.advanceTimersByTimeAsync(30);
		await tick();
		expect(fetchedQueries).toContain('sg@0');
		must(target.querySelector<HTMLButtonElement>('[data-testid="async-more"]'), 'async-more').click();
		await tick();
		expect(fetchedQueries).toContain('sg@1');
		expect(must(target.querySelector('[data-testid="async-status"]'), 'async-status').textContent).toBe('idle:sg-p0,sg-p1');

		// 5. Menu keyboard, checkbox item, context menu & control bridge
		must(target.querySelector<HTMLButtonElement>('[data-testid="menu-ctx"]'), 'menu-ctx').click();
		flushSync();
		expect(target.querySelector('[data-testid="menu-list"]')).not.toBeNull();
		const boldItem = must(target.querySelector<HTMLButtonElement>('[data-menu-item="bold"]'), 'bold');
		boldItem.click();
		flushSync();
		expect(boldItem.getAttribute('aria-checked')).toBe('true');
		// Checkbox stays open; invoking regular item closes it
		expect(invoke_control('menu:test', 'select', ['rename']).ok).toBe(true);
		flushSync();
		expect(events).toContain('menu:rename');
		expect(target.querySelector('[data-testid="menu-list"]')).toBeNull();

		// 6. Virtual-focus listbox (aria-activedescendant)
		const vlbInput = must(target.querySelector<HTMLInputElement>('[data-testid="vlb-input"]'), 'vlb-input');
		expect(vlbInput.getAttribute('aria-activedescendant')).toBeTruthy();
		vlbInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		// Skipped disabled beta -> gamma
		vlbInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(events).toContain('vlb:gamma');

		// 7. Grid focus + cell range + inline edit
		const grid = must(target.querySelector<HTMLElement>('[data-testid="grid"]'), 'grid');
		const c00 = must(target.querySelector<HTMLElement>('[data-cell="0:0"]'), 'cell 0:0');
		c00.focus();
		grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(document.activeElement).toBe(target.querySelector('[data-cell="0:1"]'));
		must(target.querySelector<HTMLButtonElement>('[data-testid="range-row0"]'), 'row0').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="range-bounds"]'), 'bounds').textContent?.trim()).toBe('0,0-0,2');

		const editCell = must(target.querySelector<HTMLElement>('[data-cell-edit="0:0"]'), 'edit cell');
		editCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
		flushSync();
		const inlineIn = must(target.querySelector<HTMLInputElement>('[data-testid="inline-input"]'), 'inline-input');
		inlineIn.value = '450';
		inlineIn.dispatchEvent(new Event('input', { bubbles: true }));
		inlineIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
		flushSync();
		expect(events).toContain('edit:0:0=450');
		expect(events).toContain('edit-tab:0:0:1');

		// 8. Transfer keyboard move (Alt+ArrowRight) + tree reorder (with descendant cycle guard) + resize box
		const t1 = must(target.querySelector<HTMLButtonElement>('[data-titem="t1"]'), 't1');
		t1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }));
		flushSync();
		expect(events.some((e) => e.startsWith('transfer:') && e.includes('t1'))).toBe(true);

		must(target.querySelector<HTMLButtonElement>('[data-testid="tree-cycle"]'), 'tree-cycle').click();
		must(target.querySelector<HTMLButtonElement>('[data-testid="tree-move"]'), 'tree-move').click();
		flushSync();
		expect(events).not.toContain('tree-move:folder-a:inside:file-a1');
		expect(events).toContain('tree-move:folder-a:after:folder-b');

		const boxHandle = must(target.querySelector<HTMLElement>('[data-testid="box-handle"]'), 'box-handle');
		boxHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		boxHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(must(target.querySelector('[data-testid="box-size"]'), 'box-size').textContent).toBe('220x170');

		// 9. Calendar 2D keyboard navigation
		const june10 = must(target.querySelector<HTMLButtonElement>('[data-cal-day="2026-06-10"]'), '2026-06-10');
		june10.focus();
		june10.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		await tick();
		expect(document.activeElement).toBe(target.querySelector('[data-cal-day="2026-06-17"]'));

		// 10. Multi-thumb range slider
		const thumb0 = must(target.querySelector<HTMLElement>('[data-testid="range-thumb-0"]'), 'thumb 0');
		thumb0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(must(target.querySelector('[data-testid="range-vals"]'), 'range-vals').textContent).toBe('25,80');
		expect(events).toContain('slider-commit:25-80');

		// 11. Chord shortcuts, input history, undo stack, hold & repeat
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }));
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
		flushSync();
		expect(events).toContain('chord:go-inbox');

		const comp = must(target.querySelector<HTMLTextAreaElement>('[data-testid="composer"]'), 'composer');
		comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		flushSync();
		expect(comp.value).toBe('second msg');
		comp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		flushSync();
		expect(comp.value).toBe('first msg');

		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-rec1"]'), 'r1').click();
		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-rec2"]'), 'r2').click();
		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-rec3"]'), 'r3').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="undo-val"]'), 'undo-val').textContent).toBe('v3');
		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-do"]'), 'undo').click();
		flushSync();
		// r1 and r2 coalesced within 500ms group -> one undo lands on v2, next lands on v0
		expect(must(target.querySelector('[data-testid="undo-val"]'), 'undo-val').textContent).toBe('v2');
		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-do"]'), 'undo2').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="undo-val"]'), 'undo-val').textContent).toBe('v0');
		must(target.querySelector<HTMLButtonElement>('[data-testid="redo-do"]'), 'redo').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="undo-val"]'), 'undo-val').textContent).toBe('v2');

		const holdBtn = must(target.querySelector<HTMLButtonElement>('[data-testid="hold-btn"]'), 'hold-btn');
		holdBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
		await vi.advanceTimersByTimeAsync(100);
		flushSync();
		expect(holdBtn.textContent).toBe('1');

		const repeatBtn = must(target.querySelector<HTMLButtonElement>('[data-testid="repeat-btn"]'), 'repeat-btn');
		repeatBtn.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
		await vi.advanceTimersByTimeAsync(110);
		repeatBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		flushSync();
		expect(Number(repeatBtn.textContent)).toBeGreaterThanOrEqual(3);

		// 12. Canvas & direct manipulation
		const moverEl = must(target.querySelector<HTMLElement>('[data-testid="mover"]'), 'mover');
		moverEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(moverEl.textContent).toBe('30,30');

		const areaEl = must(target.querySelector<HTMLElement>('[data-testid="area"]'), 'area');
		areaEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(areaEl.textContent).toBe('0.6,0.5');

		must(target.querySelector<HTMLButtonElement>('[data-testid="span-add"]'), 'span-add').click();
		flushSync();
		expect(events).toContain('span:draw:2');
		const span1 = must(target.querySelector<HTMLElement>('[data-span="s1"]'), 'span s1');
		span1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(span1.textContent).toBe('tue:9-11');
		span1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(span1.textContent).toBe('tue:10-12');

		must(target.querySelector<HTMLButtonElement>('[data-testid="vp-zoom"]'), 'vp-zoom').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="viewport"]'), 'viewport').textContent).toBe('2');

		const portA = must(target.querySelector<HTMLButtonElement>('[data-testid="port-a"]'), 'port-a');
		const portB = must(target.querySelector<HTMLButtonElement>('[data-testid="port-b"]'), 'port-b');
		portA.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		portB.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(events).toContain('connect:a->b');

		const swipeRow = must(target.querySelector<HTMLElement>('[data-testid="swipe-row"]'), 'swipe-row');
		swipeRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
		flushSync();
		expect(swipeRow.textContent).toBe('end');

		// 13. Extra headless controls
		const swBtn = must(target.querySelector<HTMLButtonElement>('[data-testid="sw"]'), 'sw');
		swBtn.click();
		flushSync();
		expect(swBtn.getAttribute('aria-checked')).toBe('true');

		const radioGroup = must(target.querySelector<HTMLElement>('[data-testid="radios"]'), 'radios');
		const radioDay = must(target.querySelector<HTMLButtonElement>('[data-radio="day"]'), 'radio day');
		radioDay.focus();
		radioGroup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(must(target.querySelector('[data-radio="week"]'), 'week').getAttribute('aria-checked')).toBe('true');

		const boldToggle = must(target.querySelector<HTMLButtonElement>('[data-toggle="bold"]'), 'toggle bold');
		boldToggle.click();
		flushSync();
		expect(boldToggle.getAttribute('aria-pressed')).toBe('true');

		const numEl = must(target.querySelector<HTMLInputElement>('[data-testid="num-input"]'), 'num-input');
		numEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
		flushSync();
		expect(numEl.value).toBe('15');

		const star5 = must(target.querySelector<HTMLButtonElement>('[data-star="5"]'), 'star 5');
		star5.click();
		flushSync();
		expect(star5.getAttribute('aria-checked')).toBe('true');

		const tb = must(target.querySelector<HTMLElement>('[data-testid="toolbar"]'), 'toolbar');
		const tbCut = must(target.querySelector<HTMLButtonElement>('[data-tb="cut"]'), 'cut');
		tbCut.focus();
		tb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(document.activeElement).toBe(target.querySelector('[data-tb="copy"]'));

		// 14. Agent observability: confirm gating, secret redaction, hidden filtering, source history undo
		const visibleIds = page_controls().map((c) => c.id);
		expect(visibleIds).toContain('custom:counter');
		expect(visibleIds).toContain('custom:secret');
		expect(visibleIds).not.toContain('custom:hidden');

		const secretSnap = page_controls().find((c) => c.id === 'custom:secret');
		expect(secretSnap?.secret).toBe(true);
		expect(secretSnap?.state).toEqual({ value: '[redacted]' });

		const resolved = resolve_control('Counter');
		expect('entry' in resolved).toBe(true);

		const observed: string[] = [];
		const stopObserve = observe_controls((evt) => observed.push(`${evt.source}:${evt.id}:${evt.key}=${String(evt.value)}`));
		try {
			// Blocked without allow_confirm because element carries data-agent-confirm
			const blocked = invoke_control('custom:counter', 'set', [42]);
			expect(blocked.ok).toBe(false);
			expect(blocked.confirm).toBe('Confirm counter update?');

			// Allowed with explicit allow_confirm under agent source
			const okRes = with_source('agent', () =>
				invoke_control('custom:counter', 'set', [42], { allow_confirm: true })
			);
			expect(okRes.ok).toBe(true);
			flushSync();
			expect(must(target.querySelector('[data-testid="counter-val"]'), 'counter').textContent).toBe('42');
			expect(observed).toEqual(['agent:custom:counter:value=42']);
		} finally {
			stopObserve();
		}

		// Undo only the agent's mutation
		must(target.querySelector<HTMLButtonElement>('[data-testid="undo-agent"]'), 'undo-agent').click();
		flushSync();
		expect(must(target.querySelector('[data-testid="counter-val"]'), 'counter').textContent).toBe('0');

		// 15. Upgraded primitives: Accordion roving + beforematch, TabStrip roving, Combobox activedescendant, Toast action
		const acc1 = must(target.querySelector<HTMLButtonElement>('[data-testid="prim-acc-1"]'), 'prim-acc-1');
		const acc2 = must(target.querySelector<HTMLButtonElement>('[data-testid="prim-acc-2"]'), 'prim-acc-2');
		acc1.focus();
		acc1.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(document.activeElement).toBe(acc2);
		const accC2 = must(target.querySelector<HTMLElement>('[data-testid="prim-acc-c2"]'), 'prim-acc-c2');
		accC2.dispatchEvent(new Event('beforematch', { bubbles: true }));
		flushSync();
		expect(acc2.getAttribute('aria-expanded')).toBe('true');

		const tabs = target.querySelectorAll<HTMLButtonElement>('[role="tab"]');
		const tab0 = must(tabs[0], 'tab0');
		const tab1 = must(tabs[1], 'tab1');
		tab0.focus();
		tab0.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		expect(document.activeElement).toBe(tab1);

		const comboTrigger = must(target.querySelector<HTMLButtonElement>('[role="combobox"]'), 'combobox');
		comboTrigger.click();
		flushSync();
		expect(comboTrigger.getAttribute('aria-controls')).toBeTruthy();
		expect(comboTrigger.getAttribute('aria-activedescendant')).toBeTruthy();

		must(target.querySelector<HTMLButtonElement>('[data-testid="fire-toast"]'), 'fire-toast').click();
		flushSync();
		const toastAction = must(
			[...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Undo'),
			'toast Undo button'
		);
		toastAction.click();
		flushSync();
		expect(events).toContain('toast:undo');

		await unmount(view);
		target.remove();
	} finally {
		vi.useRealTimers();
	}
});
