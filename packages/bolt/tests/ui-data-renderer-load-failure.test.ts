// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import DataRendererLoadFailureView from './support/data-renderer-load-failure-view.svelte';

/**
 * UI-RENDERER (RFC/bolt.md B10): a custom type whose `+renderer.svelte` fails to load shows the
 * field's raw value with an inline error naming the datatype and the cause, logs an error, and
 * never stays on "Loading field…".
 */
const settle = async () => {
	for (let turn = 0; turn < 10; turn += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
};

afterEach(() => {
	vi.restoreAllMocks();
});

it('shows the raw value and names the datatype and cause when the renderer module throws', async () => {
	const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(DataRendererLoadFailureView, {
		target,
		props: {
			load: () => Promise.reject(new Error('Column must be a child of Grid or Columns')),
			value: { months: 12, anchor: 'calendar-month' }
		}
	});
	try {
		flushSync();
		expect(target.textContent).toContain('Loading field…');
		await settle();
		expect(target.textContent).not.toContain('Loading field…');
		const alert = target.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('pay_calendar');
		expect(alert?.textContent).toContain('Column must be a child of Grid or Columns');
		expect(target.textContent).toContain('calendar-month');
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toContain(
			'renderer for pay_calendar failed to load: Column must be a child of Grid or Columns'
		);
	} finally {
		await unmount(component);
		target.remove();
	}
});

it('treats a module without a default export as a load failure', async () => {
	const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(DataRendererLoadFailureView, {
		target,
		props: { load: () => Promise.resolve(undefined as never), value: 'raw text' }
	});
	try {
		await settle();
		expect(target.textContent).not.toContain('Loading field…');
		expect(target.querySelector('[role="alert"]')?.textContent).toContain('no default export');
		expect(target.textContent).toContain('raw text');
		expect(error).toHaveBeenCalledTimes(1);
	} finally {
		await unmount(component);
		target.remove();
	}
});
