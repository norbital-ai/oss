/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { cdp, commands } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Checkbox from '../../ui/src/primitives/checkbox/checkbox.svelte';

test('under a coarse pointer a checkbox keeps its box and takes a 44px tap around it, while a button grows to 44px', async () => {
	await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
	const style = document.createElement('style');
	style.textContent = await commands.readFile('../ui/src/base.css');
	document.head.append(style);
	const target = document.createElement('div');
	target.style.padding = '40px';
	document.body.replaceChildren(target);
	// the primitive's `box-content size-4 border` and the preflight's padding, without the compiled utilities
	const view = mount(Checkbox, {
		target,
		props: {
			'aria-label': 'Agree',
			style:
				'box-sizing: content-box; inline-size: 1rem; block-size: 1rem; padding: 0; border: 1px solid'
		}
	});
	const row = document.createElement('div'),
		button = document.createElement('button');
	button.textContent = 'Go';
	row.append(button);
	target.append(row);
	try {
		expect(matchMedia('(pointer: coarse)').matches).toBe(true);
		const box = target.querySelector('button[role=checkbox]')!.getBoundingClientRect();
		expect(box.width).toBeLessThan(24);
		expect(box.height).toBeLessThan(24);
		const x = box.left + box.width / 2,
			y = box.top + box.height / 2;
		for (const [dx, dy] of [
			[20, 0],
			[-20, 0],
			[0, 20],
			[0, -20]
		] as const)
			expect(document.elementFromPoint(x + dx, y + dy)?.getAttribute('role')).toBe('checkbox');
		expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
		expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
	} finally {
		await unmount(view);
		style.remove();
		target.remove();
		await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
	}
});
