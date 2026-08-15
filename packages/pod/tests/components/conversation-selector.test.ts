import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import ConversationSelector from '../../src/ui/agent/conversation-selector.svelte';
import {
	buildConversationSelector,
	type ConversationSession
} from '../../src/ui/agent/conversation-selector.js';

const labels: Parameters<typeof buildConversationSelector>[0]['labels'] = {
	web: 'Web',
	users: 'Users',
	groups: 'Groups',
	channelFallback: 'Channel agent'
};

function session(
	input: Partial<ConversationSession> & Pick<ConversationSession, 'norbital_id'>
): ConversationSession {
	return {
		title: input.title ?? input.norbital_id,
		user_id: input.user_id ?? 'me',
		visibility: input.visibility ?? 'personal',
		platform: input.platform ?? null,
		channel_key: input.channel_key ?? null,
		external_thread_id: input.external_thread_id ?? null,
		...input
	};
}

async function openSelector(sessions: ConversationSession[]): Promise<{
	container: HTMLElement;
	destroy(): void;
}> {
	const model = buildConversationSelector({
		sessions,
		labels
	});
	const mounted = render(ConversationSelector as never, {
		model,
		value: sessions[0]?.norbital_id,
		placeholder: 'No conversations yet',
		searchPlaceholder: 'Search conversations…',
		ariaLabel: 'Conversation thread',
		emptyLabel: 'No conversations yet',
		onValueChange: () => undefined
	});
	mounted.container.querySelector<HTMLButtonElement>('[aria-label="Conversation thread"]')?.click();
	await settle();
	return mounted;
}

describe('conversation selector', () => {
	it('lists conversations without channel tabs', async () => {
		const { destroy } = await openSelector([
			session({ norbital_id: 'c1', title: 'Workspace agent' })
		]);
		expect(document.body.querySelector('[role="tablist"]')).toBeNull();
		expect(document.body.textContent).toContain('Workspace agent');
		destroy();
	});

	it('lists a channel thread without embedding channel tabs', async () => {
		const { destroy } = await openSelector([
			session({
				norbital_id: 'tg-1',
				title: 'Invoice question',
				visibility: 'channel_dm',
				platform: 'telegram',
				channel_key: 'sales_desk'
			})
		]);
		expect(document.body.querySelector('[role="tablist"]')).toBeNull();
		expect(document.body.textContent).toContain('Invoice question');
		destroy();
	});

	it('lists a personal inbox without a tree or person headings', async () => {
		const { destroy } = await openSelector([
			session({ norbital_id: 'mine', title: 'My thread', user_id: 'me' }),
			session({ norbital_id: 'older', title: 'Skills discussion', user_id: 'me' })
		]);
		expect(document.body.textContent).toContain('My thread');
		expect(document.body.textContent).toContain('Skills discussion');
		expect(document.body.querySelector('[role="tree"]')).toBeNull();
		destroy();
	});
});
