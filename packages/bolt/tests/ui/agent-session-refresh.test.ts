import { describe, expect, it } from 'vitest';
import type { ModelMessage } from '@tanstack/ai';
import { agentOrbState } from '../../src/client/ui/agent/agent-orb-state.js';
import {
	projectStoredChatMessages,
	toPanelMessages
} from '../../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './canonical-agent-fixture.js';

const project = (
	source: ReadonlyArray<{
		readonly conversationId: string;
		readonly message: ModelMessage;
		readonly runId?: string;
	}>,
	runs: ReadonlyArray<{
		readonly run_id: string;
		readonly conversation_id: string;
		readonly status: string;
		readonly error?: unknown;
	}> = []
) => {
	const rows = canonicalAgentRows(source);
	return projectStoredChatMessages(rows.messages, rows.fields, runs);
};

describe('reactive canonical-message projection', () => {
	it('shows admitted input while a run has not produced an assistant message yet', () => {
		const conversation = project(
			[
				{
					conversationId: 'conversation-empty',
					message: { id: 'input-1', role: 'user', content: 'Start the check' }
				}
			],
			[{ run_id: 'run-1', conversation_id: 'conversation-empty', status: 'running' }]
		);
		expect(toPanelMessages(conversation.messages, conversation.turns)).toEqual([
			expect.objectContaining({ kind: 'text', role: 'user', content: 'Start the check' })
		]);
		expect(agentOrbState(conversation)).toBe('working');
	});

	it('projects SDK thinking before its tool call', () => {
		const conversation = project(
			[
				{
					conversationId: 'conversation-reasoning',
					runId: 'run-reasoning',
					message: {
						id: 'assistant-reasoning',
						role: 'assistant',
						content: '',
						thinking: [{ content: 'I should inspect assignments first.' }],
						toolCalls: [
							{
								id: 'call-reasoning',
								type: 'function',
								function: {
									name: 'read_collection',
									arguments: '{"collection":"job_assignments"}'
								}
							}
						]
					}
				}
			],
			[{ run_id: 'run-reasoning', conversation_id: 'conversation-reasoning', status: 'running' }]
		);
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel.map(({ kind }) => kind)).toEqual(['reasoning', 'tool']);
		expect(panel[1]).toMatchObject({
			kind: 'tool',
			name: 'read_collection',
			detail: 'job_assignments',
			state: 'running'
		});
	});

	it('pairs a synced tool result with its SDK-projected call', () => {
		const conversation = project(
			[
				{
					conversationId: 'conversation-tools',
					message: { id: 'input-tools', role: 'user', content: 'Which employees are there?' }
				},
				{
					conversationId: 'conversation-tools',
					runId: 'run-tools',
					message: {
						id: 'assistant-tools',
						role: 'assistant',
						content: 'Two employees.',
						toolCalls: [
							{
								id: 'call-1',
								type: 'function',
								function: {
									name: 'read_collection',
									arguments: '{"collection":"employees"}'
								}
							}
						]
					}
				},
				{
					conversationId: 'conversation-tools',
					runId: 'run-tools',
					message: {
						id: 'tool-result-1',
						role: 'tool',
						toolCallId: 'call-1',
						content: '{"rows":2}'
					}
				}
			],
			[{ run_id: 'run-tools', conversation_id: 'conversation-tools', status: 'completed' }]
		);
		const panel = toPanelMessages(conversation.messages, conversation.turns);
		expect(panel.find(({ kind }) => kind === 'tool')).toMatchObject({
			name: 'read_collection',
			state: 'complete',
			output: expect.stringContaining('"rows": 2')
		});
		expect(agentOrbState(conversation)).toBe('ready');
	});

	it('keeps a child transcript beneath the root spawn call', () => {
		const spawnId = 'spawn-1';
		const childId = `agent:${spawnId}`;
		const conversation = project(
			[
				{
					conversationId: 'root',
					message: {
						id: 'root-assistant',
						role: 'assistant',
						content: 'Root complete.',
						toolCalls: [
							{
								id: spawnId,
								type: 'function',
								function: { name: 'spawn_agent', arguments: '{"task":"Check source"}' }
							}
						]
					}
				},
				{
					conversationId: 'root',
					message: {
						id: 'spawn-result',
						role: 'tool',
						toolCallId: spawnId,
						content: JSON.stringify({ agentId: childId, taskId: 'child-run' })
					}
				},
				{
					conversationId: childId,
					message: { id: 'child-user', role: 'user', content: 'Check source' }
				},
				{
					conversationId: childId,
					message: { id: 'child-answer', role: 'assistant', content: 'Verified.' }
				}
			],
			[
				{ run_id: 'root-run', conversation_id: 'root', status: 'completed' },
				{ run_id: 'child-run', conversation_id: childId, status: 'completed' }
			]
		);
		const spawn = toPanelMessages(conversation.messages, conversation.turns).find(
			(message) => message.kind === 'tool' && message.name === 'spawn_agent'
		);
		expect(spawn).toMatchObject({
			kind: 'tool',
			children: [
				{ kind: 'text', role: 'user', content: 'Check source' },
				{ kind: 'text', role: 'assistant', content: 'Verified.' }
			]
		});
	});
});
