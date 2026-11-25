import './dom.ts';
import { flushSync, mount, tick, unmount } from 'svelte';
import { expect, it } from 'vitest';
import Harness from './sheet-memory-harness.svelte';

const opened = async (memory: string) => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(Harness, { target, props: { memory } });
	await tick();
	const panel = document.querySelector<HTMLElement>('[role="dialog"]');
	if (panel === null) throw new Error('the sheet did not open');
	return {
		full: () => panel.hasAttribute('data-fullscreen'),
		toggle: () => {
			document.querySelector<HTMLButtonElement>('[data-sheet-fullscreen]')?.click();
			flushSync();
		},
		close: async () => {
			await unmount(view);
			target.remove();
		}
	};
};

it('a sheet reopens full screen as its name was last left, and another name keeps its own', async () => {
	localStorage.clear();
	const quote = await opened('record:quotes');
	expect(quote.full()).toBe(false);
	quote.toggle();
	expect(quote.full()).toBe(true);
	await quote.close();
	// another model's sheet is not full screen because quotes was
	const order = await opened('record:orders');
	expect(order.full()).toBe(false);
	await order.close();
	// the same model, opened again
	const again = await opened('record:quotes');
	expect(again.full()).toBe(true);
	again.toggle();
	await again.close();
	const once = await opened('record:quotes');
	expect(once.full()).toBe(false);
	await once.close();
});
