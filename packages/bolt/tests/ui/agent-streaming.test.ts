// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { Effect, type Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient, settledQuery } from './agent-client-fixture.js';

describe('agent actions', () => {
	it('returns after durable admission and starts direct execution without waiting for the run', async () => {
		const commands: string[] = [];
		const neverSettles = new Promise<never>(() => undefined);
		const command = vi.fn((name: string, _input: Schema.Json) => {
			commands.push(name);
			if (name === 'agents.run') return neverSettles;
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
			agent.start({
				message: 'Export payroll',
				runId: 'conversation-streaming',
				turnId: 'task-streaming'
			})
		);

		expect(result).toEqual({
			runId: 'conversation-streaming',
			chatId: 'conversation-streaming',
			taskId: 'task-streaming'
		});
		expect(commands).toEqual(['agents.enqueue', 'agents.run']);
		expect(command.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({
				conversationId: 'conversation-streaming',
				turnId: 'task-streaming'
			})
		);
		expect(command.mock.calls[1]?.[1]).toEqual({
			conversationId: 'conversation-streaming'
		});
	});

	it('kicks the direct lane for every admitted message while the server owns FIFO', async () => {
		const commands: Array<{ name: string; input: Schema.Json }> = [];
		let run = 0;
		const firstRun = new Promise<never>(() => undefined);
		const command = vi.fn((name: string, input: Schema.Json) => {
			commands.push({ name, input });
			if (name === 'agents.run') {
				run += 1;
				return run === 1
					? firstRun
					: Promise.resolve({ conversationId: 'conversation-fifo', status: 'busy' });
			}
			const turnId =
				input !== null && typeof input === 'object' && !Array.isArray(input)
					? Reflect.get(input, 'turnId')
					: undefined;
			return Promise.resolve({
				conversationId: 'conversation-fifo',
				taskId: turnId,
				turnId,
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

		await Effect.runPromise(
			agent.start({
				message: 'First',
				runId: 'conversation-fifo',
				turnId: 'turn-1'
			})
		);
		await Effect.runPromise(
			agent.start({
				message: 'Second',
				runId: 'conversation-fifo',
				turnId: 'turn-2'
			})
		);

		expect(commands).toEqual([
			{
				name: 'agents.enqueue',
				input: expect.objectContaining({
					conversationId: 'conversation-fifo',
					turnId: 'turn-1',
					message: 'First'
				})
			},
			{ name: 'agents.run', input: { conversationId: 'conversation-fifo' } },
			{
				name: 'agents.enqueue',
				input: expect.objectContaining({
					conversationId: 'conversation-fifo',
					turnId: 'turn-2',
					message: 'Second'
				})
			},
			{ name: 'agents.run', input: { conversationId: 'conversation-fifo' } }
		]);
		expect(commands.some(({ name }) => name === 'agents.history')).toBe(false);
	});
});
