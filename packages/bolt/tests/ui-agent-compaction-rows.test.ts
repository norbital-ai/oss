// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { projectConversations } from '../src/client/ui/agent/conversation-selector.js';
import { projectAgentContextView } from '../src/client/ui/agent/context-view.js';
import { pairToolCalls } from '../src/client/ui/agent/tool-rows.js';
import {
	projectConversationMessages,
	projectPlans,
	projectTurns,
	type TurnRow,
	type PanelMessage
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';
import AgentTranscriptList from './support/agent-transcript-list.svelte';
import AgentContextSegment from '../src/client/ui/agent/agent-context-segment.svelte';

// Exercise the mounted rows; editor and markdown formatting are separate surfaces. The markdown
// double prints its content verbatim and exposes the `allowHtml` gate it was handed.
vi.mock('@norbital-ai/ui/code-editor', async () => ({
	CodeEditor: (await import('./support/agent-streaming-content.svelte')).default
}));
vi.mock('@norbital-ai/ui/markdown-editor', async () => ({
	ReadonlyMarkdown: (await import('./support/agent-streaming-content.svelte')).default
}));
vi.mock('@norbital-ai/ui/layout', async () => {
	const { default: Fragment } = await import('./support/finder-test-fragment.svelte');
	return { Bound: Fragment, Inline: Fragment, Scroll: Fragment, Stack: Fragment };
});
// The ui build's tabs entry is not resolvable here; the double renders every tab's content.
vi.mock('@norbital-ai/ui/tabs', async () => ({
	Tabs: (await import('./support/agent-tabs-double.svelte')).default
}));

const conversationId = '00000000-0000-4000-8000-000000000601';
const runId = '00000000-0000-4000-8000-000000000602';

const runRow = (): TurnRow =>
	projectTurns([
		{
			id: runId,
			conversation_id: conversationId,
			input_message_id: '00000000-0000-4000-8000-000000000603',
			mode: 'agent',
			phase: 'model',
			input_through_sequence: 1,
			context_window_tokens: 1_000_000,
			model_id: 'openrouter/test-model',
			status: 'running'
		}
	])[0]!;

const toolCall = (id: string, name: string, params: unknown) =>
	({ type: 'tool-call', id, name, params }) as const;
const toolResult = (id: string, name: string, result: unknown) =>
	({ type: 'tool-result', id, name, isFailure: false, result }) as const;

/** The id `canonicalAgentRows` assigns to the row at `sequence`. */
const fixtureMessageId = (sequence: number): string =>
	`00000000-0000-4000-8000-${String(sequence + 1).padStart(12, '0')}`;

/** The hr-payroll host's shape: N read calls, an automatic checkpoint, then M more and a reply. */
const GLM_TOOL_MARKUP =
	'<tool_call>read_collection<arg_key>collection</arg_key><arg_value>employments</arg_value><arg_key>cursor</arg_key><arg_value>eyJ2Ijoz</arg_value></tool_call>';

function fixtureRows(before: number, after: number, checkpointText: string) {
	const call = (index: number) => ({
		conversationId,
		runId,
		message: {
			role: 'assistant' as const,
			content: [toolCall(`call-${index}`, 'read_collection', { collection: 'employments' })]
		}
	});
	const result = (index: number) => ({
		conversationId,
		runId,
		message: {
			role: 'tool' as const,
			content: [toolResult(`call-${index}`, 'read_collection', { rows: [index] })]
		}
	});
	const rows: Array<Parameters<typeof canonicalAgentRows>[0][number]> = [
		{
			conversationId,
			runId,
			message: { role: 'user', content: 'How many employees does Nihon Pigment have?' },
			annotation: { tag: 'input', priority: 'normal', consumedAfterSequence: 0 }
		}
	];
	for (let index = 0; index < before; index += 1) rows.push(call(index), result(index));
	const cutoff = rows.length - 1;
	// Legacy checkpoints retained the whole turn. The UI must still group its earlier messages.
	const retainedMessageIds = rows.map((_row, sequence) => fixtureMessageId(sequence));
	rows.push({
		conversationId,
		runId,
		message: { role: 'assistant', content: checkpointText },
		annotation: { tag: 'compact', origin: 'automatic', cutoff, retainedMessageIds }
	});
	rows.push({
		conversationId,
		runId,
		message: {
			role: 'system',
			content:
				'Automatic Compact left the projection above the context bound (75761 bytes against 65536). This turn proceeds over the compacted projection without a second checkpoint.'
		}
	});
	for (let index = before; index < before + after; index += 1)
		rows.push(call(index), result(index));
	rows.push({
		conversationId,
		runId,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Nihon Pigment has **59** current employees.' }]
		}
	});
	return rows;
}

function mountList(
	messages: readonly PanelMessage[],
	all: readonly PanelMessage[],
	runs: readonly TurnRow[]
) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(AgentTranscriptList, {
		target,
		props: {
			messages,
			transcript: { tasks: projectConversations([]), messages: all, runs, plans: [] }
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

describe('AGENT-UI5 rows after an automatic checkpoint', () => {
	it('keeps a draft expandable without moving discussion into tabs', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId, message: { role: 'user', content: 'Discuss the requirements.' } },
				{ conversationId, message: { role: 'assistant', content: 'We can validate the export.' } }
			])
		);
		const plan = projectPlans([
			{
				id: '00000000-0000-4000-8000-000000000605',
				conversation_id: conversationId,
				revision: 1,
				checkpoint_sequence: 1,
				body: '# Export plan',
				status: 'draft',
				created_at: '2026-09-01'
			}
		])[0]!;
		const view = projectAgentContextView({ messages, runs: [], activePlan: plan });
		expect(view.focusMessages).toEqual(messages);
		expect(view.historyMessages).toEqual([]);
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(AgentContextSegment, { target, props: { plan, messages, runs: [] } });
		flushSync();
		try {
			const toggle = target.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
			expect(toggle.getAttribute('aria-expanded')).toBe('false');
			expect(toggle.textContent).toContain('Draft plan');
			expect(target.querySelector('[role="tab"]')).toBeNull();
			expect(target.textContent).not.toContain('Transcript');
			toggle.click();
			flushSync();
			expect(toggle.getAttribute('aria-expanded')).toBe('true');
			expect(target.textContent).toContain('# Export plan');
		} finally {
			await unmount(component);
			target.remove();
		}
	});

	it('uses the same summary/transcript boundary for a replacement plan', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId, message: { role: 'user', content: 'Original objective' } },
				{ conversationId, message: { role: 'assistant', content: 'Plan one' } },
				{ conversationId, message: { role: 'user', content: 'Add validation' } },
				{ conversationId, message: { role: 'assistant', content: 'Plan two with validation' } }
			])
		);
		const plan = projectPlans([
			{
				id: '00000000-0000-4000-8000-000000000605',
				conversation_id: conversationId,
				revision: 2,
				checkpoint_sequence: 3,
				body: 'Plan two with validation',
				status: 'active',
				created_at: '2026-09-01'
			}
		])[0]!;
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(AgentContextSegment, { target, props: { plan, runs: [], messages } });
		flushSync();
		try {
			expect(target.querySelector('[data-context-boundary="plan"]')).not.toBeNull();
			expect(target.querySelector('[data-tab="summary"]')?.textContent).toContain(plan.body);
			expect(target.querySelector('[data-tab="summary"]')?.textContent).not.toContain('Plan one');
			const transcript = target.querySelector('[data-tab="transcript"]')?.textContent;
			expect(transcript).toContain('Original objective');
			expect(transcript).toContain('Plan one');
			expect(transcript).toContain('Add validation');
			expect(
				projectAgentContextView({ messages, runs: [], activePlan: plan }).focusMessages
			).toEqual([]);
		} finally {
			await unmount(component);
			target.remove();
		}
	});

	it('renders every tool row and the reply that follow the checkpoint, in sequence order', async () => {
		const before = 6;
		const after = 12;
		const messages = projectConversationMessages(
			canonicalAgentRows(fixtureRows(before, after, 'Summary so far.'))
		);
		const runs = [runRow()];
		const view = projectAgentContextView({ messages, runs });
		expect(view.historyMessages.map((message) => message.sequence)).toEqual(
			Array.from({ length: before * 2 + 2 }, (_, sequence) => sequence)
		);
		expect(view.focusMessages).toHaveLength(after * 2 + 2);
		const list = mountList(view.focusMessages, messages, runs);
		try {
			const items = [...list.target.querySelectorAll('li')];
			const systemIndex = items.findIndex((item) => item.getAttribute('data-role') === 'system');
			expect(systemIndex).toBe(-1);
			expect(list.target.textContent).not.toContain('without a second checkpoint');
			const afterSystem = items;
			// Routine system notes stay in model context, not in the visible transcript.
			expect(afterSystem).toHaveLength(after + 1);
			const rowsAfter = afterSystem.flatMap((item) => [
				...item.querySelectorAll('[data-tool-row]')
			]);
			expect(rowsAfter.map((row) => row.getAttribute('data-tool-row'))).toEqual(
				Array.from({ length: after }, () => 'read_collection')
			);
			expect(rowsAfter.map((row) => row.getAttribute('data-tool-state'))).toEqual(
				Array.from({ length: after }, () => 'done')
			);
			expect(afterSystem.at(-1)?.querySelector('[data-text-part]')?.textContent).toContain('59');
			// Every call after the checkpoint found its result on its own row.
			const tools = pairToolCalls(messages);
			for (let index = before; index < before + after; index += 1)
				expect(tools.resultsByCallId.has(`call-${index}`)).toBe(true);
			// And the whole list is one ascending pass over the transcript.
			expect(list.target.querySelectorAll('[data-tool-row]')).toHaveLength(after);
		} finally {
			await list.dispose();
		}
	});

	it('shows the checkpoint text as markdown without HTML, so tool-call markup stays legible', async () => {
		const messages = projectConversationMessages(
			canonicalAgentRows(fixtureRows(2, 1, GLM_TOOL_MARKUP))
		);
		const runs = [runRow()];
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(AgentContextSegment, {
			target,
			props: { runs, messages, tools: pairToolCalls(messages) }
		});
		flushSync();
		try {
			expect(target.querySelector('[data-context-boundary="compaction"]')).not.toBeNull();
			expect(target.querySelector('[data-tab="transcript"]')?.textContent).toContain(
				'How many employees does Nihon Pigment have?'
			);
			expect(target.textContent).not.toContain('5 retained messages');
			expect(target.querySelector('[aria-label="About compaction"]')).not.toBeNull();
			const summary = target.querySelector('[data-tab="summary"] p[data-allow-html]');
			expect(summary?.getAttribute('data-allow-html')).toBe('false');
			expect(summary?.textContent).toBe(GLM_TOOL_MARKUP);
			// The transcript's own markdown renders are gated the same way.
			const list = mountList(
				projectAgentContextView({ messages, runs }).focusMessages,
				messages,
				runs
			);
			try {
				const reply = list.target.querySelector('[data-text-part] p[data-allow-html]');
				expect(reply?.getAttribute('data-allow-html')).toBe('false');
			} finally {
				await list.dispose();
			}
		} finally {
			await unmount(component);
			target.remove();
		}
	});
});

it('hides routine system notes but surfaces task failures without discarding history', async () => {
	const messages = projectConversationMessages(
		canonicalAgentRows([
			{
				conversationId,
				runId,
				message: { role: 'system', content: 'Private checkpoint instructions' }
			},
			{
				conversationId,
				runId,
				message: { role: 'system', content: 'Task failed: Provider unavailable' }
			}
		])
	);
	const list = mountList(messages, messages, [runRow()]);
	try {
		expect(list.target.textContent).not.toContain('Private checkpoint instructions');
		expect(list.target.textContent).toContain('Task failed: Provider unavailable');
		expect(messages).toHaveLength(2);
	} finally {
		await list.dispose();
	}
});
