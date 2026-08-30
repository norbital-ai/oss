import { describe, expect, it } from 'vitest';
import {
	projectStoredChatMessages,
	toPanelMessages
} from '../../src/client/ui/agent/transcript.js';
import { encodeAgentMessage } from '../../src/runtime/agents/agent-message.js';

const conversationId = 'conversation-inbox';
const sender = {
	agentId: 'conversation-migrations',
	agentName: 'migrator',
	title: 'Migration and performance verification'
};

const project = (contents: readonly { readonly role: string; readonly content: unknown }[]) => {
	const stored = projectStoredChatMessages(
		contents.map((message, index) => ({
			...message,
			id: `message-${index}`,
			conversation_id: conversationId,
			turn_id: null
		}))
	);
	return toPanelMessages(stored.messages, stored.turns);
};

describe('inter-agent messages in the transcript', () => {
	it('shows a received message as a message from the sending session, not as the reader', () => {
		const panel = project([
			{ role: 'user', content: 'Write the auth module' },
			{
				role: 'user',
				content: encodeAgentMessage(sender, 'Heads-up: four errors in auth-store.ts')
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
			kind: 'tool',
			id: 'call-1',
			name: 'message_agent',
			input: { agentId: sender.agentId, message: 'Those four are already fixed.' }
		};
		const panel = project([
			{ role: 'user', content: 'Reply to the migration agent' },
			{
				role: 'assistant',
				content: {
					id: 'turn-1',
					status: 'completed',
					parts: [
						call,
						{
							kind: 'tool-result',
							id: call.id,
							name: call.name,
							output: { agentName: sender.agentName, title: sender.title }
						}
					]
				}
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
