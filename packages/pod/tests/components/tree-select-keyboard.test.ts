import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import TreeSelectKeyboardHarness from '../support/tree-select-keyboard-harness.svelte';

describe('tree selector keyboard navigation', () => {
	it('expands and collapses a focused parent with right and left arrows', async () => {
		const { container, destroy } = render(TreeSelectKeyboardHarness as never, {});
		const parent = container.querySelector<HTMLElement>('[data-node-path="web-agent"]');
		expect(parent?.getAttribute('aria-expanded')).toBe('false');
		parent?.focus();
		parent?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		await settle();
		expect(parent?.getAttribute('aria-expanded')).toBe('true');
		expect(container.querySelector('[data-node-path="chat"]')).not.toBeNull();

		parent?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		await settle();
		expect(parent?.getAttribute('aria-expanded')).toBe('false');
		expect(container.querySelector('[data-node-path="chat"]')).toBeNull();
		destroy();
	});

	it('does not render decorative ASCII connector glyphs', () => {
		const { container, destroy } = render(TreeSelectKeyboardHarness as never, {});
		expect(container.textContent).not.toContain('└');
		expect(container.textContent).not.toContain('├');
		destroy();
	});
});
