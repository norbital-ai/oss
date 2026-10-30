import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Tabs from '../src/primitives/tabs/tabs.svelte';

it('arrow and End keys move the selected tab', async () => {
	const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
	const tabs = ['Overview', 'Measurements', 'History'].map((title) => ({
		name: title,
		title,
		body
	}));
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Tabs, { target, props: { tabs } });
	await tick();
	const selected = () =>
		target.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim();
	const press = async (key: string) => {
		document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
		await tick();
		flushSync();
	};
	target.querySelector<HTMLButtonElement>('[role=tab]')?.focus();
	await press('ArrowRight');
	expect(selected()).toBe('Measurements');
	await press('End');
	expect(selected()).toBe('History');
	await unmount(view);
});

it('a tab chosen under More stays there: More and its row show it, the strip keeps its order', async () => {
	// every trigger 100px wide in a 250px strip: one tab and More fit
	const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
	const room = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
	const style = window.getComputedStyle;
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
	Object.defineProperty(Element.prototype, 'clientWidth', {
		configurable: true,
		get(this: Element) {
			return this.getAttribute('role') === 'tablist' ? 250 : 0;
		}
	});
	window.getComputedStyle = () => {
		const flat = document.createElement('div').style;
		flat.columnGap = flat.paddingLeft = flat.paddingRight = '0px';
		return flat;
	};
	try {
		const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
		const tabs = ['Leave', 'Claim', 'Suspension'].map((title) => ({ name: title, title, body }));
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(Tabs, { target, props: { tabs, value: 'Suspension' } });
		await tick();
		flushSync();
		const strip = [...target.querySelectorAll('[role=tab]')].map((e) => e.textContent?.trim());
		expect(strip).toEqual(['Leave']);
		const more = target.querySelector<HTMLButtonElement>('[data-tabs-more]');
		expect(more?.dataset['state']).toBe('active');
		more?.click();
		await tick();
		flushSync();
		expect(document.querySelector('[aria-current=page]')?.textContent?.trim()).toBe('Suspension');
		await unmount(view);
	} finally {
		if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
		if (room) Object.defineProperty(Element.prototype, 'clientWidth', room);
		window.getComputedStyle = style;
	}
});
