/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Effect, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { mount_edge } from '@norbital-ai/ui/effect';
import { page, userEvent } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import StudioApproval from '../src/shell/agent/StudioApproval.svelte';
import { shell_api } from '../src/shell/runtime.ts';
import type { StudioChangeSet, StudioView } from '@norbital-ai/host-api';
import type { AgentRow } from '../src/protocol/schema.ts';
import './support/shell.css';

const open: StudioChangeSet = {
	id: '1',
	title: 'Add notes',
	state: 'open',
	opened_by: 'ana',
	contributors: ['ana'],
	branch: 'change/1',
	base: 'base',
	head: 'head',
	commits: ['Add notes'],
	behind: 0,
	preview: null,
	log: [],
	created_at: '2026-11-06T00:00:00Z',
	updated_at: '2026-11-06T00:00:00Z'
};
const view = (change: StudioChangeSet, approvals: StudioView['approvals'] = []): StudioView => ({
	commit: 'head',
	files: {},
	changes: [],
	sections: null,
	log: [],
	preview: null,
	releases: [],
	change_sets: [change],
	approvals
});
const held: StudioView['approvals'] = [
	{
		id: 'ask',
		op: { op: 'change.merge', id: '1' },
		requestor: 'ana',
		conversation: 'talk',
		at: '2026-11-06T00:00:00Z',
		head: 'head'
	}
];
const step: AgentRow = {
	id: 'step',
	seq: 1,
	role: 'tool',
	text: null,
	state: 'confirm',
	tag: 'confirm',
	tool: { behavior: {}, name: 'workspace_merge', failed: false, approval: 'ask', studio: 'merge' }
};

const decided = async (after: StudioChangeSet, words: string) => {
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const runtime = ManagedRuntime.make(TestClock.layer());
	const dispose = mount_edge(runtime);
	let answer = view(open, held);
	const shown = mount(StudioApproval, {
		target,
		props: {
			t: (key: string) => key,
			step,
			api: {
				...shell_api(async () => Response.json({ value: null })),
				studio: () => Effect.succeed(answer),
				studio_run: () => Effect.sync(() => ((answer = view(after)), answer))
			}
		}
	});
	try {
		await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
		await expect.element(page.getByText('Applying changes… You can keep using the app.')).toBeVisible();
		await runtime.runPromise(TestClock.adjust('2 seconds'));
		await expect.poll(() => target.textContent).toContain(words);
	} finally {
		await unmount(shown);
		await dispose();
		target.remove();
	}
};

it('the card follows an approved merge to its end', () =>
	decided({ ...open, state: 'merged' }, 'Changes applied.'));

it('a merge that fails says why on the card', () =>
	decided(
		{
			...open,
			merge: { state: 'failed', at: '2026-11-06T00:00:00Z', head: 'head', error: 'Tests failed' }
		},
		'The update failed: Tests failed'
	));


it('discloses long data changes inside a bounded card while keeping its decision reachable', async () => {
	const previous = { width: innerWidth, height: innerHeight };
	await page.viewport(1100, 800);
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const dispose = mount_edge(ManagedRuntime.make(TestClock.layer()));
	const requests: unknown[] = [];
	const destructive = Array.from({ length: 45 }, (_, index) => `old_records.field_${index}`);
	const summary = 'Simplify the workspace and keep the information structured. '.repeat(15);
	const approval = held[0];
	if (approval === undefined) throw new Error('Missing approval fixture');
	const shown = mount(StudioApproval, { target, props: {
		t: (key: string) => key,
		step: { ...step, tool: { behavior: {}, name: 'workspace_merge', failed: false, approval: 'ask', studio: 'merge', args: JSON.stringify({ summary }) } },
		api: { ...shell_api(async () => Response.json({ value: null })),
			studio: () => Effect.succeed(view(open, [{ ...approval, destructive }])),
			studio_run: (op: unknown) => Effect.sync(() => { requests.push(op); return view(open); })
		}
	} });
	try {
		await expect.element(page.getByRole('button', { name: 'Apply changes', exact: true })).toBeVisible();
		const card = target.querySelector<HTMLElement>('[data-approval="ask"]');
		const details = target.querySelector<HTMLElement>('[aria-label="Change details"]');
		if (card === null || details === null) throw new Error('Missing approval card');
		expect(card.getBoundingClientRect().height).toBeLessThanOrEqual(innerHeight * 0.6 + 1);
		await expect.element(page.getByText(summary, { exact: true })).not.toBeVisible();
		await page.getByText('Review data changes and version', { exact: true }).click();
		await expect.poll(() => details.scrollHeight > details.clientHeight).toBe(true);
		expect(details.tabIndex).toBe(0);
		details.focus();
		expect(document.activeElement).toBe(details);
		const scroll_top = details.scrollTop;
		await userEvent.keyboard('{PageDown}');
		await expect.poll(() => details.scrollTop).toBeGreaterThan(scroll_top);
		expect(target.querySelectorAll('[data-role="impact"] li')).toHaveLength(45);
		const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
		await expect.element(cancel).toBeVisible();
		expect(cancel.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(card.getBoundingClientRect().bottom);
		await cancel.click();
		await expect.element(page.getByText('Changes rejected.', { exact: true })).toBeVisible();
		expect(requests).toEqual([{ op: 'approval.decide', id: 'ask', kind: 'rejected' }]);
	} finally {
		await unmount(shown);
		await dispose();
		target.remove();
		await page.viewport(previous.width, previous.height);
	}
});
