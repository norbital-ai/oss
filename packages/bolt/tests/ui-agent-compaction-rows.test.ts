// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { projectAgentTasks } from '../src/client/ui/agent/conversation-selector.js';
import { projectAgentContextView } from '../src/client/ui/agent/context-view.js';
import { pairToolCalls } from '../src/client/ui/agent/tool-rows.js';
import {
	projectAgentMessages,
	projectAgentRuns,
	type AgentRunRow,
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
	return { Inline: Fragment, Stack: Fragment };
});
// The ui build's tabs entry is not resolvable here; the double renders every tab's content.
vi.mock('@norbital-ai/ui/tabs', async () => ({
	Tabs: (await import('./support/agent-tabs-double.svelte')).default
}));

const taskId = '00000000-0000-4000-8000-000000000601';
const runId = '00000000-0000-4000-8000-000000000602';

const runRow = (): AgentRunRow =>
	projectAgentRuns([
		{
			id: runId,
			task_id: taskId,
			directive_id: '00000000-0000-4000-8000-000000000603',
			epoch: 1,
			mode: 'agent',
			phase: 'model',
			input_through_sequence: 1,
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
		taskId,
		runId,
		message: {
			role: 'assistant' as const,
			content: [toolCall(`call-${index}`, 'read_collection', { collection: 'employments' })]
		}
	});
	const result = (index: number) => ({
		taskId,
		runId,
		message: {
			role: 'tool' as const,
			content: [toolResult(`call-${index}`, 'read_collection', { rows: [index] })]
		}
	});
	const rows: Array<Parameters<typeof canonicalAgentRows>[0][number]> = [
		{
			taskId,
			runId,
			message: { role: 'user', content: 'How many employees does Nihon Pigment have?' },
			annotation: { tag: 'input', priority: 'normal', consumedAfterSequence: 0 }
		}
	];
	for (let index = 0; index < before; index += 1) rows.push(call(index), result(index));
	const cutoff = rows.length - 1;
	// As on the host: the run's own messages are retained, so the checkpoint hides nothing.
	const retainedMessageIds = rows.map((_row, sequence) => fixtureMessageId(sequence));
	rows.push({
		taskId,
		runId,
		message: { role: 'assistant', content: checkpointText },
		annotation: { tag: 'compact', origin: 'automatic', cutoff, retainedMessageIds }
	});
	rows.push({
		taskId,
		runId,
		message: {
			role: 'system',
			content:
				'Automatic Compact left the projection above the context bound (75761 bytes against 65536). This turn proceeds over the compacted projection without a second checkpoint.'
		}
	});
	for (let index = before; index < before + after; index += 1) rows.push(call(index), result(index));
	rows.push({
		taskId,
		runId,
		message: {
			role: 'assistant',
			content: [{ type: 'text', text: 'Nihon Pigment has **59** current employees.' }]
		}
	});
	return rows;
}

function mountList(messages: readonly PanelMessage[], all: readonly PanelMessage[], runs: readonly AgentRunRow[]) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(AgentTranscriptList, {
		target,
		props: { messages, transcript: { tasks: projectAgentTasks([]), messages: all, runs, plans: [] } }
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
	it('renders every tool row and the reply that follow the checkpoint, in sequence order', async () => {
		const before = 6;
		const after = 12;
		const messages = projectAgentMessages(canonicalAgentRows(fixtureRows(before, after, 'Summary so far.')));
		const runs = [runRow()];
		const view = projectAgentContextView({ messages, runs });
		// The checkpoint itself moves to the history tab; everything else stays in focus.
		expect(view.historyMessages.map((message) => message.sequence)).toEqual([before * 2 + 1]);
		expect(view.focusMessages).toHaveLength(messages.length - 1);
		const list = mountList(view.focusMessages, messages, runs);
		try {
			const items = [...list.target.querySelectorAll('li')];
			const systemIndex = items.findIndex((item) => item.getAttribute('data-role') === 'system');
			expect(systemIndex).toBeGreaterThan(0);
			expect(items[systemIndex]?.textContent).toContain('without a second checkpoint');
			const afterSystem = items.slice(systemIndex + 1);
			// M tool rows then the reply: M + 1 rendered items after the checkpoint's system line.
			expect(afterSystem).toHaveLength(after + 1);
			const rowsAfter = afterSystem.flatMap((item) => [...item.querySelectorAll('[data-tool-row]')]);
			expect(rowsAfter.map((row) => row.getAttribute('data-tool-row'))).toEqual(
				Array.from({ length: after }, () => 'read_collection')
			);
			expect(rowsAfter.map((row) => row.getAttribute('data-tool-state'))).toEqual(
				Array.from({ length: after }, () => 'done')
			);
			expect(afterSystem.at(-1)?.querySelector('[data-text-part]')?.textContent).toContain(
				'59'
			);
			// Every call after the checkpoint found its result on its own row.
			const tools = pairToolCalls(messages);
			for (let index = before; index < before + after; index += 1)
				expect(tools.resultsByCallId.has(`call-${index}`)).toBe(true);
			// And the whole list is one ascending pass over the transcript.
			expect(list.target.querySelectorAll('[data-tool-row]')).toHaveLength(before + after);
		} finally {
			await list.dispose();
		}
	});

	it('shows the checkpoint text as markdown without HTML, so tool-call markup stays legible', async () => {
		const messages = projectAgentMessages(canonicalAgentRows(fixtureRows(2, 1, GLM_TOOL_MARKUP)));
		const runs = [runRow()];
		const target = document.createElement('div');
		document.body.append(target);
		const component = mount(AgentContextSegment, {
			target,
			props: { runs, messages, tools: pairToolCalls(messages) }
		});
		flushSync();
		try {
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
