import { describe, expect, it, vi } from 'vitest';

/**
 * Which tools each entry point *names*, with nothing else in the way.
 *
 * The channel end-to-end suite proves policy enforcement and host-tool withholding on the durable
 * admit/pump path — a host tool is not offered and is refused when called, and collection reads obey
 * the channel policy rather than the host identity. It cannot prove the other half of the tool-list
 * distinction here, because the workspace it boots authors a `src/+agent.ts`, and on the interactive
 * path an authored profile wins outright. So the fallback pair is exercised here, against the same
 * host inventory, where the only difference between the two answers is the entry point.
 */
const HOST_TOOLS = [
	{ name: 'sandbox_bash', description: 'Run a command in the host sandbox.', inputSchema: {} },
	{ name: 'sandbox_write_file', description: 'Write a file in the host sandbox.', inputSchema: {} }
];

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
		agentTools: { list: () => Promise.resolve(HOST_TOOLS) }
	})
}));

const { channelAgentSpec, interactiveAgentSpec } =
	await import('../../src/server/agent/agent-spec.server.js');

describe('the tools each entry point names', () => {
	it('names every host tool the deployment offers for an interactive run', async () => {
		const spec = await interactiveAgentSpec('Assist with questions about this workspace.');
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toEqual(['sandbox_bash', 'sandbox_write_file']);
		expect(spec.mcpServers).toEqual(['stripe']);
	});

	/**
	 * The same host, the same workspace, and no host tools unless the channel named them.
	 *
	 * A host tool authorizes on the principal it acts as, which no channel policy reaches, so the
	 * default is none. A channel that opts into a narrow analysis surface passes those names through.
	 */
	it('names no host tool for a channel run by default, keeping the whole workspace surface', async () => {
		const spec = await channelAgentSpec({ standingInstruction: 'Answer sales questions.' });
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toEqual([]);
		expect(spec.mcpServers).toEqual([]);
	});

	it('names only the host tools the channel declaration opted into', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer field questions.',
			hostTools: ['sandbox_bash', 'sandbox_read']
		});
		expect(spec.hostTools).toEqual(['sandbox_bash', 'sandbox_read']);
	});

	it('names only the MCP servers the channel declaration opted into', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer billing questions.',
			mcpServers: ['stripe']
		});
		expect(spec.mcpServers).toEqual(['stripe']);
	});

	it('defaults hostSandbox to read-only when a channel names host tools', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Answer field questions.',
			hostTools: ['sandbox_bash']
		});
		expect(spec.hostSandbox).toEqual({ workspace: 'read-only' });
	});

	it('keeps an explicit hostSandbox from the channel declaration', async () => {
		const spec = await channelAgentSpec({
			standingInstruction: 'Deploy from chat.',
			hostTools: ['sandbox_bash'],
			hostSandbox: { workspace: 'read-write' }
		});
		expect(spec.hostSandbox).toEqual({ workspace: 'read-write' });
	});
});
