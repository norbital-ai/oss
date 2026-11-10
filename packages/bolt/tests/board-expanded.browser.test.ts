import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import Board from '../../ui/src/board/Board.svelte';
import Harness from '../../ui/tests/view-harness.svelte';
import { scriptedBolt } from '../../ui/tests/scripted-bolt.ts';
import './support/shell.css';

it('expanding a lane leaves hints closed and keeps its search keyboard-accessible', async () => {
	const dispose = mountEdge(ManagedRuntime.make(Layer.empty));
	const fixture = await scriptedBolt({
		answer: (read) =>
			read.m === 'aggregate'
				? { rows: [{ key: { status: 'active' }, count: 2 }], next: null }
				: {
						jobs: {
							rows: [
								{ id: '1', title: 'Pump alpha', status: 'active' },
								{ id: '2', title: 'Valve beta', status: 'active' }
							],
							next: null
						}
					}
	});
	const previous = {
		width: innerWidth,
		height: innerHeight,
		dark: document.documentElement.classList.contains('dark')
	};
	await page.viewport(1200, 900);
	const target = document.createElement('div');
	target.style.cssText = 'height:100%;padding:24px;background:var(--color-background)';
	document.body.replaceChildren(target);
	const view = mount(Harness, {
		target,
		props: {
			bolt: fixture.bolt,
			catalog: {
				jobs: {
					record_label: 'record.title',
					label: ['title'],
					search: ['title'],
					fields: {
						title: { kind: 'text' },
						status: { kind: 'enum', values: ['active'] }
					}
				}
			},
			part: 'board',
			view: Board,
			props: { of: 'jobs', by: 'status', card: ['title'], toolbar: false }
		}
	});
	try {
		const expand = page.getByRole('button', { name: 'Expand Active' });
		await expand.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		const opener = target.querySelector('[data-lane-expand]');
		await expect.poll(() => document.activeElement?.hasAttribute('data-lane-dialog')).toBe(true);
		expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
		await userEvent.keyboard('{Tab}');
		await expect.poll(() => document.activeElement?.hasAttribute('data-search-toggle')).toBe(true);
		await expect.element(page.getByText('Search', { exact: true })).toBeVisible();
		await userEvent.keyboard('{Enter}');
		const search = page.getByRole('searchbox', { name: 'Search', exact: true });
		await expect.element(search).toBeVisible();
		// the popover moves focus into its input asynchronously; Escape must wait for that focus,
		// otherwise it is dispatched to the dialog underneath and closes the wrong layer
		await expect.element(search).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		// Escape dismisses the search popover, never the dialog beneath it: assert the state before a
		// click so a bubbling Escape fails here, not as a 15-second Playwright actionability timeout.
		await expect.poll(() => document.querySelector('[data-search-panel]')).toBeNull();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
		await expect.poll(() => document.activeElement === opener).toBe(true);
	} finally {
		await unmount(view);
		await dispose();
		target.remove();
		document.documentElement.classList.toggle('dark', previous.dark);
		await page.viewport(previous.width, previous.height);
	}
});
