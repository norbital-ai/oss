// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { Effect, type Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { createAgentClient } from '../../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient, settledQuery } from './agent-client-fixture.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const panelSource = readFileSync(
	path.join(process.cwd(), 'src/client/ui/agent/agent-chat-panel.svelte'),
	'utf8'
);

const subject = {
	userId: 'admin-1',
	tenantId: 'tenant-1',
	teamPath: ['admin'],
	policies: []
};

describe('agent actions', () => {
	it('paints submission and working state before the command settles', () => {
		expect(panelSource).toMatch(/session\.pending = true;[\s\S]*session\.echo = message;/);
		expect(panelSource).toMatch(/pending: session\.pending \|\| agentWorking/);
		expect(panelSource).toMatch(
			/\{#if \(session\.pending \|\| agentWorking\) && !agentHasSpoken\}/
		);
		expect(panelSource).toMatch(/message\.content\.trim\(\)\.length > 0/);
	});

	it('frames the assistant turn before reasoning, tools, or final prose', () => {
		expect(panelSource).toMatch(/function startsAgentTurn\(index: number\)/);
		expect(panelSource).toMatch(/data-role="assistant-turn-label"/);
		expect(panelSource).toMatch(
			/showSpeakerLabel=\{message\.kind !== 'text' \|\| message\.role !== 'assistant'\}/
		);
	});

	it('uses the shared sticky transcript and exposes a jump-to-latest control', () => {
		expect(panelSource).toMatch(/<Conversation\.Root/);
		expect(panelSource).toMatch(/<Conversation\.Content[\s\S]*as="ol"/);
		expect(panelSource).toMatch(/<Conversation\.ScrollButton/);
		expect(panelSource).toMatch(/bolt\.agent\.jumpToLatest/);
		expect(panelSource).not.toMatch(/node\.scrollTop = node\.scrollHeight/);
	});

	it('returns the result of the one command that admits and executes the turn', async () => {
		const command = vi.fn((name: string, _input: Schema.Json) =>
			Promise.resolve({
				conversationId: 'conversation-streaming',
				taskId: 'task-streaming',
				turnId: 'task-streaming',
				status: 'completed'
			} as never)
		);
		const agent = createAgentClient(
			{ client: emptyAgentClient({ command }), subject, agentName: 'web' },
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
		expect(command).toHaveBeenCalledOnce();
		// The wire carries the agent's name as the first positional argument and two optional
		// host-side slots after the input (signature-conformance arguments the transport adds).
		expect(command).toHaveBeenCalledWith(
			'agents.enqueue',
			expect.objectContaining({
				agent: 'web',
				conversationId: 'conversation-streaming',
				turnId: 'task-streaming',
				message: 'Export payroll'
			}),
			undefined,
			undefined
		);
	});

	it('uses one ordinary command invocation for every submitted turn', async () => {
		const commands: Array<{ name: string; input: Schema.Json }> = [];
		const command = vi.fn((name: string, input: Schema.Json) => {
			commands.push({ name, input });
			const turnId =
				input !== null && typeof input === 'object' && !Array.isArray(input)
					? Reflect.get(input, 'turnId')
					: undefined;
			return Promise.resolve({
				conversationId: 'conversation-turns',
				taskId: turnId,
				turnId,
				status: 'completed'
			} as never);
		});
		const agent = createAgentClient(
			{ client: emptyAgentClient({ command }), subject, agentName: 'web' },
			{ agentModels: settledQuery({ defaultModel: '', options: [] }) }
		);

		await Effect.runPromise(
			agent.start({ message: 'First', runId: 'conversation-turns', turnId: 'turn-1' })
		);
		await Effect.runPromise(
			agent.start({ message: 'Second', runId: 'conversation-turns', turnId: 'turn-2' })
		);

		expect(commands).toEqual([
			{
				name: 'agents.enqueue',
				input: expect.objectContaining({ conversationId: 'conversation-turns', turnId: 'turn-1' })
			},
			{
				name: 'agents.enqueue',
				input: expect.objectContaining({ conversationId: 'conversation-turns', turnId: 'turn-2' })
			}
		]);
	});
});
