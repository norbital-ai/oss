/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import SheetPicker from './support/sheet-picker.svelte';
import '../../ui/src/base.css';

test('a combobox opened in a sheet commits its selection without animation frames', async () => {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(1280, 720);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(SheetPicker, { target });
	try {
		await tick();
		vi.stubGlobal('requestAnimationFrame', () => 0);
		const trigger = document.querySelector<HTMLElement>('[role=dialog] [role=combobox]')!;
		await userEvent.click(trigger);
		const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
			(o) => o.textContent?.trim() === 'Cedar Wharf Public Slip'
		)!;
		await userEvent.click(option.querySelector('button')!);
		await expect.poll(() => trigger.textContent?.trim()).toBe('Cedar Wharf Public Slip');
	} finally {
		vi.unstubAllGlobals();
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		await page.viewport(previous.width, previous.height);
	}
});
