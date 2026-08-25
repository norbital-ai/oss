// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { Effect, type Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient, settledQuery } from './agent-client-fixture.js';

describe('agent actions', () => {
	it('atomically enqueues a conversation without polling or history reconstruction commands', async () => {
		const commands: string[] = [];
		const command = vi.fn((name: string, _input: Schema.Json) => {
			commands.push(name);
			return Promise.resolve({
				conversationId: 'conversation-streaming',
				taskId: 'task-streaming',
				turnId: 'task-streaming',
				status: 'queued'
			});
		});
		const agent = createAgentClient(
			{
				client: emptyAgentClient({ command }),
				subject: {
					userId: 'admin-1',
					tenantId: 'tenant-1',
					teamPath: ['admin'],
					policies: []
				},
				agentName: 'web'
			},
			{ agentModels: settledQuery({ defaultModel: '', options: [] }) }
		);

		const result = await Effect.runPromise(
			agent.start({ message: 'Export payroll', runId: 'conversation-streaming' })
		);

		expect(result).toEqual({
			runId: 'conversation-streaming',
			chatId: 'conversation-streaming',
			taskId: 'task-streaming'
		});
		expect(commands).toEqual(['agents.enqueue']);
	});
});
