/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { userEvent } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import Harness from '../../ui/tests/embedded-table-harness.svelte';
import '../../ui/src/base.css';

test('row trailing controls stay on the visible right edge during horizontal scroll and remain keyboard reachable', async () => {
	const target = document.createElement('div');
	target.style.width = '300px';
	document.body.replaceChildren(target);
	const view = mount(Harness, { target, props: { changed: () => {} } });
	try {
		await tick();
		const table = target.querySelector('table')!;
		table.style.minWidth = '900px';
		const scroll = target.querySelector<HTMLElement>('[data-table-wide]')!;
		const action = target.querySelector<HTMLButtonElement>('[data-row-trailing] button')!;
		const edge = () =>
			Math.abs(action.getBoundingClientRect().right - scroll.getBoundingClientRect().right);
		await expect.poll(edge).toBeLessThan(2);
		scroll.scrollLeft = 260;
		await expect.poll(edge).toBeLessThan(2);
		action.focus();
		await expect.poll(() => getComputedStyle(action.parentElement!).opacity).toBe('1');
		expect(document.activeElement).toBe(action);
		await userEvent.keyboard('{Enter}');
		await expect.poll(() => target.querySelectorAll('tbody tr').length).toBe(1);
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		localStorage.clear();
	}
});
