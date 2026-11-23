import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import BehaviorsExtendedHarness from './behaviors-extended-harness.svelte';
import Sheet from '../src/primitives/sheet/sheet.svelte';
import Combobox from '../src/primitives/combobox/combobox.svelte';
import TabStrip from '../src/primitives/tabs/tab-strip.svelte';
import CopyText from '../src/primitives/copy-text/copy-text.svelte';
import {
	act_on_control,
	matches_shortcut,
	page_controls,
	page_range
} from '../src/behaviors/index.js';

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`Expected ${label}`);
	return value;
}

it('exercises accordion, listbox, tree, LIFO dismiss, focus trap, shortcuts, resize, slider, pagination, clipboard, field and stick-to-bottom', async () => {
	const shortcuts: string[] = [];
	const copies: Array<{ ok: boolean; value: string }> = [];
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: async () => {} }
	});

	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(BehaviorsExtendedHarness, {
		target,
		props: {
			on_shortcut: (name) => shortcuts.push(name),
			on_copy: (ok, value) => copies.push({ ok, value })
		}
	});
	await tick();

	// 1. Accordion: default open sec1, click sec2 switches, act_on_control toggles
	const accTrigger = (k: string) =>
		must(target.querySelector<HTMLButtonElement>(`[data-acc-trigger="${k}"]`), `acc ${k}`);
	const accPanel = (k: string) =>
		must(target.querySelector<HTMLElement>(`[data-acc-content="${k}"]`), `acc panel ${k}`);
	expect(accTrigger('sec1').getAttribute('aria-expanded')).toBe('true');
	expect(accPanel('sec1').hidden).toBe(false);
	expect(accPanel('sec2').hidden).toBe(true);
	accTrigger('sec2').click();
	flushSync();
	expect(accPanel('sec1').hidden).toBe(true);
	expect(accPanel('sec2').hidden).toBe(false);
	expect(act_on_control('acc:test', 'expand', ['sec3'])).toBe(true);
	flushSync();
	expect(accPanel('sec3').hidden).toBe(false);

	// 2. Listbox: filter + keyboard nav skipping disabled + select
	const lbSearch = must(target.querySelector<HTMLInputElement>('[data-testid="lb-search"]'), 'lb-search');
	lbSearch.value = 'asia';
	lbSearch.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	expect(target.querySelectorAll('[data-lb-opt]').length).toBe(2);
	lbSearch.value = '';
	lbSearch.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	const lb = must(target.querySelector<HTMLElement>('[data-testid="lb"]'), 'lb');
	lb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	flushSync();
	lb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	flushSync();
	// Skipped disabled 'jp' -> landed on 'us'
	expect(must(target.querySelector<HTMLElement>('[data-lb-opt="us"]'), 'us').hasAttribute('data-highlighted')).toBe(true);
	lb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	flushSync();
	expect(must(target.querySelector<HTMLElement>('[data-lb-opt="us"]'), 'us').getAttribute('aria-selected')).toBe('true');

	// 3. Tree: ArrowRight expands then descends; ArrowLeft ascends then collapses
	const treeEl = must(target.querySelector<HTMLElement>('[data-testid="tree"]'), 'tree');
	expect(target.querySelector('[data-tree-row="a-1"]')).toBeNull();
	treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
	flushSync();
	expect(target.querySelector('[data-tree-row="a-1"]')).not.toBeNull();
	treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
	flushSync();
	expect(must(target.querySelector<HTMLElement>('[data-tree-row="a-1"]'), 'a-1').tabIndex).toBe(0);
	treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	flushSync();
	expect(must(target.querySelector<HTMLElement>('[data-tree-row="root-a"]'), 'root-a').tabIndex).toBe(0);
	treeEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
	flushSync();
	expect(target.querySelector('[data-tree-row="a-1"]')).toBeNull();

	// 4. LIFO Dismiss: nested layers close innermost first on Escape, outside click closes remaining
	must(target.querySelector<HTMLButtonElement>('[data-testid="open-outer"]'), 'open-outer').click();
	must(target.querySelector<HTMLButtonElement>('[data-testid="open-inner"]'), 'open-inner').click();
	flushSync();
	expect(target.querySelector('[data-testid="outer-layer"]')).not.toBeNull();
	expect(target.querySelector('[data-testid="inner-layer"]')).not.toBeNull();
	document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	flushSync();
	expect(target.querySelector('[data-testid="inner-layer"]')).toBeNull();
	expect(target.querySelector('[data-testid="outer-layer"]')).not.toBeNull();
	// Clicking ignored trigger keeps outer open
	must(target.querySelector<HTMLButtonElement>('[data-testid="open-outer"]'), 'open-outer').dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true })
	);
	flushSync();
	expect(target.querySelector('[data-testid="outer-layer"]')).not.toBeNull();
	// Clicking outside closes outer
	must(target.querySelector<HTMLElement>('[data-testid="outside-area"]'), 'outside').dispatchEvent(
		new PointerEvent('pointerdown', { bubbles: true })
	);
	flushSync();
	expect(target.querySelector('[data-testid="outer-layer"]')).toBeNull();

	// 5. Focus trap: auto-focuses first, cycles Tab, restores opener on close
	const opener = must(target.querySelector<HTMLButtonElement>('[data-testid="trap-opener"]'), 'trap-opener');
	opener.focus();
	opener.click();
	flushSync();
	const trapDialog = must(target.querySelector<HTMLElement>('[data-testid="trap-dialog"]'), 'trap-dialog');
	const trapFirst = must(target.querySelector<HTMLButtonElement>('[data-testid="trap-first"]'), 'trap-first');
	const trapLast = must(target.querySelector<HTMLButtonElement>('[data-testid="trap-last"]'), 'trap-last');
	expect(document.activeElement).toBe(trapFirst);
	trapLast.focus();
	trapDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
	expect(document.activeElement).toBe(trapFirst);
	trapDialog.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
	);
	expect(document.activeElement).toBe(trapLast);
	opener.click();
	flushSync();
	expect(document.activeElement).toBe(opener);

	// 6. Shortcuts: mod+k works on window, skipped inside input; mod+enter allowed in input
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
	const scInput = must(target.querySelector<HTMLInputElement>('[data-testid="shortcut-input"]'), 'sc-input');
	scInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
	scInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
	expect(shortcuts).toEqual(['palette', 'submit']);

	// 7. Resize: inverted ArrowLeft increases width by 20, clamps to max 600
	const handle = must(target.querySelector<HTMLElement>('[data-testid="resize-handle"]'), 'resize-handle');
	expect(handle.getAttribute('role')).toBe('separator');
	expect(handle.getAttribute('aria-valuenow')).toBe('400');
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
	flushSync();
	expect(handle.getAttribute('data-width')).toBe('420');
	handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
	flushSync();
	expect(handle.getAttribute('data-width')).toBe('400');

	// 8. Slider: ArrowRight (+5), PageUp (+50), End (100), Home (0)
	const thumb = must(target.querySelector<HTMLElement>('[data-testid="slider-thumb"]'), 'slider-thumb');
	expect(thumb.getAttribute('aria-valuenow')).toBe('25');
	thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
	flushSync();
	expect(thumb.getAttribute('aria-valuenow')).toBe('30');
	thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
	flushSync();
	expect(thumb.getAttribute('aria-valuenow')).toBe('100');
	expect(thumb.getAttribute('data-percent')).toBe('100');
	thumb.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
	flushSync();
	expect(thumb.getAttribute('aria-valuenow')).toBe('0');

	// 9. Pagination: next/last/control registry
	const pagerEl = must(target.querySelector<HTMLElement>('[data-testid="pager"]'), 'pager');
	expect(pagerEl.getAttribute('data-page')).toBe('2');
	must(target.querySelector<HTMLButtonElement>('[data-testid="pager-next"]'), 'pager-next').click();
	flushSync();
	expect(pagerEl.getAttribute('data-page')).toBe('3');
	expect(act_on_control('pager:test', 'go', [8])).toBe(true);
	flushSync();
	expect(pagerEl.getAttribute('data-page')).toBe('8');

	// 10. Clipboard: copies and sets copied flag
	const clipBtn = must(target.querySelector<HTMLButtonElement>('[data-testid="clip-btn"]'), 'clip-btn');
	clipBtn.click();
	await tick();
	flushSync();
	expect(copies).toEqual([{ ok: true, value: 'NORB-42' }]);
	expect(clipBtn.getAttribute('data-copied')).toBe('true');

	// 11. Field: ARIA wiring updates reactively when error clears
	const fInput = must(target.querySelector<HTMLInputElement>('[data-testid="field-input"]'), 'field-input');
	expect(fInput.getAttribute('aria-invalid')).toBe('true');
	expect(fInput.getAttribute('aria-describedby')).toBe('emp-code-desc emp-code-err');
	must(target.querySelector<HTMLButtonElement>('[data-testid="field-clear-err"]'), 'clear-err').click();
	flushSync();
	expect(fInput.getAttribute('aria-invalid')).toBeNull();
	expect(fInput.getAttribute('aria-describedby')).toBe('emp-code-desc');

	// 12. Stick to bottom
	const tailEl = must(target.querySelector<HTMLElement>('[data-testid="tail"]'), 'tail');
	expect(tailEl.getAttribute('data-stuck')).toBe('true');
	Object.defineProperty(tailEl, 'scrollHeight', { configurable: true, value: 500 });
	Object.defineProperty(tailEl, 'clientHeight', { configurable: true, value: 100 });
	tailEl.scrollTop = 100;
	tailEl.dispatchEvent(new Event('scroll'));
	flushSync();
	expect(tailEl.getAttribute('data-stuck')).toBe('false');
	must(target.querySelector<HTMLButtonElement>('[data-testid="tail-jump"]'), 'tail-jump').click();
	flushSync();
	expect(tailEl.getAttribute('data-stuck')).toBe('true');

	await unmount(view);
	target.remove();
});

it('wired built-in Sheet, Combobox, TabStrip and CopyText share behaviors and control registry', async () => {
	const target = document.body.appendChild(document.createElement('div'));

	// Sheet: resize handle + control registry close
	let sheetOpen = true;
	const sheetView = mount(Sheet, {
		target,
		props: {
			open: sheetOpen,
			title: 'Inspector',
			on_open_change: (next) => (sheetOpen = next),
			children: createRawSnippet(() => ({ render: () => '<p>Details</p>' }))
		}
	});
	await tick();
	const sheetControl = must(
		page_controls().find((c) => c.kind === 'sheet' && c.label === 'Inspector'),
		'sheet control'
	);
	expect(sheetControl.state['open']).toBe(true);
	expect(act_on_control(sheetControl.id, 'toggle_fullscreen')).toBe(true);
	flushSync();
	expect(page_controls().find((c) => c.id === sheetControl.id)?.state['fullscreen']).toBe(true);
	await unmount(sheetView);

	// Combobox: control registry select + clear
	let picked: string | null = null;
	const comboView = mount(Combobox, {
		target,
		props: {
			id: 'status-pick',
			'aria-label': 'Status',
			clearable: true,
			options: [
				{ value: 'draft', label: 'Draft' },
				{ value: 'live', label: 'Live' }
			],
			multiple: false,
			value: picked,
			on_change: (next) => {
				if (next === null || typeof next === 'string') picked = next;
			}
		}
	});
	await tick();
	expect(act_on_control('combobox:status-pick', 'select', ['live'])).toBe(true);
	expect(picked).toBe('live');
	expect(act_on_control('combobox:status-pick', 'clear')).toBe(true);
	expect(picked).toBeNull();
	await unmount(comboView);

	// TabStrip: control registry select
	let tab = 'a';
	const stripView = mount(TabStrip, {
		target,
		props: {
			label: 'Section tabs',
			items: [
				{ name: 'a', title: 'Alpha' },
				{ name: 'b', title: 'Beta' }
			],
			value: tab,
			on_value_change: (next) => (tab = next)
		}
	});
	await tick();
	expect(act_on_control('tab-strip:Section tabs', 'select', ['b'])).toBe(true);
	expect(tab).toBe('b');
	await unmount(stripView);

	// CopyText uses create_clipboard cleanly
	let wrote = '';
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				wrote = text;
			}
		}
	});
	const copyView = mount(CopyText, { target, props: { text: 'EMP-99' } });
	await tick();
	must(target.querySelector<HTMLButtonElement>('button'), 'copy button').click();
	await tick();
	expect(wrote).toBe('EMP-99');
	await unmount(copyView);

	target.remove();
});

it('page_range and matches_shortcut pure helpers handle edge cases', () => {
	expect(page_range(1, 5)).toEqual([1, 2, 3, 4, 5]);
	expect(page_range(1, 10)).toEqual([1, 2, 'ellipsis', 10]);
	expect(page_range(5, 10)).toEqual([1, 'ellipsis', 4, 5, 6, 'ellipsis', 10]);
	expect(page_range(10, 10)).toEqual([1, 'ellipsis', 9, 10]);
	expect(matches_shortcut(new KeyboardEvent('keydown', { key: 'k', metaKey: true }), 'mod+k')).toBe(true);
	expect(matches_shortcut(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
	expect(matches_shortcut(new KeyboardEvent('keydown', { key: 'k' }), 'mod+k')).toBe(false);
});
