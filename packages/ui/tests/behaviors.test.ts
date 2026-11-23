import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import BehaviorsHarness from './behaviors-harness.svelte';
import Tabs from '../src/primitives/tabs/tabs.svelte';
import {
	act_on_control,
	describe_controls,
	move_item,
	page_controls
} from '../src/behaviors/index.js';

function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) throw new Error(`Expected ${label}`);
	return value;
}

it('composes disclosure, selection (click/Shift/Cmd), roving focus, typeahead, reorder and Surface cleanly', async () => {
	let lastOrder: readonly string[] = [];
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(BehaviorsHarness, {
		target,
		props: { on_order: (next) => (lastOrder = next) }
	});
	await tick();

	// Surface semantic container
	const surface = target.querySelector<HTMLElement>('[data-testid="surface"]');
	expect(surface?.getAttribute('data-surface')).toBe('card');
	expect(surface?.className).toContain('rounded-control');
	expect(surface?.className).toContain('bg-surface-card');

	// Disclosure toggle + ARIA attributes
	const trigger = must(
		target.querySelector<HTMLButtonElement>('[data-testid="disc-trigger"]'),
		'disc-trigger'
	);
	const content = must(
		target.querySelector<HTMLElement>('[data-testid="disc-content"]'),
		'disc-content'
	);
	expect(trigger.getAttribute('aria-expanded')).toBe('false');
	expect(content.hidden).toBe(true);
	trigger.click();
	flushSync();
	expect(trigger.getAttribute('aria-expanded')).toBe('true');
	expect(content.hidden).toBe(false);

	// Selection: single click, Cmd+click additive, Shift+click range
	const opt = (key: string) =>
		must(target.querySelector<HTMLElement>(`[data-key="${key}"]`), `option ${key}`);
	opt('alpha').click();
	flushSync();
	expect(opt('alpha').getAttribute('aria-selected')).toBe('true');
	expect(opt('beta').getAttribute('aria-selected')).toBe('false');

	opt('delta').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
	flushSync();
	expect(opt('alpha').getAttribute('aria-selected')).toBe('true');
	expect(opt('beta').getAttribute('aria-selected')).toBe('true');
	expect(opt('gamma').getAttribute('aria-selected')).toBe('true');
	expect(opt('delta').getAttribute('aria-selected')).toBe('true');

	opt('beta').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
	flushSync();
	expect(opt('beta').getAttribute('aria-selected')).toBe('false');

	// Roving focus skips disabled 'gamma' and typeahead jumps by prefix
	const list = must(target.querySelector<HTMLElement>('[data-testid="list"]'), 'list');
	expect(opt('alpha').tabIndex).toBe(0);
	expect(opt('beta').tabIndex).toBe(-1);
	list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	flushSync();
	expect(opt('beta').tabIndex).toBe(0);
	list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	flushSync();
	// skipped 'gamma'
	expect(opt('delta').tabIndex).toBe(0);

	// Typeahead jumps back to 'alpha'
	list.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
	flushSync();
	expect(opt('alpha').tabIndex).toBe(0);

	// Keyboard reorder via Alt+ArrowDown moves alpha after beta
	opt('alpha').dispatchEvent(
		new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })
	);
	flushSync();
	expect(lastOrder).toEqual(['beta', 'alpha', 'gamma', 'delta']);

	// Control registry reflects live state and accepts semantic actions
	const snapshot = page_controls().find((c) => c.id === 'custom:list');
	expect(snapshot?.kind).toBe('listbox');
	expect(snapshot?.actions).toEqual(['toggle_details', 'select']);
	expect(describe_controls()).toContain('listbox:Items(');
	expect(act_on_control('custom:list', 'select', ['delta'])).toBe(true);
	flushSync();
	expect(opt('delta').getAttribute('aria-selected')).toBe('true');
	expect(opt('alpha').getAttribute('aria-selected')).toBe('false');

	await unmount(view);
	target.remove();
	// Cleaned up on unmount
	expect(page_controls().find((c) => c.id === 'custom:list')).toBeUndefined();
});

it('Tabs registers in the live control registry and switches tab via act_on_control', async () => {
	const body = createRawSnippet(() => ({ render: () => '<p>Body</p>' }));
	const tabs = ['general', 'catalog', 'changelog'].map((name) => ({ name, title: name, body }));
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Tabs, { target, props: { tabs } });
	await tick();

	const control = must(
		page_controls().find((c) => c.kind === 'tabs'),
		'tabs control'
	);
	expect(control.state).toEqual({ active: 'general', items: ['general', 'catalog', 'changelog'] });
	expect(act_on_control(control.id, 'select', ['changelog'])).toBe(true);
	flushSync();
	await tick();
	expect(page_controls().find((c) => c.id === control.id)?.state['active']).toBe('changelog');

	await unmount(view);
	target.remove();
});

it('move_item reorders cleanly without mutating the source array', () => {
	const src = ['a', 'b', 'c', 'd'];
	expect(move_item(src, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
	expect(src).toEqual(['a', 'b', 'c', 'd']);
});
