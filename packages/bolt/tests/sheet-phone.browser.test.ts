/// <reference types="@vitest/browser-playwright" />
import { required } from './support/required.ts';
import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import Harness from '../../ui/tests/kit-harness.svelte';
import '../../ui/src/base.css';

// A phone's drawer in a real browser. The grabber is a <button>, and the touch contract's `manipulation` on buttons once
// beat its `touch-none`: the browser took the swipe as a pan and the drawer never followed the thumb.
test('a phone sheet is dragged by its grabber and takes the whole screen', async () => {
	await page.viewport(393, 851);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: { part: 'sheet', sheetOpen: true }
	});
	const panel = () => required(document.querySelector<HTMLElement>('[data-sheet-side]'));
	const grabber = () => required(document.querySelector<HTMLElement>('[data-sheet-grabber]'));
	const pointer = (type: string, clientY: number) =>
		new PointerEvent(type, { bubbles: true, button: 0, clientX: 196, clientY });
	try {
		await tick();
		expect(getComputedStyle(grabber()).touchAction).toBe('none');
		const scrim = required(document.querySelector<HTMLElement>('[data-sheet-scrim]'));
		expect(getComputedStyle(scrim).touchAction).toBe('none');

		const height = panel().offsetHeight;
		grabber().dispatchEvent(pointer('pointerdown', 400));
		window.dispatchEvent(pointer('pointermove', 500));
		window.dispatchEvent(pointer('pointerup', 500));
		await expect.poll(() => panel().offsetHeight).toBe(height - 100);

		grabber().dispatchEvent(pointer('pointerdown', 500));
		window.dispatchEvent(pointer('pointermove', 20));
		window.dispatchEvent(pointer('pointerup', 20));
		await expect.poll(() => panel().dataset['fullscreen']).toBe('true');
		expect(panel().offsetTop).toBe(0);
		expect(panel().offsetHeight).toBe(851);
	} finally {
		await unmount(view);
		target.remove();
		document.body.replaceChildren();
		await page.viewport(1280, 720);
	}
});
