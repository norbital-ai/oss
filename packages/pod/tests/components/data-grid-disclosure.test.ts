import { describe, expect, it } from 'vitest';
import DataGridDisclosureHarness from '../support/data-grid-disclosure-harness.svelte';
import { render, settle } from '../support/component.js';

describe('DataGrid controlled disclosure', () => {
	it('keeps an expanded row open when polling replaces rows and remounts the grid', async () => {
		const { container, destroy } = render(DataGridDisclosureHarness as never, {});
		await settle();

		const disclosure = container.querySelector<HTMLButtonElement>(
			'[aria-label="Expand row details"]'
		);
		expect(disclosure).not.toBeNull();
		disclosure?.click();
		await settle();
		expect(container.querySelector('[data-testid="deployment-details"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="expanded-ids"]')?.textContent).toBe(
			'deployment-1'
		);

		container.querySelector<HTMLButtonElement>('[data-testid="poll"]')?.click();
		await settle();

		expect(container.querySelector('[data-testid="expanded-ids"]')?.textContent).toBe(
			'deployment-1'
		);
		expect(container.querySelector('[aria-expanded="true"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="deployment-details"]')).not.toBeNull();
		destroy();
	});
});
