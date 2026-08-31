import { describe, expect, it } from 'vitest';
import {
	projectStoredChatMessages,
	toPanelMessages
} from '../../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './canonical-agent-fixture.js';

const conversationId = 'conversation-inbox';
const sender = {
	agentId: 'conversation-migrations',
	agentName: 'migrator',
	title: 'Migration and performance verification'
};

const project = (
	contents: readonly {
		readonly role: 'user' | 'assistant' | 'tool';
		readonly content: string | null;
		readonly toolCalls?: Array<{
			id: string;
			type: 'function';
			function: { name: string; arguments: string };
		}>;
		readonly toolCallId?: string;
		readonly appMetadata?: Readonly<Record<string, unknown>>;
	}[]
) => {
	const canonical = canonicalAgentRows(
		contents.map(({ appMetadata, ...message }, index) => ({
			conversationId,
			message: { ...message, id: `message-${index}` },
			...(appMetadata === undefined ? {} : { appMetadata })
		}))
	);
	const stored = projectStoredChatMessages(canonical.messages, canonical.fields);
	return toPanelMessages(stored.messages, stored.turns);
};

describe('inter-agent messages in the transcript', () => {
	it('shows a received message as a message from the sending session, not as the reader', () => {
		const panel = project([
			{ role: 'user', content: 'Write the auth module' },
			{
				role: 'user',
				content: '[message from agent migrator] Heads-up: four errors in auth-store.ts',
				appMetadata: {
					version: 1,
					kind: 'input',
					delegated: { from: sender, text: 'Heads-up: four errors in auth-store.ts' }
				}
			}
		]);
		expect(panel.filter((message) => message.kind === 'agent-message')).toEqual([
			expect.objectContaining({
				direction: 'in',
				agentName: 'migrator',
				sessionTitle: 'Migration and performance verification',
				agentId: 'conversation-migrations',
				content: 'Heads-up: four errors in auth-store.ts',
				state: 'complete'
			})
		]);
	});

	it('shows a sent message with its body and recipient', () => {
		const call = {
			id: 'call-1',
			type: 'function' as const,
			function: {
				name: 'message_agent',
				arguments: JSON.stringify({
					agentId: sender.agentId,
					message: 'Those four are already fixed.'
				})
			}
		};
		const panel = project([
			{ role: 'user', content: 'Reply to the migration agent' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [call]
			},
			{
				role: 'tool',
				toolCallId: call.id,
				content: JSON.stringify({ agentName: sender.agentName, title: sender.title })
			}
		]);
		expect(panel.find((message) => message.kind === 'agent-message')).toMatchObject({
			direction: 'out',
			agentName: 'migrator',
			agentId: 'conversation-migrations',
			content: 'Those four are already fixed.',
			state: 'complete'
		});
	});
});
