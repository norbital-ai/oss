/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { page } from 'vitest/browser';
import { mount, tick, unmount } from 'svelte';
import { PreviewFrame, TestResults } from '@norbital-ai/ui';
import type { StudioTestRun } from '@norbital-ai/host-api';
import './support/shell.css';

const failed: StudioTestRun = {
	id: 'run',
	commit: 'abcdef1234567890',
	state: 'failed',
	started_at: '2026-10-30T12:00:00Z',
	summary: { files: 1, total: 1, passed: 0, failed: 1, skipped: 0, duration_ms: 12 },
	files: [
		{
			path: 'tests/orders.test.ts',
			state: 'failed',
			tests: [
				{
					name: 'closes fully invoiced orders',
					state: 'failed',
					error: 'Expected closed, received <open>'
				}
			]
		}
	]
};
it('the preview Tests tab shows parsed failures and preserves the preview iframe', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	target.style.height = '700px';
	const view = mount(PreviewFrame, { target, props: { src: 'about:blank', tests: failed } });
	try {
		await tick();
		const frame = target.querySelector('iframe');
		await page.getByRole('tab', { name: 'Tests · Failed', exact: true }).click();
		await expect.element(page.getByText('Tests failed', { exact: true })).toBeVisible();
		await expect
			.element(page.getByText('Expected closed, received <open>', { exact: true }))
			.toBeVisible();
		expect(target.querySelector('pre open')).toBeNull();
		expect(target.querySelector('iframe')).toBe(frame);
		await page.getByRole('tab', { name: 'Preview', exact: true }).click();
		expect(target.querySelector('iframe')).toBe(frame);
	} finally {
		await unmount(view);
		target.remove();
	}
});
it('running, passed and empty results use distinct text and status colors', async () => {
	for (const [state, label, color] of [
		['running', 'Running tests', 'text-info'],
		['passed', 'Tests passed', 'text-success'],
		['empty', 'No tests ran', 'text-muted-foreground']
	] as const) {
		const target = document.body.appendChild(document.createElement('div'));
		const view = mount(TestResults, {
			target,
			props: {
				run: {
					...failed,
					state,
					files: [],
					summary: { files: 0, total: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0 }
				}
			}
		});
		try {
			await expect
				.element(page.getByRole('status', { name: label, exact: true }))
				.toHaveTextContent(label);
			expect(target.querySelector('[role=status]')?.classList.contains(color)).toBe(true);
		} finally {
			await unmount(view);
			target.remove();
		}
	}
});

it('test failures remain readable before any preview has built', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const view = mount(PreviewFrame, { target, props: { src: null, tests: failed } });
	try {
		await expect
			.element(page.getByRole('status', { name: 'Tests failed', exact: true }))
			.toBeVisible();
		expect(target.querySelector('iframe')).toBeNull();
	} finally {
		await unmount(view);
		target.remove();
	}
});
