import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import TabsKeepAliveHarness from '../support/tabs-keep-alive-harness.svelte';

describe('lazy keep-alive tabs', () => {
	it('mounts a tab on first visit, then retains its state without remounting', async () => {
		const { container, destroy } = render(TabsKeepAliveHarness as never, {});
		await settle();
		expect(container.querySelector('[data-mounts]')?.textContent).toBe('1:0');
		expect(container.querySelector<HTMLInputElement>('[aria-label="Shifts value"]')).toBeNull();
		const activePanel = container.querySelector<HTMLElement>('[role="tabpanel"]');
		expect(activePanel?.className).toContain('overflow-clip');
		expect(activePanel?.className).not.toContain('overflow-y-auto');

		container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Shifts"]')?.click();
		await settle();
		const shifts = container.querySelector<HTMLInputElement>('[aria-label="Shifts value"]');
		expect(container.querySelector('[data-mounts]')?.textContent).toBe('1:1');
		expect(shifts).not.toBeNull();
		if (shifts) shifts.value = 'retained';

		container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Board"]')?.click();
		await settle();
		container.querySelector<HTMLButtonElement>('[role="tab"][aria-label="Shifts"]')?.click();
		await settle();
		expect(container.querySelector('[data-mounts]')?.textContent).toBe('1:1');
		expect(container.querySelector<HTMLInputElement>('[aria-label="Shifts value"]')?.value).toBe(
			'retained'
		);
		destroy();
	});
});
