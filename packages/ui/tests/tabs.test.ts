import './dom.ts';
import { createRawSnippet, flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Tabs from '../src/primitives/tabs/tabs.svelte';
import TabStrip from '../src/primitives/tabs/tab-strip.svelte';
import { uiMessagesFor, uiTextFor } from '../src/i18n.ts';

it('owns primitive and model-view translations', () => {
	expect(uiTextFor('zh-CN').propertyName).toBe('属性名称');
	expect(uiMessagesFor('zh-CN')['ui.table.empty']).toBe('尚无{what}');
	expect(uiMessagesFor('en')).toEqual({});
});

it.each([
	{ orientation: 'horizontal', side: 'start', arrow: 'ArrowRight' },
	{ orientation: 'vertical', side: 'start', arrow: 'ArrowDown' },
	{ orientation: 'vertical', side: 'end', arrow: 'ArrowDown' }
] as const)(
	'$orientation tabs at $side retain keyboard navigation and panel links',
	async ({ orientation, side, arrow }) => {
		const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
		const tabs = ['Overview', 'Measurements', 'History'].map((title) => ({
			name: title,
			title,
			body
		}));
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(Tabs, { target, props: { tabs, orientation, side } });
		await tick();
		const selected = () =>
			target.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim();
		const press = async (key: string) => {
			document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
			await tick();
			flushSync();
		};
		target.querySelector<HTMLButtonElement>('[role=tab]')?.focus();
		expect(target.querySelector('[role=tablist]')?.getAttribute('aria-orientation')).toBe(
			orientation
		);
		await press(arrow);
		expect(selected()).toBe('Measurements');
		await press('End');
		expect(selected()).toBe('History');
		const active = target.querySelector('[role=tab][aria-selected=true]');
		const panel = target.querySelector('[role=tabpanel]:not([hidden])');
		expect(active?.getAttribute('aria-controls')).toBe(panel?.id);
		expect(panel?.getAttribute('aria-labelledby')).toBe(active?.id);
		expect(panel?.textContent?.trim()).toBe('Tab content');
		await unmount(view);
	}
);

it.each([250, 100])(
	'page navigation keeps overflow links and the active page under More at %ipx',
	async (available) => {
		const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
		const room = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		const style = window.getComputedStyle;
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
			configurable: true,
			get: () => 100
		});
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
			configurable: true,
			get: () => available
		});
		window.getComputedStyle = () => {
			const flat = document.createElement('div').style;
			flat.columnGap = flat.paddingLeft = flat.paddingRight = '0px';
			return flat;
		};
		try {
			const items = ['Dashboard', 'Drawdowns', 'Bank advices'].map((title, index) => ({
				name: String(index),
				title,
				href: `/page/${index}`
			}));
			const target = document.body.appendChild(document.createElement('div'));
			const view = mount(TabStrip, {
				target,
				props: { items, value: '2', label: 'Treasury pages' }
			});
			await tick();
			flushSync();
			expect(target.querySelector('nav')?.clientWidth).toBe(available);
			expect(target.querySelectorAll('nav > a')).toHaveLength(available === 250 ? 1 : 0);
			const more = target.querySelector<HTMLButtonElement>('[data-tabs-more]');
			expect(more?.dataset['state']).toBe('active');
			more?.click();
			await tick();
			flushSync();
			const active = document.querySelector('a[aria-current=page]');
			expect(active?.textContent?.trim()).toBe('Bank advices');
			expect(active?.getAttribute('href')).toBe('/page/2');
			await unmount(view);
		} finally {
			if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
			if (room) Object.defineProperty(HTMLElement.prototype, 'clientWidth', room);
			else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
			window.getComputedStyle = style;
		}
	}
);

it.each(['en', 'zh'])('an overflow tab keeps its selection with %s chrome', async (locale) => {
	// every trigger 100px wide in a 250px strip: one tab and More fit
	const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
	const room = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
	const style = window.getComputedStyle;
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get: () => 100
	});
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
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
		const view = mount(Tabs, {
			target,
			props: { tabs, value: 'Suspension' },
			context: new Map([[Symbol.for('norbital.ui.text'), uiTextFor(locale)]])
		});
		await tick();
		flushSync();
		const strip = [...target.querySelectorAll('[role=tab]')].map((e) => e.textContent?.trim());
		expect(strip).toEqual(['Leave']);
		const more = target.querySelector<HTMLButtonElement>('[data-tabs-more]');
		expect(more?.textContent?.trim()).toBe(locale === 'zh' ? '更多' : 'More');
		expect(more?.dataset['state']).toBe('active');
		more?.click();
		await tick();
		flushSync();
		expect(document.querySelector('[aria-current=page]')?.textContent?.trim()).toBe('Suspension');
		await unmount(view);
	} finally {
		if (width) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
		if (room) Object.defineProperty(HTMLElement.prototype, 'clientWidth', room);
		else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
		window.getComputedStyle = style;
	}
});
