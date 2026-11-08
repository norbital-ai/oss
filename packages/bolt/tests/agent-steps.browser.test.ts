/// <reference types="@vitest/browser-playwright" />
import { expect, it } from '@effect/vitest';
import { mount, tick, unmount } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import Steps from '../src/shell/agent/Steps.svelte';
import type { AgentRow } from '../src/protocol/schema.ts';
import './support/shell.css';

it('a workspace_list_dir step shows the tree itself, with no tabs', async () => {
	const tree = '/  <- cwd\n└── src/\n    └── +workspace.ts';
	const step: AgentRow = {
		id: 'listed',
		seq: 1,
		role: 'tool',
		text: '',
		state: null,
		tag: null,
		tool: { name: 'workspace_list_dir', failed: false, args: '{}', result: tree }
	};
	const host = document.body.appendChild(document.createElement('div'));
	const view = mount(Steps, {
		target: host,
		props: { steps: [step], t: (key: string) => key, opened: new SvelteSet(['listed']) }
	});
	await tick();
	expect(host.querySelector('[data-step-pane="tree"]')?.textContent).toBe(tree);
	expect(host.querySelector('[role="tablist"]')).toBeNull();
	expect(host.textContent).toContain('Listed the source');
	await unmount(view);
	host.remove();
});
