import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';

let replica = new FakeReplica();

// The panel reads its transcript through `getInitializedWorkspaceClient().db`. Mocking the module
// rather than the client keeps PGlite, the sync worker and the browser bootstrap out of a component
// test — none of them are the seam this file is about.
vi.mock('$lib/ui/state/client.js', () => ({
	getInitializedWorkspaceClient: () => replica
}));

const { setWorkspaceRemoteTransport } =
	await import('$lib/authoring/workspace/remote-transport.js');
const AgentChatPanel = (await import('$lib/ui/agent/agent-chat-panel.svelte')).default;

type ChatResult = { runId: string; chatId: string };

function deferred(): {
	promise: Promise<ChatResult>;
	resolve: (value: ChatResult) => void;
	reject: (error: Error) => void;
} {
	let resolve!: (value: ChatResult) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<ChatResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let inFlight = deferred();
let sent: { message: string; model?: string; planMode?: boolean }[] = [];
let catalog: {
	defaultModel: string;
	options: { id: string; label: string; canonicalSlug: string }[];
} | null = null;

beforeEach(() => {
	// A device that has synced nothing yet, per test — the query cache lives on the replica too.
	replica = new FakeReplica();
	inFlight = deferred();
	sent = [];
	catalog = null;
	setWorkspaceRemoteTransport({
		agentChatStart: (input: { message: string; model?: string; planMode?: boolean }) => {
			sent.push(input);
			return inFlight.promise;
		},
		agentModels: () => Promise.resolve(catalog)
	} as never);
});

function mountPanel(): { container: HTMLElement; destroy(): void } {
	return render(AgentChatPanel as never, {});
}

function type(container: HTMLElement, message: string): void {
	const textarea = container.querySelector('textarea');
	if (!textarea) throw new Error('composer missing');
	textarea.value = message;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function submit(container: HTMLElement): void {
	const form = container.querySelector('form');
	form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	flushSync();
}

function transcript(container: HTMLElement): { role: string; content: string }[] {
	return [...container.querySelectorAll('.message')].map((node) => ({
		role: node.getAttribute('data-role') ?? '',
		content: node.querySelector('.content')?.textContent?.trim() ?? ''
	}));
}

describe('agent chat panel', () => {
	it('shows the prompt the moment it is sent, before anything has replicated', () => {
		const { container, destroy } = mountPanel();
		type(container, 'What is on site?');
		submit(container);

		// Nothing has been awaited: the round trip runs the whole agent loop, and a prompt that
		// vanishes for those seconds reads as a dropped message.
		expect(transcript(container)).toEqual([{ role: 'user', content: 'What is on site?' }]);
		expect(sent).toEqual([{ message: 'What is on site?' }]);
		expect(container.querySelector('[data-testid="agent-send"]')?.getAttribute('aria-label')).toBe(
			'Agent is working'
		);
		destroy();
	});

	it('replaces the echo with the stored row instead of showing the prompt twice', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'What is on site?');
		submit(container);

		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();
		// The chat id has landed and the live query has fired against an empty replica. The echo is
		// still the only thing covering the gap.
		expect(transcript(container)).toEqual([{ role: 'user', content: 'What is on site?' }]);

		replica.arrive('chat_message', {
			norbital_id: 'm1',
			chat_id: 'c1',
			seq: 1,
			parts: [{ role: 'user', content: 'What is on site?' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			parts: [{ role: 'assistant', content: 'Two crews and a delivery.' }]
		});
		await settle();

		// The reply is what makes this assertion mean anything: the echo appends to the end of the
		// transcript, so a duplicate would show up here as a third, trailing copy of the prompt.
		// Two entries in this order is the echo having been replaced rather than merely hidden.
		expect(transcript(container)).toEqual([
			{ role: 'user', content: 'What is on site?' },
			{ role: 'assistant', content: 'Two crews and a delivery.' }
		]);
		destroy();
	});

	it('keeps the echo when the send fails, so the prompt is still there to copy', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Draft the RFI response');
		submit(container);

		inFlight.reject(new Error('Agent unavailable'));
		await settle();

		expect(transcript(container)).toEqual([{ role: 'user', content: 'Draft the RFI response' }]);
		expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
			'Agent unavailable'
		);
		// And the composer is usable again rather than stuck mid-send.
		expect(container.querySelector('[data-testid="agent-send"]')?.getAttribute('aria-label')).toBe(
			'Send message'
		);
		destroy();
	});

	it('leaves the working state when the root turn completes through live sync', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Check the records');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_turn', {
			norbital_id: 't1',
			chat_id: 'c1',
			parent_turn_id: null,
			subagent_id: null,
			status: 'succeeded',
			started_at: '2026-08-01T00:00:00.000Z'
		});
		await settle();

		expect(container.querySelector('textarea')?.disabled).toBe(false);
		expect(container.querySelector('[data-testid="agent-send"]')?.getAttribute('aria-label')).toBe(
			'Send message'
		);
		destroy();
	});

	it('releases the composer when the terminal failure message arrives before turn status', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Read a missing file');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_message', {
			norbital_id: 'm1',
			chat_id: 'c1',
			seq: 1,
			parts: [{ role: 'user', content: 'Read a missing file' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			parts: [{ role: 'system', content: 'Agent run failed after provider error' }]
		});
		await settle();

		expect(container.querySelector('textarea')?.disabled).toBe(false);
		expect(container.querySelector('[data-testid="agent-send"]')?.getAttribute('aria-label')).toBe(
			'Send message'
		);
		expect(container.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
			'Agent run failed after provider error'
		);
		destroy();
	});

	it('shows a message that arrived in the replica with no local action at all', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'What is on site?');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();
		replica.arrive('chat_message', {
			norbital_id: 'm1',
			chat_id: 'c1',
			seq: 1,
			parts: [{ role: 'user', content: 'What is on site?' }]
		});
		await settle();

		// This is the bug the panel was rewritten for. Nothing below touches the panel: the reply is
		// written by the loop, and a second tab's turn by a different session entirely. A panel that
		// accumulates its own transcript locally shows neither.
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			parts: [{ role: 'assistant', content: 'Two crews and a delivery.' }]
		});
		await settle();
		replica.arrive('chat_message', {
			norbital_id: 'm3',
			chat_id: 'c1',
			seq: 3,
			parts: [{ role: 'user', content: 'Sent from my phone' }]
		});
		await settle();

		expect(transcript(container)).toEqual([
			{ role: 'user', content: 'What is on site?' },
			{ role: 'assistant', content: 'Two crews and a delivery.' },
			{ role: 'user', content: 'Sent from my phone' }
		]);
		destroy();
	});

	it('reacts to every update of a streamed row, tool result, title, and turn status', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Inspect the workspace');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_session', {
			norbital_id: 'c1',
			automation_run_id: 'r1',
			title: 'Workspace agent',
			norbital_updated_at: '2026-08-12T00:00:00.000Z'
		});
		replica.arrive('chat_message', {
			norbital_id: 'm1',
			chat_id: 'c1',
			seq: 1,
			parts: [{ role: 'user', content: 'Inspect the workspace' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			status: 'streaming',
			parts: [{ role: 'assistant', content: 'I found the first part.' }]
		});
		await settle();
		expect(transcript(container).at(-1)?.content).toBe('I found the first part.');

		// The writer updates one durable assistant row at part boundaries. The replica must replace
		// that row and refire the live query; appending a duplicate would hide the bug this test owns.
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			status: 'complete',
			parts: [{ role: 'assistant', content: 'I found the first part. And the second part.' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'm3',
			chat_id: 'c1',
			seq: 3,
			parts: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'call-1', name: 'read_collection', input: { collection: 'sites' } }]
				}
			]
		});
		await settle();
		expect(transcript(container).some((message) => message.content.includes('second part'))).toBe(
			true
		);
		expect(container.querySelector('[data-tool="read_collection"]')).not.toBeNull();

		replica.arrive('chat_message', {
			norbital_id: 'm4',
			chat_id: 'c1',
			seq: 4,
			parts: [{ role: 'tool', toolCallId: 'call-1', content: '{"rows":[{"name":"Depot"}]}' }]
		});
		replica.arrive('chat_session', {
			norbital_id: 'c1',
			automation_run_id: 'r1',
			title: 'Workspace Site Inspection',
			norbital_updated_at: '2026-08-12T00:00:01.000Z'
		});
		replica.arrive('chat_turn', {
			norbital_id: 't1',
			chat_id: 'c1',
			parent_turn_id: null,
			subagent_id: null,
			status: 'running',
			started_at: '2026-08-12T00:00:00.000Z'
		});
		await settle();
		expect(container.querySelector('[data-tool="read_collection"]')?.textContent).toContain(
			'Depot'
		);
		expect(container.querySelector('[aria-label="Conversation thread"]')?.textContent).toContain(
			'Workspace Site Inspection'
		);

		replica.arrive('chat_turn', {
			norbital_id: 't1',
			chat_id: 'c1',
			parent_turn_id: null,
			subagent_id: null,
			status: 'succeeded',
			started_at: '2026-08-12T00:00:00.000Z'
		});
		await settle();
		expect(container.querySelector('textarea')?.disabled).toBe(false);
		expect(container.querySelector('[data-testid="agent-send"]')?.getAttribute('aria-label')).toBe(
			'Send message'
		);
		destroy();
	});

	it('leaves another chat out of this panel', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'What is on site?');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_message', {
			norbital_id: 'mine',
			chat_id: 'c1',
			seq: 1,
			parts: [{ role: 'user', content: 'What is on site?' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'other',
			chat_id: 'c2',
			seq: 2,
			parts: [{ role: 'assistant', content: 'Belongs to another conversation.' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'also-mine',
			chat_id: 'c1',
			seq: 3,
			parts: [{ role: 'assistant', content: 'Belongs to this one.' }]
		});
		await settle();

		// Both rows are in the replica and both fired the same invalidation. Only one is this chat's,
		// so asserting the other is absent is only worth something next to the one that is present.
		expect(transcript(container).map((message) => message.content)).toEqual([
			'What is on site?',
			'Belongs to this one.'
		]);
		destroy();
	});

	it('renders every tool call in a turn as its own row, with its result', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Compare the two collections');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		// One assistant row carrying two calls to the same tool. The regression rendered this as a
		// single bubble reading "Using read_collection, read_collection…".
		replica.arrive('chat_message', {
			norbital_id: 'm1',
			chat_id: 'c1',
			seq: 1,
			parts: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [
						{ id: 'a', name: 'read_collection', input: { collection: 'accounts' } },
						{ id: 'b', name: 'read_collection', input: { collection: 'payments' } }
					]
				}
			]
		});
		replica.arrive('chat_message', {
			norbital_id: 'm2',
			chat_id: 'c1',
			seq: 2,
			parts: [{ role: 'tool', content: '{"rows":[{"name":"Depot"}]}', toolCallId: 'a' }]
		});
		await settle();

		const rows = [...container.querySelectorAll('[data-role="tool"]')];
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.getAttribute('data-tool'))).toEqual([
			'read_collection',
			'read_collection'
		]);
		// The two rows are distinguishable by the argument that made them different.
		const summaries = rows.map((row) => row.querySelector('summary')?.textContent ?? '');
		expect(summaries[0]).toContain('accounts');
		expect(summaries[1]).toContain('payments');
		// The answered call carries its result; the unanswered one is still waiting.
		expect(rows[0]?.textContent).toContain('Depot');
		expect(rows[1]?.textContent).toContain('Waiting for the result');
		// Collapsed by default: tool output is tenant data, not conversation.
		expect(rows[0]?.querySelector('details')?.open).toBe(false);
		destroy();
	});

	it('renders a subagent inside its call, recursively and without a composer', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Audit the sites');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_turn', {
			norbital_id: 'child-turn',
			chat_id: 'c1',
			parent_turn_id: 'parent-turn',
			subagent_id: 'subagent:call-9',
			status: 'running',
			started_at: '2026-08-03T00:00:00.000Z'
		});
		replica.arrive('chat_message', {
			norbital_id: 'p1',
			chat_id: 'c1',
			turn_id: 'parent-turn',
			seq: 1,
			parts: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'call-9', name: 'spawn_subagent', input: { task: 'Audit sites' } }]
				}
			]
		});
		replica.arrive('chat_message', {
			norbital_id: 'c2',
			chat_id: 'c1',
			turn_id: 'child-turn',
			seq: 2,
			parts: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'call-10', name: 'read_collection', input: { collection: 'sites' } }]
				}
			]
		});
		await settle();

		const toolRows = [...container.querySelectorAll('[data-role="tool"]')];
		// Two rows, but not siblings: the child's read is *inside* the spawn call, not beside it.
		expect(toolRows.map((row) => row.getAttribute('data-tool'))).toEqual([
			'spawn_subagent',
			'read_collection'
		]);
		const spawnRow = container.querySelector('[data-tool="spawn_subagent"]');
		expect(spawnRow?.querySelector('[data-tool="read_collection"]')).not.toBeNull();
		expect(spawnRow?.querySelector('[aria-label="Subagent transcript"]')).not.toBeNull();
		// A subagent is given a task, not talked to — exactly one composer, at the top level.
		expect(container.querySelectorAll('textarea')).toHaveLength(1);
		expect(spawnRow?.querySelector('textarea')).toBeNull();
		destroy();
	});

	it("calls a delegated prompt a Task and the reader's own history theirs", async () => {
		// Both are nested rows carrying `role: 'user'`, and they mean opposite things: one is the task
		// the parent handed down, the other really was the person typing.
		const { container, destroy } = mountPanel();
		type(container, 'Audit the sites');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		replica.arrive('chat_turn', {
			norbital_id: 'child-turn',
			chat_id: 'c1',
			parent_turn_id: 'parent-turn',
			subagent_id: 'subagent:call-9',
			status: 'running',
			started_at: '2026-08-03T00:00:00.000Z'
		});
		replica.arrive('chat_message', {
			norbital_id: 'old',
			chat_id: 'c1',
			turn_id: 'parent-turn',
			seq: 1,
			parts: [{ role: 'user', content: 'The original question' }]
		});
		replica.arrive('chat_message', {
			norbital_id: 'ck',
			chat_id: 'c1',
			turn_id: 'parent-turn',
			seq: 2,
			kind: 'summary',
			parts: [
				{
					role: 'system',
					content: '## What changed\n\n- Kept the site identifiers\n- Preserved unresolved work'
				}
			]
		});
		replica.arrive('chat_message', {
			norbital_id: 'p1',
			chat_id: 'c1',
			turn_id: 'parent-turn',
			seq: 3,
			parts: [
				{
					role: 'assistant',
					content: '',
					toolCalls: [{ id: 'call-9', name: 'spawn_subagent', input: { task: 'Audit sites' } }]
				}
			]
		});
		replica.arrive('chat_message', {
			norbital_id: 'c1m',
			chat_id: 'c1',
			turn_id: 'child-turn',
			seq: 4,
			parts: [{ role: 'user', content: 'Audit sites' }]
		});
		await settle();

		const delegated = container.querySelector('[aria-label="Subagent transcript"] li span');
		expect(delegated?.textContent?.trim()).toBe('Task');
		// The model writes Markdown summaries; the checkpoint must render its structure, not raw syntax.
		expect(container.querySelector('[data-role="checkpoint"] h2')?.textContent).toBe(
			'What changed'
		);
		expect(
			container.querySelectorAll('[data-role="checkpoint"] [role="tabpanel"] ul li')
		).toHaveLength(2);

		// The raw conversation is the checkpoint's second tab, so it has to be asked for.
		const rawTab = [...container.querySelectorAll('[role="tab"]')].find(
			(tab) => tab.textContent?.trim() === 'Full conversation'
		);
		expect(rawTab).toBeDefined();
		rawTab?.dispatchEvent(new Event('click', { bubbles: true }));
		flushSync();

		const history = container.querySelector(
			'[aria-label="Conversation before compaction"] li span'
		);
		// The checkpoint's raw tab holds the person's own message; calling it a Task would be a lie
		// about who said it.
		expect(history?.textContent?.trim()).toBe('You');
		destroy();
	});

	it('opens on the host default and sends only a model the person changed', async () => {
		catalog = {
			defaultModel: 'deepseek/deepseek-v4-flash-0731',
			options: [
				{
					id: 'deepseek/deepseek-v4-flash-0731',
					label: 'DeepSeek V4 Flash 0731',
					canonicalSlug: 'deepseek/deepseek-v4-flash-20260731'
				},
				{
					id: 'anthropic/claude-sonnet-5',
					label: 'Claude Sonnet 5',
					canonicalSlug: 'anthropic/claude-sonnet-5-20260630'
				}
			]
		};
		const { container, destroy } = mountPanel();
		await settle();

		expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain(
			'DeepSeek V4 Flash 0731'
		);

		type(container, 'Summarize the site log');
		submit(container);
		// Untouched, so the host stays free to change what its default resolves to.
		expect(sent).toEqual([{ message: 'Summarize the site log' }]);
		destroy();
	});

	it('shows no picker at all on a host that offers no choice', async () => {
		const { container, destroy } = mountPanel();
		await settle();
		// Absent rather than empty: an empty combobox reads as a broken control.
		expect(container.querySelector('[aria-label="Model"]')).toBeNull();
		destroy();
	});

	it('forwards plan mode only when the Plan toggle is pressed', async () => {
		const { container, destroy } = mountPanel();
		await settle();

		const plan = container.querySelector('[data-testid="agent-plan-mode"]');
		expect(plan).not.toBeNull();
		expect(plan?.getAttribute('aria-pressed')).toBe('false');

		type(container, 'How should payroll runs be structured?');
		submit(container);
		expect(sent).toEqual([{ message: 'How should payroll runs be structured?' }]);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();
		replica.arrive('chat_turn', {
			norbital_id: 't1',
			chat_id: 'c1',
			parent_turn_id: null,
			subagent_id: null,
			status: 'succeeded',
			started_at: '2026-08-01T00:00:00.000Z'
		});
		await settle();

		plan?.dispatchEvent(new Event('click', { bubbles: true }));
		flushSync();
		expect(plan?.getAttribute('aria-pressed')).toBe('true');

		inFlight = deferred();
		type(container, 'Draft a rollout plan');
		submit(container);
		expect(sent.at(-1)).toEqual({
			message: 'Draft a rollout plan',
			planMode: true,
			runId: 'r1'
		});
		destroy();
	});

	it('opens the most recent replicated conversation in the thread selector', async () => {
		replica.seed('chat_session', [
			{
				norbital_id: 'c1',
				automation_run_id: 'r1',
				title: 'Check the payroll run',
				norbital_updated_at: '2026-08-02T10:00:00.000Z'
			}
		]);
		replica.seed('chat_message', [
			{
				norbital_id: 'm1',
				chat_id: 'c1',
				seq: 1,
				parts: [{ role: 'assistant', content: 'The payroll run is ready.' }]
			}
		]);

		const { container, destroy } = mountPanel();
		await settle();

		expect(container.querySelector('[aria-label="Conversation thread"]')?.textContent).toContain(
			'Check the payroll run'
		);
		expect(transcript(container)).toEqual([
			{ role: 'assistant', content: 'The payroll run is ready.' }
		]);
		destroy();
	});
});
