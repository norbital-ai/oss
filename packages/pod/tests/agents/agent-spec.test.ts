import { describe, expect, it, vi } from 'vitest';

/**
 * Which tools each entry point *names*, with nothing else in the way.
 *
 * The channel end-to-end suite proves the consequence — a host tool is not offered and is refused
 * when called — but it cannot prove the other half of the distinction, because the workspace it
 * boots authors a `src/+agent.ts`, and on the interactive path an authored profile wins outright.
 * So the fallback pair is exercised here, against the same host inventory, where the only difference
 * between the two answers is the entry point.
 */
const HOST_TOOLS = [
	{ name: 'sandbox_bash', description: 'Run a command in the host sandbox.', inputSchema: {} },
	{ name: 'sandbox_write_file', description: 'Write a file in the host sandbox.', inputSchema: {} }
];

const workspace = {
	registered: {
		agentTools: { list_quotes: {}, create_quote: {} },
		agent: undefined
	}
};

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => workspace
}));

vi.mock('$lib/server/run/facilities.js', () => ({
	getRuntimeFacilities: () => ({
		agentTools: { list: () => Promise.resolve(HOST_TOOLS) }
	})
}));

const { channelAgentSpec, interactiveAgentSpec } =
	await import('../../src/lib/server/agent/agent-spec.server.js');

describe('the tools each entry point names', () => {
	it('names every host tool the deployment offers for an interactive run', async () => {
		const spec = await interactiveAgentSpec('Assist with questions about this workspace.');
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toEqual(['sandbox_bash', 'sandbox_write_file']);
	});

	/**
	 * The same host, the same workspace, and no host tools at all.
	 *
	 * A host tool authorizes on the principal it acts as, which no channel declaration chooses and no
	 * channel policy reaches, so offering `sandbox_bash` to a group conversation would hand it the
	 * workspace's own source tree under whichever principal the host resolved. The workspace half is
	 * untouched, because that half genuinely is bounded by the channel principal's policy.
	 */
	it('names no host tool for a channel run, keeping the whole workspace surface', async () => {
		const spec = await channelAgentSpec({ standingInstruction: 'Answer sales questions.' });
		expect(spec.access).toBe('write');
		expect(spec.tools).toEqual(['list_quotes', 'create_quote']);
		expect(spec.hostTools).toEqual([]);
	});
});
