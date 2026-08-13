import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import AppHeaderActionsHarness from '../support/app-header-actions-harness.svelte';

describe('app header actions lifetime', () => {
	it('registers after mount and clears the shell slot on unmount', async () => {
		const { container, destroy } = render(AppHeaderActionsHarness as never, {});
		await settle();
		expect(container.querySelector('[aria-label="Scoped action"]')).not.toBeNull();

		container.querySelector<HTMLButtonElement>('[aria-label="Toggle actions"]')?.click();
		await settle();
		expect(container.querySelector('[aria-label="Scoped action"]')).toBeNull();
		destroy();
	});
});
