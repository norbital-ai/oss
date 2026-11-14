// @vitest-environment happy-dom
import './setup-happy-dom.ts';
import { expect, it, vi } from '@effect/vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { mount_edge } from '@norbital-ai/ui/effect';
import { mount, unmount } from 'svelte';
import StudioApproval from '../src/shell/agent/StudioApproval.svelte';
import { shell_api } from '../src/shell/runtime.ts';
import type { StudioView } from '@norbital-ai/host-api';
import type { AgentRow } from '../src/protocol/schema.ts';

const studio: StudioView = {
	commit: 'head',
	files: {},
	changes: [],
	sections: null,
	log: [],
	preview: null,
	releases: [],
	change_sets: [
		{
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
			preview: {
				url: 'about:blank',
				commit: 'head',
				artifact: 'artifact',
				stale: false,
				impact: {
					duration_ms: 2000,
					steps: [{ id: 'drop:column:jobs.code', hazard: 'destructive', rows: 3, summary: '' }]
				}
			},
			log: [],
			created_at: '2026-11-06T00:00:00Z',
			updated_at: '2026-11-06T00:00:00Z'
		}
	],
	approvals: [
		{
			id: 'ask',
			op: { op: 'change.merge', id: '1' },
			requestor: 'ana',
			conversation: 'talk',
			at: '2026-11-06T00:00:00Z',
			head: 'head',
			destructive: ['drop:column:jobs.code']
		}
	]
};
const summary = 'Replaces the blank starter with a field operations workspace. '.repeat(6);
const step: AgentRow = {
	id: 'step',
	seq: 1,
	role: 'tool',
	text: null,
	state: 'confirm',
	tag: 'confirm',
	tool: {
		behavior: {},
		name: 'workspace_merge',
		failed: false,
		approval: 'ask',
		studio: 'merge',
		args: JSON.stringify({ summary })
	}
};

it('discloses with icon summaries, warns in an alert and lists the merge facts', async () => {
	const target = document.body.appendChild(document.createElement('div'));
	const dispose = mount_edge(ManagedRuntime.make(Layer.empty));
	const card = mount(StudioApproval, {
		target,
		props: {
			t: (key: string) => key,
			step,
			api: { ...shell_api(async () => Response.json({ value: null })), studio: () => Effect.succeed(studio) }
		}
	});
	try {
		await vi.waitFor(() => expect(target.querySelector('[data-approval="ask"]')).not.toBeNull());
		const toggles = [...target.querySelectorAll('details > summary')];
		expect(toggles.map((one) => one.closest('details')?.dataset['role'])).toEqual(['summary', 'impact']);
		for (const toggle of toggles) {
			// a chevron icon, never the native marker or a text glyph
			expect(toggle.classList.contains('list-none')).toBe(true);
			expect(toggle.querySelector('svg')).not.toBeNull();
			expect(toggle.textContent).not.toMatch(/[▶▸►▾▼]/u);
		}
		const warning = target.querySelector('[data-role="warning"]');
		expect(warning?.getAttribute('role')).toBe('alert');
		expect(warning?.textContent).toContain('Some stored data will be removed or changed.');
		expect([...target.querySelectorAll('[data-role="facts"] li')].map((li) => li.textContent?.trim())).toEqual([
			'Expected downtime about 2 s (measured on the preview)',
			'Rolling back later would lose anything written after this merge'
		]);
	} finally {
		await unmount(card);
		await dispose();
		target.remove();
	}
});
