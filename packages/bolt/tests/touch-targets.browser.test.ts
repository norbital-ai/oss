/// <reference types="@vitest/browser-playwright" />
import { expect, test } from 'vitest';
import { cdp, commands, page, userEvent } from 'vitest/browser';
import { createRawSnippet, mount, tick, unmount } from 'svelte';
import Checkbox from '../../ui/src/primitives/checkbox/checkbox.svelte';
import Tabs from '../../ui/src/primitives/tabs/tabs.svelte';
import '../../ui/src/base.css';

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

test('tabs stay compact on mobile and narrow desktop, scroll within their strip, and retain keyboard navigation', async () => {
	const previous = { width: innerWidth, height: innerHeight };
	const body = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));
	const tabs = [
		'Overview',
		'Measurements',
		'Samples',
		'Submissions',
		'Material requests',
		'History'
	].map((title) => ({ name: title, title, body }));
	try {
		for (const touch of [true, false]) {
			await page.viewport(375, 812);
			await cdp().send('Emulation.setTouchEmulationEnabled', {
				enabled: touch,
				maxTouchPoints: 1
			});
			const target = document.createElement('div');
			target.style.height = '240px';
			document.body.replaceChildren(target);
			const view = mount(Tabs, { target, props: { tabs } });
			try {
				await tick();
				const list = target.querySelector<HTMLElement>('[role=tablist]');
				const first = target.querySelector<HTMLButtonElement>('[role=tab]');
				if (!list || !first) throw new Error('Missing tab strip');
				expect(matchMedia('(pointer: coarse)').matches).toBe(touch);
				expect(first.getBoundingClientRect().height).toBe(touch ? 32 : 28);
				expect(list.scrollWidth).toBeGreaterThan(list.clientWidth);
				expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
				first.focus();
				await userEvent.keyboard('{ArrowRight}');
				await expect
					.element(page.getByRole('tab', { name: 'Measurements', exact: true }))
					.toHaveAttribute('aria-selected', 'true');
				await userEvent.keyboard('{End}');
				await expect
					.element(page.getByRole('tab', { name: 'History', exact: true }))
					.toHaveAttribute('aria-selected', 'true');
				expect(list.scrollLeft).toBeGreaterThan(0);
			} finally {
				await unmount(view);
				target.remove();
			}
		}
	} finally {
		await cdp().send('Emulation.setTouchEmulationEnabled', { enabled: false });
		await page.viewport(previous.width, previous.height);
	}
});
