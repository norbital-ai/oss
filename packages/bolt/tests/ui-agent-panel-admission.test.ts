// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { fromStore, writable } from 'svelte/store';
import { expect, it, vi } from 'vitest';
import { ConversationSendRequest } from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import { createAgentClient } from '../src/client/ui/agent/client.svelte.js';
import AgentChatPanel from '../src/client/ui/agent/agent-chat-panel.svelte';
import { emptyAgentClient, settledQuery } from './ui-agent-client-fixture.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

let agent: ReturnType<typeof createAgentClient>;
vi.mock('../src/client/ui/agent/client.svelte.js', async (original) => ({
	...(await original<typeof import('../src/client/ui/agent/client.svelte.js')>()),
	useAgentClient: () => agent
}));
vi.mock('@norbital-ai/ui/i18n', async (original) => ({
	...(await original<typeof import('@norbital-ai/ui/i18n')>()),
	useI18n: () => ({ t: (key: string) => key })
}));

it('selects a new task and clears admitted text before its reply, preserving the next draft on late completion', async () => {
	const conversations = writable<unknown[]>([]);
	const messages = writable<unknown[]>([]);
	const conversationState = fromStore(conversations);
	const messageState = fromStore(messages);
	let request: typeof ConversationSendRequest.Type | undefined;
	let finish: ((value: { messageId: string }) => void) | undefined;
	const baseClient = emptyAgentClient({
		command: async (name, input) => {
			if (name === 'conversations.models')
				return {
					defaultLanguageModelId: 'openrouter/deepseek/deepseek-v4.1-flash',
					languageModels: [
						{ id: 'openrouter/deepseek/deepseek-v4.1-flash', contextWindowTokens: 1048576 }
					]
				};
			if (name !== 'conversations.send') throw new Error(name);
			request = Schema.decodeUnknownSync(ConversationSendRequest)(input);
			return new Promise<{ messageId: string }>((resolve) => {
				finish = resolve;
			});
		}
	});
	const client = {
		...baseClient,
		db: {
			...baseClient.db,
			conversation: {
				...baseClient.db.conversation,
				findMany: () =>
					({
						...settledQuery([]),
						nextCursor: null,
						get current() {
							return conversationState.current;
						}
					}) as ReturnType<typeof baseClient.db.conversation.findMany>
			},
			conversation_message: {
				...baseClient.db.conversation_message,
				findMany: () =>
					({
						...settledQuery([]),
						nextCursor: null,
						get current() {
							return messageState.current;
						}
					}) as ReturnType<typeof baseClient.db.conversation_message.findMany>
			}
		}
	};
	agent = createAgentClient({
		client,
		subject: { userId: 'admin', tenantId: 'tenant', teamPath: ['admin'], policies: [] },
		agentId: 'web'
	});
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(AgentChatPanel, { target });
	try {
		flushSync();
		await vi.waitFor(() => expect(target.textContent).toContain('deepseek/deepseek-v4.1-flash'));
		target.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')!.click();
		flushSync();
		const composer = target.querySelector<HTMLTextAreaElement>('#agent-task-composer')!;
		composer.value = 'Inspect the workspace';
		composer.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		target.querySelector<HTMLButtonElement>('[aria-label="bolt.agent.send"]')!.click();
		await vi.waitFor(() => expect(request).toBeDefined());
		flushSync();
		expect(agent.surface.conversationId).toBe(request!.conversationId);
		expect(agent.surface.composingNew).toBe(false);
		conversations.set([
			{ id: request!.conversationId, agent_id: 'web', audience: 'personal', status: 'running' }
		]);
		messages.set(
			canonicalAgentRows([
				{
					conversationId: request!.conversationId!,
					message: request!.message,
					annotation: { tag: 'input' }
				}
			]).map((row) => ({
				...row,
				id: request!.submissionId,
				state: 'consumed',
				priority: 'normal'
			}))
		);
		flushSync();
		await vi.waitFor(() => expect(composer.value).toBe(''));
		expect(target.querySelector('[aria-label="bolt.agent.stop"]')).not.toBeNull();
		expect(target.querySelector('[aria-label="bolt.agent.send"]')).toBeNull();
		composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
		const cancel = [
			...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')
		].find((button) => button.textContent?.includes('bolt.agent.keepWorking'))!;
		cancel.click();
		flushSync();
		composer.value = 'A newer unsent draft';
		composer.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(target.querySelector('[aria-label="bolt.agent.queueMessage"]')).not.toBeNull();
		expect(target.querySelector('[aria-label="bolt.agent.stop"]')).toBeNull();
		finish!({ messageId: request!.submissionId! });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		flushSync();
		expect(composer.value).toBe('A newer unsent draft');
	} finally {
		await unmount(component);
		target.remove();
	}
});
