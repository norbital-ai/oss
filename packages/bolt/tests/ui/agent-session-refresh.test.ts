import { describe, expect, it } from 'vitest';
import { agentOrbState } from '../../src/client/ui/agent/agent-orb-state.js';
import {
	projectStoredChatMessages,
	toPanelMessages
} from '../../src/client/ui/agent/transcript.js';

const rows = (status: string, answered: boolean) => [
	{
		id: 'message-user',
		conversation_id: 'conversation-tools',
		turn_id: 'turn-1',
		role: 'user',
		content: 'Which employees are there?'
	},
	{
		id: 'message-assistant',
		conversation_id: 'conversation-tools',
		turn_id: 'turn-1',
		role: 'assistant',
		content: {
			id: 'turn-1',
			status,
			subagent_id: null,
			parts: [
				{
					kind: 'tool',
					id: 'call-1',
					name: 'read_collection',
					input: { collection: 'employees' }
				},
				...(answered
					? [
							{
								kind: 'tool-result',
								id: 'call-1',
								name: 'read_collection',
								output: { rows: 2 }
							},
							{ kind: 'text', text: 'Two employees.' }
						]
					: [])
			]
		}
	}
];

describe('reactive chat message projection', () => {
	it('projects a running stored turn without a history command or client-side session cache', () => {
		const conversation = projectStoredChatMessages(rows('running', false));
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel.find((message) => message.kind === 'tool')).toMatchObject({
			name: 'read_collection',
			detail: 'employees',
			state: 'running'
		});
		expect(agentOrbState(conversation)).toBe('working');
	});

	it('settles the same stored message when the live query row changes', () => {
		const conversation = projectStoredChatMessages(rows('completed', true));
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel.find((message) => message.kind === 'tool')).toMatchObject({
			name: 'read_collection',
			state: 'complete'
		});
		expect(
			panel.some(
				(message) =>
					message.kind === 'text' &&
					message.role === 'assistant' &&
					message.content === 'Two employees.'
			)
		).toBe(true);
		expect(agentOrbState(conversation)).toBe('ready');
	});
});
