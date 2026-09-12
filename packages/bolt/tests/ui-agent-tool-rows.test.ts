// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { projectConversations } from '../src/client/ui/agent/conversation-selector.js';
import { pairToolCalls, subagentLink } from '../src/client/ui/agent/tool-rows.js';
import {
	projectConversationMessages,
	projectTurns,
	type TurnRow,
	type PanelMessage
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';
import AgentTranscriptList from './support/agent-transcript-list.svelte';

// Exercise the mounted rows; editor and markdown formatting are separate surfaces.
vi.mock('@norbital-ai/ui/code-editor', async () => ({
	CodeEditor: (await import('./support/agent-streaming-content.svelte')).default
}));
vi.mock('@norbital-ai/ui/markdown-editor', async () => ({
	ReadonlyMarkdown: (await import('./support/agent-streaming-content.svelte')).default
}));
vi.mock('@norbital-ai/ui/layout', async () => {
	const { default: Fragment } = await import('./support/finder-test-fragment.svelte');
	return { Inline: Fragment, Stack: Fragment };
});
// The ui build's tabs entry is not resolvable here; the double renders every tab's content.
vi.mock('@norbital-ai/ui/tabs', async () => ({
	Tabs: (await import('./support/agent-tabs-double.svelte')).default
}));

const parentTask = '00000000-0000-4000-8000-000000000501';
const childTask = '00000000-0000-4000-8000-000000000502';
const grandchildTask = '00000000-0000-4000-8000-000000000503';
const parentRun = '00000000-0000-4000-8000-000000000511';
const childRun = '00000000-0000-4000-8000-000000000512';
const grandchildRun = '00000000-0000-4000-8000-000000000513';

const runRow = (id: string, conversationId: string, extra: Record<string, unknown> = {}) => ({
	id,
	conversation_id: conversationId,
	input_message_id: '00000000-0000-4000-8000-000000000520',
	mode: 'agent',
	phase: 'model',
	input_through_sequence: 0,
	context_window_tokens: 1_000_000,
	model_id: 'openrouter/test-model',
	status: 'succeeded',
	...extra
});

const taskRow = (id: string, agentId: string, parentId: string | null) => ({
	id,
	agent_id: agentId,
	audience: 'personal',
	parent_id: parentId,
	status: 'done',
	active_plan_id: null,
	active_turn_id: null
});

const toolCall = (id: string, name: string, params: unknown) =>
	({ type: 'tool-call', id, name, params }) as const;
const toolResult = (id: string, name: string, result: unknown, isFailure = false) =>
	({ type: 'tool-result', id, name, isFailure, result }) as const;

function mountList(messages: readonly PanelMessage[], runs: readonly TurnRow[], tasks: unknown[] = []) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(AgentTranscriptList, {
		target,
		props: {
			messages: messages.filter((message) => message.conversationId === (messages[0]?.conversationId ?? '')),
			transcript: { tasks: projectConversations(tasks), messages, runs, plans: [] }
		}
	});
	flushSync();
	return {
		target,
		dispose: async () => {
			await unmount(component);
			target.remove();
		}
	};
}

describe('AGENT-UI1 one row per tool call', () => {
	it('renders one row named after the tool, no "Tool" speaker, at the text parts left edge', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId: parentTask, message: { role: 'user', content: 'Which skills exist?' } },
				{
					conversationId: parentTask,
					runId: parentRun,
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'Let me look.' },
							toolCall('call-1', 'list_skills', {})
						]
					}
				},
				{
					conversationId: parentTask,
					runId: parentRun,
					message: {
						role: 'tool',
						content: [toolResult('call-1', 'list_skills', { skills: ['payroll'] })]
					}
				},
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'assistant', content: [{ type: 'text', text: 'One skill: payroll.' }] }
				}
			])
		);
		const view = mountList(messages, projectTurns([runRow(parentRun, parentTask)]));
		try {
			const rows = [...view.target.querySelectorAll('[data-tool-row]')];
			expect(rows.map((row) => row.getAttribute('data-tool-row'))).toEqual(['list_skills']);
			const row = rows[0]!;
			expect(row.getAttribute('data-tool-state')).toBe('done');
			// The result rides the call's row: the tool message renders no list item of its own.
			expect(view.target.querySelectorAll('li[data-role="tool"]')).toHaveLength(0);
			expect(view.target.querySelectorAll('li')).toHaveLength(3);
			expect(view.target.textContent).not.toContain('Tool');
			expect([...view.target.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label'))).not.toContain('Tool');
			// Both payloads live inside the one row (the editor double prints the value as text).
			expect(row.textContent).toContain('payroll');
			expect(row.querySelectorAll('p')).toHaveLength(2);
			// Left edge: the row carries no horizontal padding, exactly like the text part beside it.
			const text = view.target.querySelector('[data-text-part]')!;
			expect(row.className).not.toMatch(/\bpx-/);
			expect(text.className).not.toMatch(/\bpx-/);
			expect(row.parentElement).toBe(text.parentElement);
			expect(getComputedStyle(row).paddingLeft).toBe(getComputedStyle(text).paddingLeft);
			expect(getComputedStyle(row).marginLeft).toBe(getComputedStyle(text).marginLeft);
		} finally {
			await view.dispose();
		}
	});

	it('keeps a wrench on a call whose result has not arrived, and an alert on a failed one', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId: parentTask,
					runId: parentRun,
					message: {
						role: 'assistant',
						content: [toolCall('call-1', 'read_skill', { name: 'payroll' }), toolCall('call-2', 'todo', {})]
					}
				},
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'tool', content: [toolResult('call-2', 'todo', 'boom', true)] }
				}
			])
		);
		const view = mountList(messages, projectTurns([runRow(parentRun, parentTask)]));
		try {
			const states = [...view.target.querySelectorAll('[data-tool-row]')].map((row) => [
				row.getAttribute('data-tool-row'),
				row.getAttribute('data-tool-state')
			]);
			expect(states).toEqual([
				['read_skill', 'pending'],
				['todo', 'failed']
			]);
		} finally {
			await view.dispose();
		}
	});
});

describe('AGENT-UI2 reasoning only when requested', () => {
	const reasoningTurn = (text: string) =>
		projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId: parentTask,
					runId: parentRun,
					message: {
						role: 'assistant',
						content: [
							{ type: 'reasoning', text },
							{ type: 'text', text: 'Done.' }
						]
					}
				}
			])
		);

	/**
	 * Reasoning is captured and shown, always. There is no longer a run flag deciding it, so the only
	 * question left is whether the part has anything to read — which is the renderer's alone.
	 */
	it('renders the provider filler the old flag existed to hide', async () => {
		const view = mountList(reasoningTurn('None.'), projectTurns([runRow(parentRun, parentTask)]));
		try {
			expect(view.target.querySelectorAll('[data-reasoning-part]')).toHaveLength(1);
			expect(view.target.textContent).toContain('None.');
			expect(view.target.textContent).toContain('Done.');
		} finally {
			await view.dispose();
		}
	});

	it('renders one reasoning element whenever the text is not blank', async () => {
		const view = mountList(
			reasoningTurn('Checked the roster first.'),
			projectTurns([runRow(parentRun, parentTask)])
		);
		try {
			expect(view.target.querySelectorAll('[data-reasoning-part]')).toHaveLength(1);
			expect(view.target.textContent).toContain('Checked the roster first.');
		} finally {
			await view.dispose();
		}
	});

	it('never renders a whitespace-only part, which is a status and not content', async () => {
		const runs = projectTurns([runRow(parentRun, parentTask)]);
		const view = mountList(reasoningTurn('  \n'), runs);
		try {
			expect(view.target.querySelectorAll('[data-reasoning-part]')).toHaveLength(0);
		} finally {
			await view.dispose();
		}
	});
});

describe('AGENT-SUB2 nested child conversation', () => {
	const spawnCall = (id: string, agentId: string) =>
		toolCall(id, 'subagent', { action: 'spawn', agentId, instruction: 'Look it up.' });
	const spawned = (id: string, conversationId: string) =>
		toolResult(id, 'subagent', { conversationId, messageId: 'd', state: 'running' });

	const fixture = () =>
		projectConversationMessages(
			canonicalAgentRows([
				{ conversationId: parentTask, message: { role: 'user', content: 'Research the statute.' } },
				{
					conversationId: parentTask,
					runId: parentRun,
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'Delegating.' }, spawnCall('call-1', 'researcher')]
					}
				},
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'tool', content: [spawned('call-1', childTask)] }
				},
				{
					conversationId: childTask,
					author: { kind: 'parent-agent', id: parentTask },
					message: { role: 'user', content: 'Look it up.' }
				},
				{
					conversationId: childTask,
					runId: childRun,
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'Child reply in **markdown**.' },
							toolCall('call-2', 'list_skills', {}),
							spawnCall('call-3', 'clerk')
						]
					}
				},
				{
					conversationId: childTask,
					runId: childRun,
					message: {
						role: 'tool',
						content: [toolResult('call-2', 'list_skills', ['statute']), spawned('call-3', grandchildTask)]
					}
				},
				{
					conversationId: grandchildTask,
					author: { kind: 'parent-agent', id: childTask },
					message: { role: 'user', content: 'Fetch section 4.' }
				},
				{
					conversationId: grandchildTask,
					runId: grandchildRun,
					message: {
						role: 'assistant',
						content: [
							{ type: 'text', text: 'Grandchild reply.' },
							toolCall('call-4', 'read_skill', { name: 'statute' })
						]
					}
				},
				{
					conversationId: grandchildTask,
					runId: grandchildRun,
					message: { role: 'tool', content: [toolResult('call-4', 'read_skill', 'Section 4 text')] }
				}
			])
		);
	const fixtureRuns = () =>
		projectTurns([
			runRow(parentRun, parentTask),
			runRow(childRun, childTask),
			runRow(grandchildRun, grandchildTask)
		]);
	const fixtureTasks = () => [
		taskRow(parentTask, 'web', null),
		taskRow(childTask, 'researcher', parentTask),
		taskRow(grandchildTask, 'clerk', childTask)
	];

	it('links a spawn row to its child through the stored result', () => {
		const messages = fixture();
		const tools = pairToolCalls(messages);
		const content = messages[1]!.message.content;
		const call = typeof content === 'string' ? undefined : content[1];
		expect(call?.type).toBe('tool-call');
		const link =
			call?.type === 'tool-call' ? subagentLink(call, tools.resultsByCallId.get(call.id)) : null;
		expect(link).toMatchObject({ toolCallId: 'call-1', agentId: 'researcher', conversationId: childTask, failure: null, pending: false });
		expect(subagentLink(toolCall('x', 'list_skills', {}), undefined)).toBeNull();
	});

	it('renders parent, child and grandchild as three nested blocks with markdown and tool rows', async () => {
		const view = mountList(fixture(), fixtureRuns(), fixtureTasks());
		try {
			const blocks = [...view.target.querySelectorAll('[data-subagent-conversation]')];
			expect(blocks.map((block) => block.getAttribute('data-subagent-conversation'))).toEqual(['researcher', 'clerk']);
			const [child, grandchild] = blocks as [HTMLElement, HTMLElement];
			// The grandchild block sits inside the child block, which sits inside the parent's list.
			expect(child.contains(grandchild)).toBe(true);
			expect(view.target.querySelector('ol')!.contains(child)).toBe(true);
			// Each level has markdown and tool rows of its own.
			expect(view.target.textContent).toContain('Delegating.');
			expect(child.textContent).toContain('Child reply in **markdown**.');
			expect(grandchild.textContent).toContain('Grandchild reply.');
			const childRows = [...child.querySelectorAll('[data-tool-row]')].map((row) => row.getAttribute('data-tool-row'));
			expect(childRows).toEqual(['list_skills', 'read_skill']);
			expect([...grandchild.querySelectorAll('[data-tool-row]')].map((row) => row.getAttribute('data-tool-row'))).toEqual(['read_skill']);
			// The spawn call itself never renders as a plain tool row: the block is its face.
			expect(view.target.querySelectorAll('[data-tool-row="subagent"]')).toHaveLength(0);
			// Done children are collapsed; the raw payload stays behind a closed toggle.
			expect(child.getAttribute('data-subagent-state')).toBe('done');
			expect((child as HTMLDetailsElement).open).toBe(false);
			for (const raw of view.target.querySelectorAll('[data-subagent-raw]')) {
				expect((raw as HTMLDetailsElement).open).toBe(false);
			}
			expect(view.target.querySelectorAll('[data-subagent-raw]')).toHaveLength(2);
		} finally {
			await view.dispose();
		}
	});

	it('renders a failed spawn as a nested block whose only line is the error', async () => {
		const error = 'Bolt.AccessControl.AccessDenied: unknown agent (agent on sg-statutory-law-query)';
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'assistant', content: [spawnCall('call-9', 'sg-statutory-law-query')] }
				},
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'tool', content: [toolResult('call-9', 'subagent', error, true)] }
				}
			])
		);
		const view = mountList(messages, projectTurns([runRow(parentRun, parentTask)]));
		try {
			const block = view.target.querySelector('[data-subagent-conversation]') as HTMLDetailsElement;
			expect(block.getAttribute('data-subagent-conversation')).toBe('sg-statutory-law-query');
			expect(block.getAttribute('data-subagent-state')).toBe('failed');
			const lines = [...block.querySelectorAll('[data-subagent-failure], ol > li')];
			expect(lines).toHaveLength(1);
			expect(lines[0]!.textContent).toBe(error);
			expect(block.querySelectorAll('[data-tool-row]')).toHaveLength(0);
			expect((block.querySelector('[data-subagent-raw]') as HTMLDetailsElement).open).toBe(false);
		} finally {
			await view.dispose();
		}
	});

	it('keeps a spawn without a result open as a starting child', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{
					conversationId: parentTask,
					runId: parentRun,
					message: { role: 'assistant', content: [spawnCall('call-5', 'researcher')] }
				}
			])
		);
		const view = mountList(messages, projectTurns([runRow(parentRun, parentTask, { status: 'running' })]));
		try {
			const block = view.target.querySelector('[data-subagent-conversation]') as HTMLDetailsElement;
			expect(block.getAttribute('data-subagent-state')).toBe('starting');
			expect(block.open).toBe(true);
		} finally {
			await view.dispose();
		}
	});
});
