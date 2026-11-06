/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { Effect, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { mountEdge } from '@norbital-ai/ui/effect';
import { page } from 'vitest/browser';
import { mount, unmount } from 'svelte';
import StudioApproval from '../src/shell/agent/StudioApproval.svelte';
import { shellApi } from '../src/shell/runtime.ts';
import type { StudioChangeSet, StudioView } from '../src/shell/studio/model.ts';
import type { AgentRow } from '../src/protocol/schema.ts';
import './support/shell.css';

const open: StudioChangeSet = {
	id: '1',
	title: 'Add notes',
	state: 'open',
	openedBy: 'ana',
	contributors: ['ana'],
	branch: 'change/1',
	base: 'base',
	head: 'head',
	commits: ['Add notes'],
	behind: 0,
	preview: null,
	log: [],
	createdAt: '2026-11-06T00:00:00Z',
	updatedAt: '2026-11-06T00:00:00Z'
};
const view = (change: StudioChangeSet, approvals: StudioView['approvals'] = []): StudioView => ({
	commit: 'head',
	files: {},
	changes: [],
	sections: null,
	log: [],
	preview: null,
	releases: [],
	changeSets: [change],
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
	tool: { name: 'workspace_merge', failed: false, approval: 'ask', studio: 'merge' }
};

const decided = async (after: StudioChangeSet, words: string) => {
	const target = document.createElement('div');
	document.body.replaceChildren(target);
	const runtime = ManagedRuntime.make(TestClock.layer());
	const dispose = mountEdge(runtime);
	let answer = view(open, held);
	const shown = mount(StudioApproval, {
		target,
		props: {
			t: (key: string) => key,
			step,
			api: {
				...shellApi(async () => Response.json({ value: null })),
				studio: () => Effect.succeed(answer),
				studioRun: () => Effect.sync(() => ((answer = view(after)), answer))
			}
		}
	});
	try {
		await page.getByRole('button', { name: 'Approve', exact: true }).click();
		await expect.element(page.getByText('Approved. Merging into live…')).toBeVisible();
		await runtime.runPromise(TestClock.adjust('2 seconds'));
		await expect.poll(() => target.textContent).toContain(words);
	} finally {
		await unmount(shown);
		await dispose();
		target.remove();
	}
};

it('the card follows an approved merge to its end', () =>
	decided({ ...open, state: 'merged' }, 'Merged. Live runs the new version.'));

it('a merge that fails says why on the card', () =>
	decided(
		{
			...open,
			merge: { state: 'failed', at: '2026-11-06T00:00:00Z', head: 'head', error: 'Tests failed' }
		},
		'The merge failed: Tests failed'
	));
