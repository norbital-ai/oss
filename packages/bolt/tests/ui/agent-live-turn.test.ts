import { describe, expect, it } from 'vitest';
import { Effect, type Schema } from 'effect';
import { createAgentClient } from '../../src/client/ui/agent/client.svelte.js';
import { emptyAgentClient, settledQuery } from './agent-client-fixture.js';

/**
 * Wiring smoke: the ported agent client against a real bolt-server over HTTP.
 *
 * It is opt-in. The default suite proves agent client behaviour deterministically
 * (`agent-session-refresh.test.ts`); this one exists only to catch a transport or
 * serialisation break between the two processes, and correctness tests must not depend on a
 * network, a port, or a particular bundle being loaded. It previously ran unconditionally against a
 * hard-coded `capability-tenant` fixture that no running server serves, so it could only fail.
 *
 * Run it with a stack up:
 *   BOLT_SMOKE_SERVER=http://127.0.0.1:4173 \
 *   BOLT_SMOKE_AGENT=hr-payroll BOLT_SMOKE_TENANT=bolt-tenant pnpm --filter @norbital-ai/bolt test
 */
const server = process.env['BOLT_SMOKE_SERVER'];
const agentName = process.env['BOLT_SMOKE_AGENT'] ?? 'helper';
const tenantId = process.env['BOLT_SMOKE_TENANT'] ?? 'bolt-tenant';
const credential = process.env['BOLT_SMOKE_TOKEN'] ?? 'admin-token';

describe.skipIf(server === undefined || server.length === 0)('live agent conversation', () => {
	it('sends a prompt through the ported client and stores the reply', async () => {
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
		const agent = createAgentClient(
			{
				client: emptyAgentClient(transport),
				subject: { userId: 'admin-1', tenantId, teamPath: ['admin'], policies: [] },
				agentName
			},
			{ agentModels: settledQuery({ defaultModel: '', options: [] }) }
		);
		const result = await Effect.runPromise(
			agent.start({ message: 'Reply with a short greeting only.', turnId: 'turn-live' })
		);
		expect(result.chatId.length).toBeGreaterThan(0);
	});
});
