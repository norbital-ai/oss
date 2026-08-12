import { describe, expect, it } from 'vitest';
import DataGridDisclosureHarness from '../support/data-grid-disclosure-harness.svelte';
import { render, settle } from '../support/component.js';

function installRowLayoutHarness(): {
	notifyResize(): void;
	restore(): void;
} {
	const OriginalResizeObserver = globalThis.ResizeObserver;
	const originalOffsetHeight = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		'offsetHeight'
	);
	const observers = new Set<{ callback: ResizeObserverCallback; observer: ResizeObserver }>();

	class LayoutResizeObserver implements ResizeObserver {
		readonly #entry: { callback: ResizeObserverCallback; observer: ResizeObserver };

		constructor(callback: ResizeObserverCallback) {
			this.#entry = { callback, observer: this };
			observers.add(this.#entry);
		}

		disconnect(): void {
			observers.delete(this.#entry);
		}

		observe(): void {}
		unobserve(): void {}
	}

	globalThis.ResizeObserver = LayoutResizeObserver;
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get() {
			if (this instanceof HTMLElement && this.hasAttribute('data-record-id')) {
				return this.querySelector('[data-testid="deployment-details"]') ? 336 : 48;
			}
			return originalOffsetHeight?.get?.call(this) ?? 0;
		}
	});

	return {
		notifyResize() {
			for (const { callback, observer } of observers) callback([], observer);
		},
		restore() {
			globalThis.ResizeObserver = OriginalResizeObserver;
			if (originalOffsetHeight) {
				Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
			} else {
				Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
			}
		}
	};
}

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

	it('reserves the expanded detail height instead of clipping it to the collapsed row', async () => {
		const layout = installRowLayoutHarness();
		const { container, destroy } = render(DataGridDisclosureHarness as never, {});
		try {
			await settle();
			expect(
				container.querySelector<HTMLElement>('[data-collection-grid-virtual-spacer]')?.style.height
			).toBe('48px');

			container.querySelector<HTMLButtonElement>('[aria-label="Expand row details"]')?.click();
			await settle();
			layout.notifyResize();
			await settle();

			expect(container.querySelector('[data-testid="deployment-details"]')).not.toBeNull();
			expect(
				container.querySelector<HTMLElement>('[data-collection-grid-virtual-spacer]')?.style.height
			).toBe('336px');
		} finally {
			destroy();
			layout.restore();
		}
	});
});
