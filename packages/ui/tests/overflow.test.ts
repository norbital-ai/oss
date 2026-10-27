import './dom.ts';
import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { browser, required } from './view-fixture.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./overflow-harness.svelte');
const TEXT = 'STOPPAGE_EMPLOYER: wages are paid while the employer stops production';
const settle = async () => {
	for (let i = 0; i < 3; i++) {
		flushSync();
		await tick();
	}
};

it.live('a cell wider than its box opens the full text in a bounded popover', () =>
	browser(async () => {
		const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
		const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
		Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
			configurable: true,
			get: () => 500
		});
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
			configurable: true,
			get: () => 100
		});
		const target = document.body.appendChild(document.createElement('div'));
		const app = mount(Harness, { target, props: { text: TEXT } });
		try {
			await settle();
			const trigger = required(target.querySelector<HTMLButtonElement>('[data-slot=popover-trigger]'));
			trigger.click();
			await settle();
			const content = required(document.querySelector('[data-slot=popover-content]'));
			assert.ok(content.className.includes('overflow-auto'), 'the popover scrolls its bounded box');
			assert.ok((content.textContent ?? '').includes(TEXT));
		} finally {
			await unmount(app);
			target.remove();
			if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll);
			if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client);
		}
	})
);
