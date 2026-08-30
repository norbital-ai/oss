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
	it('leaves an admitted empty running turn to the visible working placeholder', () => {
		const conversation = projectStoredChatMessages([
			{
				id: 'message-user-empty',
				conversation_id: 'conversation-empty',
				turn_id: 'turn-empty',
				role: 'user',
				content: 'Start the check'
			},
			{
				id: 'message-assistant-empty',
				conversation_id: 'conversation-empty',
				turn_id: 'turn-empty',
				role: 'assistant',
				content: { id: 'turn-empty', status: 'running', parts: [] }
			}
		]);
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel).toEqual([
			expect.objectContaining({ kind: 'text', role: 'user', content: 'Start the check' })
		]);
		expect(agentOrbState(conversation)).toBe('working');
	});

	it('projects provider reasoning before the tool part in the same running turn', () => {
		const conversation = projectStoredChatMessages([
			{
				id: 'message-assistant-reasoning',
				conversation_id: 'conversation-reasoning',
				turn_id: 'turn-reasoning',
				role: 'assistant',
				content: {
					id: 'turn-reasoning',
					status: 'running',
					parts: [
						{ kind: 'reasoning', text: 'I should inspect the assignments first.' },
						{
							kind: 'tool',
							id: 'call-reasoning',
							name: 'read_collection',
							input: { collection: 'job_assignments' }
						}
					]
				}
			}
		]);
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel.map((message) => message.kind)).toEqual(['reasoning', 'tool']);
		expect(panel[0]).toMatchObject({
			kind: 'reasoning',
			content: 'I should inspect the assignments first.'
		});
	});

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

	it('keeps root activity bound to the root when a newer child turn exists', () => {
		const spawnCallId = 'root-turn:tool:0:0';
		const childConversationId = `agent:${spawnCallId}`;
		const conversation = projectStoredChatMessages([
			{
				id: 'root-user',
				conversation_id: 'conversation-root',
				turn_id: 'root-turn',
				role: 'user',
				content: 'Delegate this check'
			},
			{
				id: 'root-assistant',
				conversation_id: 'conversation-root',
				turn_id: 'root-turn',
				role: 'assistant',
				content: {
					id: 'root-turn',
					status: 'completed',
					parts: [
						{
							kind: 'tool',
							id: spawnCallId,
							name: 'spawn_agent',
							input: { task: 'Check the source' }
						},
						{
							kind: 'tool-result',
							id: spawnCallId,
							name: 'spawn_agent',
							output: {
								agentId: childConversationId,
								taskId: 'child-turn',
								status: 'running'
							}
						},
						{ kind: 'text', text: 'Root complete.' }
					]
				}
			},
			{
				id: 'child-user',
				conversation_id: childConversationId,
				turn_id: 'child-turn',
				role: 'user',
				content: 'Check the source'
			},
			{
				id: 'child-assistant',
				conversation_id: childConversationId,
				turn_id: 'child-turn',
				role: 'assistant',
				content: {
					id: 'child-turn',
					status: 'failed',
					error: 'Child failed',
					parts: []
				}
			}
		]);
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		const spawn = panel.find(
			(message) => message.kind === 'tool' && message.name === 'spawn_agent'
		);

		expect(conversation.turns.at(-1)).toMatchObject({
			conversation_id: childConversationId,
			status: 'failed'
		});
		// The transcript view-model now carries `key`/`role` per rendered child: the child turn's
		// user message, then the (empty) assistant turn body itself.
		expect(spawn).toMatchObject({
			kind: 'tool',
			children: [
				{ key: 'child-user:0', kind: 'text', role: 'user', content: 'Check the source' },
				{ key: 'child-turn', kind: 'text', role: 'assistant', content: '' }
			]
		});
		expect(
			panel.some(
				(message) =>
					(message.kind === 'tool' || message.kind === 'agent-message') &&
					message.state === 'failed'
			)
		).toBe(false);
		expect(agentOrbState(conversation)).toBe('ready');
	});
});
