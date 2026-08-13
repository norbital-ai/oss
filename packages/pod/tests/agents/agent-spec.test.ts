import { describe, expect, it, vi } from 'vitest';

/**
 * The spec no longer lists sandbox host tools. The funnel adds them when a session has a bound
 * sandbox; `hostTools` is only the opt-in for non-sandbox host tools.
 */
const host = vi.hoisted(() => ({
	listCalls: 0,
	tools: [
		{ name: 'sandbox_bash', description: 'Run a command in the host sandbox.', inputSchema: {} },
		{
			name: 'sandbox_write_file',
			description: 'Write a file in the host sandbox.',
			inputSchema: {}
		}
	]
}));

const workspace = {
	registered: {
		agentTools: { list_quotes: {}, create_quote: {} },
		agent: undefined,
		mcpServers: { stripe: {} }
	}
};

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => workspace
}));

vi.mock('$lib/server/facilities.js', () => ({
	getRuntimeFacilities: () => ({
		agentTools: {
			list: () => {
				host.listCalls += 1;
				return Promise.resolve(host.tools);
			}
		}
	})
}));

const { channelAgentSpec, interactiveAgentSpec, interactiveAgentStartSpec } =
	await import('../../src/server/agent/agent-spec.server.js');

describe('the tools each entry point names', () => {
	it('does not list sandbox host tools on the interactive spec', async () => {
		host.listCalls = 0;
		const spec = await interactiveAgentSpec('Assist with questions about this workspace.');
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toBeUndefined();
		expect(spec.mcpServers).toEqual(['stripe']);
		expect(host.listCalls).toBe(0);
	});

	it('does not wait on the host tool inventory when synthesizing a start-path spec', () => {
		host.listCalls = 0;
		const spec = interactiveAgentStartSpec('Inspect this workspace.');
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toBeUndefined();
		expect(spec.mcpServers).toEqual(['stripe']);
		expect(host.listCalls).toBe(0);
	});

	it('keeps the whole workspace surface on a channel run and defaults the sandbox to read-only', async () => {
		const spec = await channelAgentSpec({ standingInstruction: 'Answer sales questions.' });
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toEqual([]);
		expect(spec.mcpServers).toEqual([]);
		expect(spec.hostSandbox).toEqual({ workspace: 'read-only' });
	});

	it('passes non-sandbox host tools the channel declaration opted into', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer field questions.',
			hostTools: ['metrics_lookup']
		});
		expect(spec.hostTools).toEqual(['metrics_lookup']);
		expect(spec.hostSandbox).toEqual({ workspace: 'read-only' });
	});

	it('passes denyTools from the channel declaration without inheriting +agent.ts', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer field questions.',
			denyTools: ['write_collection']
		});
		expect(spec.denyTools).toEqual(['write_collection']);
	});

	it('names only the MCP servers the channel declaration opted into', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer billing questions.',
			mcpServers: ['stripe']
		});
		expect(spec.mcpServers).toEqual(['stripe']);
	});

	it('keeps an explicit hostSandbox from the channel declaration', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Deploy from chat.',
			hostSandbox: { workspace: 'read-write' }
		});
		expect(spec.hostSandbox).toEqual({ workspace: 'read-write' });
	});
});
