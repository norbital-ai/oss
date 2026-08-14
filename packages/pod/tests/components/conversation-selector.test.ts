import { describe, expect, it } from 'vitest';
import { render, settle } from '../support/component.js';
import ConversationSelector from '../../src/ui/agent/conversation-selector.svelte';
import {
	buildConversationSelector,
	type ConversationSelectorLabels,
	type ConversationSession
} from '../../src/ui/agent/conversation-selector.js';

const labels: ConversationSelectorLabels = {
	web: 'Web',
	users: 'Users',
	groups: 'Groups',
	me: 'Me',
	unknownMember: 'Unknown member',
	channelFallback: 'Channel agent'
};

function session(
	input: Partial<ConversationSession> & Pick<ConversationSession, 'id'>
): ConversationSession {
	return {
		title: input.title ?? input.id,
		userId: input.userId ?? 'me',
		visibility: input.visibility ?? 'personal',
		platform: input.platform ?? null,
		channelKey: input.channelKey ?? null,
		externalThreadId: input.externalThreadId ?? null,
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
		value: sessions[0]?.id,
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
		const { destroy } = await openSelector([session({ id: 'c1', title: 'Workspace agent' })]);
		expect(document.body.querySelector('[role="tablist"]')).toBeNull();
		expect(document.body.textContent).toContain('Workspace agent');
		destroy();
	});

	it('lists a channel thread without embedding channel tabs', async () => {
		const { destroy } = await openSelector([
			session({
				id: 'tg-1',
				title: 'Invoice question',
				visibility: 'channel_dm',
				platform: 'telegram',
				channelKey: 'sales_desk'
			})
		]);
		expect(document.body.querySelector('[role="tablist"]')).toBeNull();
		expect(document.body.textContent).toContain('Invoice question');
		destroy();
	});

	it('lists a personal inbox without a tree or person headings', async () => {
		const { destroy } = await openSelector([
			session({ id: 'mine', title: 'My thread', userId: 'me' }),
			session({ id: 'older', title: 'Skills discussion', userId: 'me' })
		]);
		expect(document.body.textContent).toContain('My thread');
		expect(document.body.textContent).toContain('Skills discussion');
		expect(document.body.querySelector('[role="tree"]')).toBeNull();
		destroy();
	});
});
