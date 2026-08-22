// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { Deferred, Effect, type Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient, settledQuery } from './agent-client-fixture.js';

describe('agent actions', () => {
	it('starts and turns a conversation without polling or history reconstruction commands', async () => {
		const commands: string[] = [];
		const turnStarted = await Effect.runPromise(Deferred.make<void>());
		const releaseTurn = await Effect.runPromise(Deferred.make<void>());
		const turnFinished = await Effect.runPromise(Deferred.make<void>());
		const command = vi.fn((name: string, _input: Schema.Json) => {
			commands.push(name);
			if (name === 'agents.start')
				return Effect.runPromise(
					Effect.succeed({ started: true, conversationId: 'conversation-streaming' })
				);
			return Effect.runPromise(
				Deferred.succeed(turnStarted, undefined).pipe(
					Effect.andThen(Deferred.await(releaseTurn)),
					Effect.andThen(Deferred.succeed(turnFinished, undefined)),
					Effect.as({
						conversationId: 'conversation-streaming',
						output: null,
						status: 'completed'
					})
				)
			);
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
			chatId: 'conversation-streaming'
		});
		await Effect.runPromise(Deferred.await(turnStarted));
		expect(commands).toEqual(['agents.start', 'agents.turn']);
		await Effect.runPromise(Deferred.succeed(releaseTurn, undefined));
		await Effect.runPromise(Deferred.await(turnFinished));
	});
});
