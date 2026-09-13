// @vitest-environment happy-dom
import './ui-setup-happy-dom.js';
import { flushSync, mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
import AgentMessageQueue from '../src/client/ui/agent/agent-message-queue.svelte';
import { projectConversationMessages } from '../src/client/ui/agent/transcript.js';
import { orderedQueuedMessages } from '../src/runtime/agents/queue-order.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

it('renders a compact queue with drag handles and independent steer/remove controls', async () => {
	const messages = projectConversationMessages(
		canonicalAgentRows([
			{
				conversationId: '00000000-0000-4000-8000-000000000901',
				message: { role: 'user', content: 'First queued request' },
				annotation: { tag: 'input', queuePosition: 2 }
			},
			{
				conversationId: '00000000-0000-4000-8000-000000000901',
				message: { role: 'user', content: 'Second queued request' },
				annotation: { tag: 'input', queuePosition: 1 }
			}
		]).map((row) => ({ ...row, state: 'queued', priority: 'normal' }))
	);
	const target = document.createElement('div');
	document.body.append(target);
	const onsteer = vi.fn(),
		onremove = vi.fn(),
		onreorder = vi.fn();
	const component = mount(AgentMessageQueue, {
		target,
		props: { messages: orderedQueuedMessages(messages), onsteer, onremove, onreorder }
	});
	flushSync();
	try {
		const rows = target.querySelectorAll<HTMLElement>('[data-queue-message]');
		expect([...rows].map((row) => row.dataset.queueMessage)).toEqual([
			messages[1]!.id,
			messages[0]!.id
		]);
		expect(target.querySelectorAll('[data-queue-drag]')).toHaveLength(2);
		const list = target.querySelector('ol')!;
		const instanceKey = Object.keys(list).find((key) => key.startsWith('Sortable'))!;
		const instance = Reflect.get(list, instanceKey) as { option: (name: string) => string };
		const handle = instance.option('handle');
		expect(typeof handle).toBe('string');
		for (const grip of target.querySelectorAll('[data-queue-drag]')) {
			expect(grip.matches(handle!)).toBe(true);
		}
		rows[0]!.querySelector<HTMLButtonElement>('[aria-label="Steer now"]')!.click();
		rows[1]!.querySelector<HTMLButtonElement>('[aria-label="Remove queued message"]')!.click();
		expect(onsteer).toHaveBeenCalledExactlyOnceWith(messages[1]!.id);
		expect(onremove).toHaveBeenCalledExactlyOnceWith(messages[0]!.id);
		expect(onreorder).not.toHaveBeenCalled();
	} finally {
		await unmount(component);
		target.remove();
	}
});
