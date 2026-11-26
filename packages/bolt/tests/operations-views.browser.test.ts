import { expect, it } from '@effect/vitest';
import { Layer, ManagedRuntime } from 'effect';
import { mount, unmount } from 'svelte';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { WorkspaceOperations, type WorkspaceOperationsData } from '@norbital-ai/ui';
import '../../ui/src/base.css';

const data: WorkspaceOperationsData = {
	can_inspect: true,
	as_of: '2026-11-25T08:00:00.000Z',
	usage: [],
	members: null,
	studio: null,
	logs: null,
	bundles: null,
	cache: null,
	errors: null,
	filters: { level: null, text: '', run: '', build: null },
	activity: {
		people: 4,
		pages: [
			{ route: '/app/sales/quotes', views: 12, people: 3, dwell_ms: 42_000 },
			{ route: '/app/sales/orders', views: 30, people: 4, dwell_ms: null }
		],
		turns: [
			{ audience: 'staff', turns: 9, failed: 1, steps: 40, tool_errors: 2, cost: 0.1234 },
			{ audience: 'system', turns: 2, failed: 0, steps: 18, tool_errors: 0, cost: 0.05 }
		]
	},
	improvements: {
		threads: [
			{
				id: 't1',
				kind: 'feedback',
				status: 'blocked',
				title: 'Dates show a day early',
				seen: 1,
				updated_at: '2026-11-25T07:00:00.000Z',
				last: 'question: Which timezone should the report use?',
				change: null,
				conversation: 'c1'
			},
			{
				id: 't2',
				kind: 'failure',
				status: 'open',
				title: 'Automation payroll keeps failing',
				seen: 3,
				updated_at: '2026-11-25T08:00:00.000Z',
				last: null,
				change: null,
				conversation: null
			}
		]
	}
};

const shown = async (
	view: 'activity' | 'improvements',
	check: () => Promise<void>,
	on_conversation?: (id: string) => void
) => {
	document.body.replaceChildren();
	// the board's toolbar forks its work on the page's edge
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const target = document.createElement('div');
	document.body.append(target);
	const mounted = mount(WorkspaceOperations, {
		target,
		props: {
			ctx: { ui: { kinds: {} } },
			data,
			range: '7d',
			view,
			views: [view],
			on_change: () => undefined,
			...(on_conversation === undefined ? {} : { on_conversation })
		}
	});
	try {
		await check();
	} finally {
		await unmount(mounted);
		target.remove();
		await dispose();
	}
};

it('Activity lists pages by views and agent turns by access point', () =>
	shown('activity', async () => {
		await expect.element(page.getByText('People who opened a page: 4')).toBeInTheDocument();
		const routes = page.getByRole('rowheader').elements().map((cell) => cell.textContent?.trim());
		// most viewed first, then the access points in the host's order
		expect(routes).toEqual([
			'/app/sales/orders',
			'/app/sales/quotes',
			'Norbius (staff)',
			'System agent'
		]);
		await expect.element(page.getByText('Not recorded')).toBeInTheDocument();
		await expect.element(page.getByRole('row', { name: /System agent 2 0 18 0/ })).toBeInTheDocument();
	}));

it('Improvements lays each thread in its status lane, and a card opens its agent conversation', () => {
	const opened: string[] = [];
	return shown(
		'improvements',
		async () => {
			const waiting = page.getByRole('region', { name: 'Needs your answer' });
			await expect.element(waiting.getByText('Dates show a day early')).toBeInTheDocument();
			await expect
				.element(waiting.getByText('question: Which timezone should the report use?'))
				.toBeInTheDocument();
			const open = page.getByRole('region', { name: 'Open' });
			await expect.element(open.getByText('Automation payroll keeps failing')).toBeInTheDocument();
			// no agent started on it: nothing to open
			expect(open.getByRole('button').elements()).toHaveLength(0);
			await expect
				.element(page.getByRole('region', { name: 'Agent working' }).getByText('Nothing here'))
				.toBeInTheDocument();
			await waiting.getByRole('button', { name: /Dates show a day early/ }).click();
			expect(opened).toEqual(['c1']);
		},
		(id) => opened.push(id)
	);
});
