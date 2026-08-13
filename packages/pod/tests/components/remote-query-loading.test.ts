import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import RemoteQueryLoadingHarness from '../support/remote-query-loading-harness.svelte';

describe('remote query loading truth', () => {
	it('is loading synchronously until the first value proves empty or populated', async () => {
		const { container, destroy } = render(RemoteQueryLoadingHarness as never, {});
		const state = container.querySelector('p');
		expect(state?.textContent?.trim()).toBe('loading');
		expect(state?.getAttribute('data-current')).toBe('unknown');

		container.querySelector('button')?.click();
		await settle();
		expect(state?.textContent?.trim()).toBe('settled');
		expect(state?.getAttribute('data-current')).toBe('[]');
		destroy();
	});
});
