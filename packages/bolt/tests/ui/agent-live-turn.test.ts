import { describe, expect, it } from 'vitest';
import {
	configureAgentRuntime,
	getInitializedWorkspaceClient,
	startInteractiveAgent
} from '../../src/client/ui/agent/client.js';

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
		configureAgentRuntime({
			transport: {
				command: async (command, input) => {
					const response = await fetch(`${server}/_bolt/command/${encodeURIComponent(command)}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
						body: JSON.stringify(input)
					});
					if (!response.ok)
						throw new Error(`${command} failed (${response.status}): ${await response.text()}`);
					return response.json();
				}
			},
			subject: { userId: 'admin-1', tenantId, teamPath: ['admin'], policies: [] },
			agentName,
			userId: 'admin-1'
		});
		const result = await startInteractiveAgent({ message: 'Reply with a short greeting only.' });
		expect(result.chatId.length).toBeGreaterThan(0);
		const rows = getInitializedWorkspaceClient('chat_session').db.chat_session.findMany().current;
		const contents = rows.flatMap((row) => row.messages.map((message) => JSON.stringify(message)));
		expect(contents.some((content) => content.includes('Reply with a short greeting only.'))).toBe(
			true
		);
		// The model's words are its own; what this proves is that a reply crossed the transport.
		expect(contents.some((content) => content.includes('assistant'))).toBe(true);
	});
});
