import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';

let replica = new FakeReplica();

vi.mock('$lib/ui/state/client.js', () => ({
	getInitializedWorkspaceClient: () => replica
}));

const { setWorkspaceRemoteTransport } =
	await import('$lib/authoring/workspace/remote-transport.js');
const AgentChatPanel = (await import('$lib/ui/agent/agent-chat-panel.svelte')).default;

type ChatResult = { runId: string; chatId: string };
type EmbeddedMessage = Record<string, unknown> & {
	readonly norbital_id: string;
	readonly turn_id: string | null;
	readonly seq: number;
	readonly role: string;
	readonly parts: readonly Record<string, unknown>[];
};
type EmbeddedTurn = Record<string, unknown> & {
	readonly norbital_id: string;
	readonly parent_turn_id: string | null;
	readonly subagent_id: string | null;
	readonly status: string;
};

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
	options: { id: string; label: string; canonicalSlug: string; contextLength?: number }[];
} | null = null;

beforeEach(() => {
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

function type(container: HTMLElement, value: string): void {
	const textarea = container.querySelector('textarea');
	if (!textarea) throw new Error('composer missing');
	textarea.value = value;
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function submit(container: HTMLElement): void {
	container
		.querySelector('form')
		?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	flushSync();
}

function transcript(container: HTMLElement): { role: string; content: string }[] {
	return [...container.querySelectorAll('.message')].map((node) => ({
		role: node.getAttribute('data-role') ?? '',
		content: node.querySelector('.content')?.textContent?.trim() ?? ''
	}));
}

function message(input: {
	id: string;
	seq: number;
	role: string;
	content?: string;
	turnId?: string;
	status?: string;
	toolCalls?: readonly Record<string, unknown>[];
	toolCallId?: string;
	kind?: string;
}): EmbeddedMessage {
	return {
		norbital_id: input.id,
		turn_id: input.turnId ?? 'root',
		seq: input.seq,
		role: input.role,
		status: input.status ?? 'complete',
		kind: input.kind ?? 'normal',
		parts: [
			{
				role: input.role,
				content: input.content ?? '',
				...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
				...(input.toolCallId ? { toolCallId: input.toolCallId } : {})
			}
		]
	};
}

function turn(input: {
	id?: string;
	status: string;
	parentId?: string;
	subagentId?: string;
	error?: string;
}): EmbeddedTurn {
	return {
		norbital_id: input.id ?? 'root',
		parent_turn_id: input.parentId ?? null,
		subagent_id: input.subagentId ?? null,
		status: input.status,
		error: input.error ?? null,
		started_at: '2026-08-12T00:00:00.000Z'
	};
}

function arriveSession(input: {
	id?: string;
	title?: string;
	runId?: string;
	messages?: readonly EmbeddedMessage[];
	turns?: readonly EmbeddedTurn[];
	updatedAt?: string;
}): void {
	replica.arrive('chat_session', {
		norbital_id: input.id ?? 'c1',
		automation_run_id: input.runId ?? 'r1',
		title: input.title ?? 'Workspace agent',
		messages: input.messages ?? [],
		turns: input.turns ?? [],
		norbital_updated_at: input.updatedAt ?? '2026-08-12T00:00:00.000Z'
	});
}

describe('agent chat panel', () => {
	it('shows the prompt immediately, then replaces it from one replicated session aggregate', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'What is on site?');
		submit(container);
		expect(transcript(container)).toEqual([{ role: 'user', content: 'What is on site?' }]);
		expect(sent).toEqual([{ message: 'What is on site?' }]);

		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();
		arriveSession({
			messages: [
				message({ id: 'm1', seq: 1, role: 'user', content: 'What is on site?' }),
				message({ id: 'm2', seq: 2, role: 'assistant', content: 'Two crews.' })
			]
		});
		await settle();
		expect(transcript(container)).toEqual([
			{ role: 'user', content: 'What is on site?' },
			{ role: 'assistant', content: 'Two crews.' }
		]);
		destroy();
	});

	it('reacts to every part, generated title, tool result, and terminal turn on chat_session alone', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Inspect the workspace');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();

		const prompt = message({ id: 'm1', seq: 1, role: 'user', content: 'Inspect the workspace' });
		arriveSession({
			messages: [
				prompt,
				message({
					id: 'm2',
					seq: 2,
					role: 'assistant',
					content: 'I found the first part.',
					status: 'streaming'
				})
			],
			turns: [turn({ status: 'running' })]
		});
		await settle();
		expect(transcript(container).at(-1)?.content).toBe('I found the first part.');

		const call = message({
			id: 'm3',
			seq: 3,
			role: 'assistant',
			toolCalls: [{ id: 'call-1', name: 'read_collection', input: { collection: 'sites' } }]
		});
		arriveSession({
			title: 'Workspace Site Inspection',
			updatedAt: '2026-08-12T00:00:01.000Z',
			messages: [
				prompt,
				message({
					id: 'm2',
					seq: 2,
					role: 'assistant',
					content: 'I found the first part. And the second part.'
				}),
				call,
				message({
					id: 'm4',
					seq: 4,
					role: 'tool',
					content: '{"rows":[{"name":"Depot"}]}',
					toolCallId: 'call-1'
				})
			],
			turns: [turn({ status: 'succeeded' })]
		});
		await settle();
		expect(transcript(container).some((entry) => entry.content.includes('second part'))).toBe(true);
		expect(container.querySelector('[data-tool="read_collection"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Conversation thread"]')?.textContent).toContain(
			'Workspace Site Inspection'
		);
		expect(container.querySelector('textarea')?.disabled).toBe(false);
		destroy();
	});

	it('shows a durable terminal error and releases the composer', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Read a missing file');
		submit(container);
		inFlight.resolve({ runId: 'r1', chatId: 'c1' });
		await settle();
		arriveSession({
			messages: [
				message({ id: 'm1', seq: 1, role: 'user', content: 'Read a missing file' }),
				message({
					id: 'm2',
					seq: 2,
					role: 'system',
					content: 'Agent run failed after provider error'
				})
			],
			turns: [turn({ status: 'failed', error: 'Agent run failed after provider error' })]
		});
		await settle();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			'Agent run failed after provider error'
		);
		expect(container.querySelector('textarea')?.disabled).toBe(false);
		destroy();
	});

	it('keeps delegated messages nested under the spawning tool', async () => {
		const { container, destroy } = mountPanel();
		arriveSession({
			messages: [
				message({
					id: 'p1',
					seq: 1,
					role: 'assistant',
					turnId: 'root',
					toolCalls: [{ id: 'call-9', name: 'spawn_subagent', input: { task: 'Audit sites' } }]
				}),
				message({
					id: 'c1m',
					seq: 2,
					role: 'assistant',
					turnId: 'child',
					content: 'The delegated audit is complete.'
				})
			],
			turns: [
				turn({ status: 'succeeded' }),
				turn({
					id: 'child',
					status: 'succeeded',
					parentId: 'root',
					subagentId: 'subagent:call-9'
				})
			]
		});
		await settle();
		expect(container.querySelector('[data-tool="spawn_subagent"]')?.textContent).toContain(
			'The delegated audit is complete.'
		);
		destroy();
	});

	it('keeps a failed send visible and makes the composer usable again', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Draft the RFI response');
		submit(container);
		inFlight.reject(new Error('Agent unavailable'));
		await settle();
		expect(transcript(container)).toEqual([{ role: 'user', content: 'Draft the RFI response' }]);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain('Agent unavailable');
		expect(container.querySelector('textarea')?.disabled).toBe(false);
		destroy();
	});

	it('uses the host default model and carries plan mode explicitly', async () => {
		catalog = {
			defaultModel: 'provider/default',
			options: [
				{
					id: 'provider/default',
					label: 'Default',
					canonicalSlug: 'provider/default',
					contextLength: 1_000_000
				}
			]
		};
		const { container, destroy } = mountPanel();
		await settle();
		container.querySelector<HTMLButtonElement>('[aria-pressed="false"]')?.click();
		type(container, 'Outline the migration');
		submit(container);
		// The host default is intentionally omitted on the wire; the catalog still supplies its context
		// length for occupancy/compaction, while the host remains the one source of truth for selection.
		expect(sent).toEqual([{ message: 'Outline the migration', planMode: true }]);
		destroy();
	});

	it('opens the most recent replicated conversation in the selector', async () => {
		replica.seed('chat_session', [
			{
				norbital_id: 'c1',
				automation_run_id: 'r1',
				title: 'Check the payroll run',
				messages: [message({ id: 'm1', seq: 1, role: 'assistant', content: 'Ready.' })],
				turns: [],
				norbital_updated_at: '2026-08-12T10:00:00.000Z'
			}
		]);
		const { container, destroy } = mountPanel();
		await settle();
		expect(container.querySelector('[aria-label="Conversation thread"]')?.textContent).toContain(
			'Check the payroll run'
		);
		expect(transcript(container)).toContainEqual({ role: 'assistant', content: 'Ready.' });
		destroy();
	});
});
