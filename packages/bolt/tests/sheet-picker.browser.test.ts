/// <reference types="@vitest/browser-playwright" />
import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import SheetPicker from './support/sheet-picker.svelte';
import '../../ui/src/base.css';

// A hidden or throttled tab runs no animation frame: bits-ui's per-frame copy of the content's z-index onto its
// body-portaled wrapper never lands, so the floating layer itself must own its z layer above a z-40 sheet.
test('a combobox list opened in a sheet is the hit-test target over the form, with no animation frame', async () => {
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
		const wrapper = () =>
			document.querySelector<HTMLElement>('[data-bits-floating-content-wrapper]');
		await expect.poll(() => wrapper()?.style.transform ?? '').toMatch(/^translate\(\d/);
		const option = [...document.querySelectorAll<HTMLElement>('[role=option]')].find(
			(o) => o.textContent?.trim() === 'Cedar Wharf Public Slip'
		)!;
		const box = option.getBoundingClientRect();
		const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		expect(hit !== null && option.contains(hit)).toBe(true);
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
