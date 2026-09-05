// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import { projectAgentMessages } from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';
import AgentStreamingView from './support/agent-streaming-view.svelte';

// Exercise the mounted transcript and its part lifecycle; editor formatting is a separate surface.
vi.mock('@norbital-ai/ui/code-editor', async () => ({ CodeEditor: (await import('./support/agent-streaming-content.svelte')).default }));
vi.mock('@norbital-ai/ui/markdown-editor', async () => ({ ReadonlyMarkdown: (await import('./support/agent-streaming-content.svelte')).default }));
vi.mock('@norbital-ai/ui/layout', async () => {
	const { default: Fragment } = await import('./support/finder-test-fragment.svelte');
	return { Inline: Fragment, Stack: Fragment };
});

it('renders reasoning immediately, fills completed parts without replacing the row, and marks interrupted work', async () => {
	const message = (reasoning: string, text: string | null, activeParts: number[], sequence: number) => projectAgentMessages(canonicalAgentRows([{
		taskId: '00000000-0000-4000-8000-000000000101', runId: '00000000-0000-4000-8000-000000000102',
		message: { role: 'assistant', content: [{ type: 'reasoning', text: reasoning }, ...(text === null ? [] : [{ type: 'text' as const, text }])] },
		annotation: { tag: 'generation', callId: 'fixture', sequence, activeParts }
	}]))[0]!;
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(AgentStreamingView, { target, props: { initial: message('', null, [0], 0) } });
	try {
		flushSync();
		const row = target.querySelector('li');
		expect(row?.getAttribute('aria-busy')).toBe('true');
		expect(target.textContent).toContain('Reasoning…');
		const details = target.querySelector('details')!;
		details.open = true;
		component.update(message('Verified the inputs.', '', [1], 1));
		flushSync();
		expect(target.querySelector('li')).toBe(row);
		expect(target.querySelector('details')?.open).toBe(true);
		expect(target.textContent).toContain('Verified the inputs.');
		expect(target.textContent).toContain('Writing…');
		component.update(message('Verified the inputs.', '', [1], 1), false);
		flushSync();
		expect(row?.getAttribute('aria-busy')).toBe('false');
		expect(target.textContent).toContain('Response interrupted');
	} finally { await unmount(component); target.remove(); }
});
