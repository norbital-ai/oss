import { describe, expect, it, vi } from 'vitest';
import { Effect, type Schema } from 'effect';
import { createAgentClient } from '../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient } from './ui-agent-client-fixture.js';

/**
 * Wiring smoke: the ported agent client against a real bolt-server over HTTP.
 *
 * It is opt-in. The deterministic test below proves the Task client command shape; this smoke
 * catches only transport or serialization breaks between the two processes.
 *
 * Run it with a stack up:
 *   BOLT_SMOKE_SERVER=http://127.0.0.1:4173 \
 *   BOLT_SMOKE_AGENT=hr-payroll BOLT_SMOKE_TENANT=bolt-tenant pnpm --filter @norbital-ai/bolt test
 */
const server = process.env['BOLT_SMOKE_SERVER'];
const agentId = process.env['BOLT_SMOKE_AGENT'] ?? 'helper';
const tenantId = process.env['BOLT_SMOKE_TENANT'] ?? 'bolt-tenant';
const credential = process.env['BOLT_SMOKE_TOKEN'] ?? 'admin-token';

describe('Task client commands', () => {
	it('submits and controls one client-minted Task through the canonical command pair', async () => {
		const taskId = '00000000-0000-4000-8000-000000000211';
		const directiveId = '00000000-0000-4000-8000-000000000212';
		const calls: Array<{ readonly command: string; readonly input: Schema.Json }> = [];
		const command = vi.fn((command: string, input: Schema.Json) => {
			calls.push({ command, input });
			return Promise.resolve(
				command === 'tasks.submit'
					? { directiveId }
					: { taskId, status: 'stopped' }
			);
		});
		const agent = createAgentClient({
			client: emptyAgentClient({ command }),
			subject: {
				userId: 'admin-1',
				tenantId: 'tenant-1',
				teamPath: ['admin'],
				policies: []
			},
			agentId: 'payroll'
		});

		await expect(
			Effect.runPromise(
				agent.submit({
					taskId,
					message: { role: 'user', content: 'Export payroll' },
					mode: 'agent',
					priority: 'steer'
				})
			)
		).resolves.toEqual({ taskId, directiveId });
		await expect(Effect.runPromise(agent.control(taskId, 'stop'))).resolves.toEqual({
			taskId,
			status: 'stopped'
		});
		expect(calls).toEqual([
			{
				command: 'tasks.submit',
				input: {
					taskId,
					agentId: 'payroll',
					message: { role: 'user', content: 'Export payroll' },
					mode: 'agent',
					priority: 'steer'
				}
			},
			{ command: 'tasks.control', input: { taskId, action: 'stop' } }
		]);
		expect(command).toHaveBeenCalledTimes(2);
	});

	it('revises a user message through tasks.editMessage, not tasks.submit', async () => {
		const taskId = '00000000-0000-4000-8000-000000000221';
		const messageId = '00000000-0000-4000-8000-000000000222';
		const directiveId = '00000000-0000-4000-8000-000000000223';
		const revisionId = '00000000-0000-4000-8000-000000000224';
		const calls: Array<{ readonly command: string; readonly input: Schema.Json }> = [];
		const command = vi.fn((command: string, input: Schema.Json) => {
			calls.push({ command, input });
			return Promise.resolve({ directiveId, messageId: revisionId, supersedesId: messageId });
		});
		const agent = createAgentClient({
			client: emptyAgentClient({ command }),
			subject: {
				userId: 'admin-1',
				tenantId: 'tenant-1',
				teamPath: ['admin'],
				policies: []
			},
			agentId: 'payroll'
		});

		await expect(
			Effect.runPromise(
				agent.editMessage({
					taskId,
					messageId,
					message: { role: 'user', content: 'Export payroll for March' }
				})
			)
		).resolves.toEqual({
			taskId,
			directiveId,
			messageId: revisionId,
			supersedesId: messageId
		});
		expect(calls).toEqual([
			{
				command: 'tasks.editMessage',
				input: {
					taskId,
					messageId,
					message: { role: 'user', content: 'Export payroll for March' }
				}
			}
		]);
		expect(command).toHaveBeenCalledTimes(1);
	});
});

describe.skipIf(server === undefined || server.length === 0)('live Task admission', () => {
	it('submits one encoded Effect message through the canonical Task command', async () => {
		const transport = {
			command: async (command: string, input: Schema.Json) => {
				const response = await fetch(`${server}/_bolt/command/${encodeURIComponent(command)}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
					body: JSON.stringify(input)
				});
				if (!response.ok)
					throw new Error(`${command} failed (${response.status}): ${await response.text()}`);
				return response.json();
			}
		};
		const agent = createAgentClient({
			client: emptyAgentClient(transport),
			subject: { userId: 'admin-1', tenantId, teamPath: ['admin'], policies: [] },
			agentId
		});
		const taskId = '00000000-0000-4000-8000-000000000201';
		const result = await Effect.runPromise(
			agent.submit({
				taskId,
				message: { role: 'user', content: 'Reply with a short greeting only.' },
				mode: 'agent',
				priority: 'normal'
			})
		);
		expect(result.taskId).toBe(taskId);
		expect(result.directiveId.length).toBeGreaterThan(0);
	});
});
