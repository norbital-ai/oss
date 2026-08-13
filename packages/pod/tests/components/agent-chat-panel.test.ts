import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';
import { DEFAULT_VERIFIER_PROMPTS } from '$lib/shared/agent/intent.js';

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
let sent: {
	message: string;
	model?: string;
	planMode?: boolean;
	goalMode?: boolean;
	intent?: 'do' | 'plan';
	verifierPrompt?: string;
}[] = [];
type ModelCatalog = {
	defaultModel: string;
	options: { id: string; label: string; canonicalSlug: string; contextLength?: number }[];
};
let catalog: ModelCatalog | null = null;
let modelsPromise: Promise<ModelCatalog | null> = Promise.resolve(null);

beforeEach(() => {
	replica = new FakeReplica();
	inFlight = deferred();
	sent = [];
	catalog = null;
	modelsPromise = Promise.resolve(catalog);
	setWorkspaceRemoteTransport({
		agentChatStart: (input: {
			message: string;
			model?: string;
			planMode?: boolean;
			goalMode?: boolean;
			intent?: 'do' | 'plan';
			verifierPrompt?: string;
		}) => {
			sent.push(input);
			return inFlight.promise;
		},
		agentModels: () => modelsPromise
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
		expect(sent).toEqual([{ message: 'What is on site?', intent: 'do' }]);

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

	it('renders captured reasoning separately in a collapsed markdown disclosure', async () => {
		const { container, destroy } = mountPanel();
		arriveSession({
			messages: [
				message({
					id: 'reason-1',
					seq: 1,
					role: 'assistant',
					kind: 'reasoning',
					content: '**Check** the available skills.'
				}),
				message({
					id: 'answer-1',
					seq: 2,
					role: 'assistant',
					content: 'Two skills are available.'
				})
			]
		});
		await settle();
		const reasoning = container.querySelector('[data-role="reasoning"]');
		expect(reasoning?.querySelector('details')?.open).toBe(false);
		expect(reasoning?.querySelector('summary')?.textContent).toContain('Reasoning');
		expect(reasoning?.querySelector('strong')?.textContent).toBe('Check');
		expect(transcript(container).at(-1)).toEqual({
			role: 'assistant',
			content: 'Two skills are available.'
		});
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

	it('maps a generic internal start error and keeps an authored server message', async () => {
		const generic = mountPanel();
		type(generic.container, 'Start this');
		submit(generic.container);
		inFlight.reject(new Error('INTERNAL_ERROR'));
		await settle();
		expect(generic.container.querySelector('[role="alert"]')?.textContent).toContain(
			'The conversation could not be started'
		);
		generic.destroy();

		inFlight = deferred();
		const authored = mountPanel();
		type(authored.container, 'Start this');
		submit(authored.container);
		inFlight.reject(new Error('Another record already uses this title.'));
		await settle();
		expect(authored.container.querySelector('[role="alert"]')?.textContent).toContain(
			'Another record already uses this title.'
		);
		authored.destroy();
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
				},
				{
					id: 'provider/default:fast',
					label: 'Default Fast',
					canonicalSlug: 'provider/default',
					contextLength: 1_000_000
				}
			]
		};
		modelsPromise = Promise.resolve(catalog);
		const { container, destroy } = mountPanel();
		await settle();
		expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('Default');
		expect(container.querySelector('[aria-label="Model variant"]')).not.toBeNull();
		container.querySelector<HTMLButtonElement>('[data-testid="agent-plan-mode"]')?.click();
		type(container, 'Outline the migration');
		submit(container);
		// The host default is intentionally omitted on the wire; the catalog still supplies its context
		// length for occupancy/compaction, while the host remains the one source of truth for selection.
		expect(sent).toEqual([
			{
				message: 'Outline the migration',
				planMode: true,
				intent: 'plan',
				verifierPrompt: DEFAULT_VERIFIER_PROMPTS.plan
			}
		]);
		destroy();
	});

	it('omits the verifier for chitchat', async () => {
		const { container, destroy } = mountPanel();
		type(container, "hello how's the weather today");
		expect(container.querySelector('[data-testid="agent-verifier"]')).toBeNull();
		submit(container);
		expect(sent.at(-1)).toEqual({
			message: "hello how's the weather today",
			intent: 'do'
		});
		expect(sent.at(-1)).not.toHaveProperty('verifierPrompt');
		destroy();
	});

	it('shows the verifier and sends verifierPrompt for a task', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Create the site');
		expect(container.querySelector('[data-testid="agent-verifier"]')).not.toBeNull();
		submit(container);
		expect(sent.at(-1)).toEqual({
			message: 'Create the site',
			intent: 'do',
			verifierPrompt: DEFAULT_VERIFIER_PROMPTS.do
		});
		destroy();
	});

	it('sends an edited verifier prompt as the override', async () => {
		const { container, destroy } = mountPanel();
		type(container, 'Create the site');
		const verifier = container.querySelector<HTMLTextAreaElement>(
			'[data-testid="agent-verifier-prompt"]'
		);
		if (!verifier) throw new Error('verifier prompt missing');
		verifier.value = 'Was the site record actually written?';
		verifier.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		submit(container);
		expect(sent).toEqual([
			{
				message: 'Create the site',
				intent: 'do',
				verifierPrompt: 'Was the site record actually written?'
			}
		]);
		destroy();
	});

	it('keeps the model selector present while its shared catalog is loading or unavailable', async () => {
		modelsPromise = new Promise(() => undefined);
		const loading = mountPanel();
		const loadingPicker =
			loading.container.querySelector<HTMLButtonElement>('[aria-label="Model"]');
		expect(loadingPicker?.textContent).toContain('Loading');
		expect(loadingPicker?.disabled).toBe(true);
		const chevron = loadingPicker?.parentElement?.querySelector('span[aria-hidden="true"]');
		expect(chevron?.className).toContain('opacity-0');
		expect(chevron?.className).toContain('group-focus-within:border-ring');
		expect(chevron?.className).toContain('group-focus-within:outline-ring');
		expect(chevron?.className).toContain('group-hover:outline-ring');
		expect(chevron?.className).toContain('[@media(hover:none)]:opacity-60');
		loading.destroy();

		// A new transport represents the next workspace and lets the shared state make a fresh request.
		modelsPromise = Promise.reject(new Error('catalog unavailable'));
		setWorkspaceRemoteTransport({
			agentChatStart: () => inFlight.promise,
			agentModels: () => modelsPromise
		} as never);
		const unavailable = mountPanel();
		await settle();
		const unavailablePicker =
			unavailable.container.querySelector<HTMLButtonElement>('[aria-label="Model"]');
		expect(unavailablePicker?.textContent).toContain('Not available');
		expect(unavailablePicker?.disabled).toBe(true);
		unavailable.destroy();
	});

	it('shares the last valid model selection between panels and sends with it', async () => {
		catalog = {
			defaultModel: 'provider/default',
			options: [
				{ id: 'provider/default', label: 'Default', canonicalSlug: 'provider/default' },
				{ id: 'provider/other', label: 'Other', canonicalSlug: 'provider/other' }
			]
		};
		modelsPromise = Promise.resolve(catalog);
		const first = mountPanel();
		await settle();
		first.container.querySelector<HTMLButtonElement>('[aria-label="Model"]')?.click();
		await settle();
		const other = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [data-value]')].find(
			(option) => option.textContent?.trim() === 'Other'
		);
		expect(other).toBeDefined();
		other?.click();
		await settle();

		const second = mountPanel();
		await settle();
		expect(second.container.querySelector('[aria-label="Model"]')?.textContent).toContain('Other');
		type(second.container, 'Use the selected model');
		submit(second.container);
		expect(sent.at(-1)).toMatchObject({
			message: 'Use the selected model',
			model: 'provider/other'
		});
		first.destroy();
		second.destroy();
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
