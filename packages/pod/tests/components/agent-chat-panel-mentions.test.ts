import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { FakeReplica } from '../support/fake-replica.svelte.js';
import { render, settle } from '../support/component.js';
import AgentMentionHarness from '../support/agent-mention-harness.svelte';
import { DEFAULT_VERIFIER_PROMPTS } from '$lib/shared/agent/intent.js';

/**
 * The "@" flow through the panel: trigger, search, choose, chip, send.
 *
 * The pure logic (ranges, atomic deletes, serialization) is pinned in
 * `tests/agents/composer-mentions.test.ts`; this file proves the wiring a keyboard user actually
 * meets, including the fallback: an `@` that matches nothing goes to the agent as the literal
 * prose it is.
 */

const searchState = vi.hoisted(() => ({
	rows: {} as Record<string, Record<string, unknown>[]>
}));

let replica = new FakeReplica();

vi.mock('$lib/ui/state/client.js', () => ({
	getInitializedWorkspaceClient: () => replica,
	post: (path: string, body: { collection?: string; search?: string; limit?: number }) => {
		if (path !== 'collections/findMany') return Promise.reject(new Error(`unexpected ${path}`));
		const search = (body.search ?? '').toLowerCase();
		const rows = (searchState.rows[body.collection ?? ''] ?? []).filter((row) =>
			JSON.stringify(row).toLowerCase().includes(search)
		);
		return Promise.resolve({ rows: rows.slice(0, body.limit ?? 4), nextCursor: null });
	}
}));

// The local replica stays off in this file; the `post` mock above is the seam under test.
vi.mock('$lib/ui/sync/replica.js', () => ({
	clientSyncReady: () => Promise.resolve(null)
}));
vi.mock('$lib/ui/sync/client-sync.js', () => ({
	localFindMany: () => Promise.resolve(null)
}));

const { setWorkspaceRemoteTransport } =
	await import('$lib/authoring/workspace/remote-transport.js');
const AgentChatPanel = (await import('$lib/ui/agent/agent-chat-panel.svelte')).default;

type SentInput = {
	message: string;
	mentions?: { collection: string; recordId: string; label: string }[];
	runId?: string;
	planMode?: boolean;
	goalMode?: boolean;
	intent?: 'do' | 'plan';
	verifierPrompt?: string;
};

let sent: SentInput[] = [];

const manifestContext = {
	getCollections: () => [
		{ collection_name: 'companies', system: null, fields: textField('name') },
		{ collection_name: 'contacts', system: null, fields: textField('name') },
		{ collection_name: 'user', system: true, fields: textField('name') },
		{ collection_name: 'team', system: true, fields: textField('name') },
		// Platform plumbing must never surface as something a person can reference.
		{ collection_name: 'chat_session', system: true, fields: textField('name') }
	],
	getApps: () => [
		{ name: 'payroll', label: 'Payroll', description: 'Run payroll', icon: 'lucide:wallet' }
	],
	findCollection: (name: string) => ({
		collection_name: name,
		record_label: null,
		fields: textField('name')
	}),
	columnsFor: () => ({ name: { dataType: 'text', notNull: false } })
};

/** A searchable (indexed) field, the way the compiled manifest carries one after opt-in. */
function textField(name: string) {
	return [{ name, kind: 'text', nullable: false, search: true }];
}

beforeEach(() => {
	replica = new FakeReplica();
	sent = [];
	searchState.rows = {
		companies: [
			{ norbital_id: '0197f2a4-0000-7000-8000-000000000001', name: 'Acme Corp' },
			{ norbital_id: '0197f2a4-0000-7000-8000-000000000002', name: 'Acme Logistics' }
		],
		contacts: [{ norbital_id: '0197f2a4-0000-7000-8000-000000000003', name: 'Acmed Rasheed' }],
		user: [{ norbital_id: '0197f2a4-0000-7000-8000-000000000004', name: 'Ada Lovelace' }],
		team: [{ norbital_id: '0197f2a4-0000-7000-8000-000000000005', name: 'Finance' }]
	};
	setWorkspaceRemoteTransport({
		agentChatStart: (input: SentInput) => {
			sent.push(input);
			return Promise.resolve({ runId: 'r1', chatId: 'c1', accepted: true });
		},
		agentModels: () => Promise.resolve(null)
	} as never);
});

function mountPanel(): { container: HTMLElement; destroy(): void } {
	return render(AgentMentionHarness as never, {
		component: AgentChatPanel as never,
		props: {},
		manifestContext
	});
}

function textareaOf(container: HTMLElement): HTMLTextAreaElement {
	const textarea = container.querySelector('textarea');
	if (!textarea) throw new Error('composer missing');
	return textarea;
}

/** Type by replacing the value the way the browser would report it, caret included. */
function setValue(
	container: HTMLElement,
	value: string,
	caret = value.length
): HTMLTextAreaElement {
	const textarea = textareaOf(container);
	textarea.value = value;
	textarea.setSelectionRange(caret, caret);
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	return textarea;
}

function key(textarea: HTMLTextAreaElement, name: string): void {
	textarea.dispatchEvent(
		new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })
	);
	textarea.dispatchEvent(
		new KeyboardEvent('keyup', { key: name, bubbles: true, cancelable: true })
	);
	flushSync();
}

/** Outwait the composer's 150ms search debounce, then drain the scheduled work. */
async function searchRound(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 180));
	await settle();
}

function submit(container: HTMLElement): void {
	const form = container.querySelector('form');
	form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	flushSync();
}

function menuOptions(container: HTMLElement): string[] {
	return [...container.querySelectorAll('#agent-mention-menu [role="option"]')].map(
		(node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
	);
}

describe('the "@" keyboard flow', () => {
	it('opens on a bare "@" offering prefix commands, collection scopes, and never the platform plumbing', async () => {
		const { container, destroy } = mountPanel();
		setValue(container, '@', 1);

		expect(container.querySelector('#agent-mention-menu')).not.toBeNull();
		const options = menuOptions(container);
		expect(options.some((option) => option.includes('Search records'))).toBe(true);
		expect(options.some((option) => option.includes('Plan this turn'))).toBe(true);
		expect(options.some((option) => option.includes('Mention an app'))).toBe(true);
		expect(options.some((option) => option.startsWith('Search companies'))).toBe(true);
		expect(options.some((option) => option.startsWith('Search user'))).toBe(true);
		expect(options.some((option) => option.startsWith('Search team'))).toBe(true);
		expect(options.some((option) => option.includes('chat_session'))).toBe(false);
		destroy();
	});

	it('lists collection scopes after # and keeps the highlight across keyup', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@#c', 3);

		const options = menuOptions(container);
		expect(options.some((option) => option.startsWith('Search companies'))).toBe(true);
		expect(options.some((option) => option.startsWith('Search contacts'))).toBe(true);
		expect(options.some((option) => option.includes('chat_session'))).toBe(false);

		key(textarea, 'ArrowDown');
		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('@#contacts ');
		destroy();
	});

	it('turns @! into plan mode and leaves the rest of the request', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@!rewrite leave', 15);
		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('rewrite leave');
		expect(container.querySelector('[data-testid="agent-plan-mode"]')?.className).toContain(
			'bg-primary'
		);
		destroy();
	});

	it('searches as the writer types, and Enter turns the hit into a chip the send carries', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@acm');
		await searchRound();

		const options = menuOptions(container);
		expect(options.some((option) => option.includes('Acme Corp'))).toBe(true);
		expect(options.some((option) => option.includes('Acmed Rasheed'))).toBe(true);

		key(textarea, 'Enter');
		await settle();
		// The query was the search, not the message: the chip replaced it.
		expect(textarea.value).toBe('@Acme Corp');
		expect(container.querySelector('#agent-mention-menu')).toBeNull();

		submit(container);
		expect(sent).toEqual([
			{
				message: '@Acme Corp',
				mentions: [
					{
						collection: 'companies',
						recordId: '0197f2a4-0000-7000-8000-000000000001',
						label: 'Acme Corp'
					}
				],
				intent: 'do',
				verifierPrompt: DEFAULT_VERIFIER_PROMPTS.do
			}
		]);
		destroy();
	});

	it('navigates with the arrows and picks the highlighted row', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@acm');
		await searchRound();

		key(textarea, 'ArrowDown');
		key(textarea, 'Enter');
		await settle();
		// The second hit across all sources — arrow navigation crossed the group boundary.
		expect(textarea.value).toBe('@Acme Logistics');
		destroy();
	});

	it('sends an unmatched "@" as literal text with no mentions, and says why', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@zzz');
		await searchRound();

		expect(container.querySelector('[data-testid="agent-mention-empty"]')?.textContent).toContain(
			'sent as plain text'
		);

		key(textarea, 'Enter');
		await settle();
		expect(sent).toEqual([{ message: '@zzz', intent: 'do' }]);
		destroy();
	});

	it('esc dismisses the menu and leaves the text for the writer to keep', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@acm');
		await searchRound();
		expect(container.querySelector('#agent-mention-menu')).not.toBeNull();

		key(textarea, 'Escape');
		expect(container.querySelector('#agent-mention-menu')).toBeNull();
		expect(textarea.value).toBe('@acm');

		// Typing on does not reopen a dismissed trigger; a fresh "@" elsewhere does.
		key(textarea, 'ArrowLeft');
		setValue(container, '@acme', 5);
		await searchRound();
		expect(container.querySelector('#agent-mention-menu')).toBeNull();
		destroy();
	});

	it('backspace at a chip removes it whole', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@acm');
		await searchRound();
		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('@Acme Corp');

		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		key(textarea, 'Backspace');
		await settle();
		expect(textarea.value).toBe('');

		// And the chip that vanished takes its reference with it.
		submit(container);
		expect(sent).toEqual([]);
		destroy();
	});

	it('inserts collection:<name> when the writer picks a collection', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@compani');
		await searchRound();

		const options = menuOptions(container);
		expect(options.some((option) => option.includes('companies'))).toBe(true);

		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('collection:companies');
		destroy();
	});

	it('inserts app:<key> when the writer picks an app', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@pay');
		await searchRound();

		const options = menuOptions(container);
		expect(options.some((option) => option.includes('Payroll'))).toBe(true);

		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('app:payroll');
		expect(container.querySelector('#agent-mention-menu')).toBeNull();

		submit(container);
		expect(sent).toEqual([
			{
				message: 'app:payroll',
				intent: 'do'
			}
		]);
		destroy();
	});

	it('mentions a person from the user collection', async () => {
		const { container, destroy } = mountPanel();
		const textarea = setValue(container, '@Ada');
		await searchRound();

		const options = menuOptions(container);
		expect(options.some((option) => option.includes('Ada Lovelace'))).toBe(true);

		key(textarea, 'Enter');
		await settle();
		expect(textarea.value).toBe('@Ada Lovelace');

		submit(container);
		expect(sent).toEqual([
			{
				message: '@Ada Lovelace',
				mentions: [
					{
						collection: 'user',
						recordId: '0197f2a4-0000-7000-8000-000000000004',
						label: 'Ada Lovelace'
					}
				],
				intent: 'do',
				verifierPrompt: DEFAULT_VERIFIER_PROMPTS.do
			}
		]);
		destroy();
	});
});
