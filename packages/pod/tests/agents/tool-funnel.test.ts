import { describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
	listCalls: 0,
	tools: [
		{ name: 'sandbox_bash', description: 'bash', inputSchema: {} },
		{ name: 'sandbox_write_file', description: 'write', inputSchema: {} },
		{
			name: 'metrics_lookup',
			description: 'metrics',
			inputSchema: {},
			requiresSandbox: false
		}
	]
}));

const workspace = vi.hoisted(() => {
	const { z } = require('zod') as typeof import('zod');
	return {
		registered: {
			agentTools: {
				list_quotes: { description: 'List quotes', input: z.object({}) },
				create_quote: { description: 'Create', input: z.object({}) }
			}
		}
	};
});

const manifest = {
	collections: {
		quotes: { collection_name: 'quotes' },
		accounts: { collection_name: 'accounts' }
	}
};

vi.mock('$lib/server/bootstrap/tenant_workspace.server.js', () => ({
	getTenantWorkspace: () => workspace,
	getTenantManifest: () => manifest
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

vi.mock('$lib/server/bootstrap/workspace_store.js', () => ({
	getWorkspace: () => ({
		baseScope: { requestor: { norbital_id: 'user-1' } }
	})
}));

vi.mock('$lib/server/agent/mcp-tools.server.js', () => ({
	resolveMcpToolSpecs: async () => ({ specs: [], names: new Set<string>() })
}));

const { assembleToolSpecs } = await import('../../src/server/agent/tool-funnel.server.js');

function names(resolved: Awaited<ReturnType<typeof assembleToolSpecs>>): string[] {
	return resolved.specs.map((tool) => tool.name);
}

describe('assembleToolSpecs', () => {
	it('keeps infer on read builtins and an explicit tool allowlist even when a sandbox is bound', async () => {
		const resolved = await assembleToolSpecs({
			surface: 'infer',
			planMode: false,
			canSpawnSubagent: false,
			sandboxBound: true,
			inferTools: ['list_quotes']
		});
		expect(names(resolved)).toEqual([
			'describe_workspace',
			'list_quotes',
			'list_skills',
			'read_collection',
			'read_skill'
		]);
		expect(names(resolved)).not.toContain('sandbox_bash');
		expect(names(resolved)).not.toContain('write_collection');
		expect(names(resolved)).not.toContain('spawn_subagent');
		expect(names(resolved)).not.toContain('metrics_lookup');
		expect(names(resolved)).not.toContain('create_quote');
	});

	it('offers sandbox host tools and write coordination on an agent turn with a bound sandbox', async () => {
		const resolved = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write' },
			planMode: false,
			canSpawnSubagent: true,
			sandboxBound: true
		});
		for (const tool of [
			'sandbox_bash',
			'sandbox_write_file',
			'write_collection',
			'spawn_subagent',
			'list_sandbox_agents'
		]) {
			expect(names(resolved)).toContain(tool);
		}
		expect(names(resolved)).not.toContain('metrics_lookup');
	});

	it('withholds sandbox host tools when no sandbox is bound, even if the spec names one', async () => {
		const resolved = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write', hostTools: ['sandbox_bash'] },
			planMode: false,
			canSpawnSubagent: false,
			sandboxBound: false
		});
		expect(names(resolved)).not.toContain('sandbox_bash');
	});

	it('adds opted-in non-sandbox host tools alongside every sandbox host tool when bound', async () => {
		const resolved = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write', hostTools: ['metrics_lookup'] },
			planMode: false,
			canSpawnSubagent: false,
			sandboxBound: true
		});
		expect(names(resolved)).toContain('metrics_lookup');
		expect(names(resolved)).toContain('sandbox_bash');
	});

	it('honors denyTools for platform and workspace tools but not sandbox host tools', async () => {
		const resolved = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write', denyTools: ['write_collection', 'list_quotes'] },
			planMode: false,
			canSpawnSubagent: false,
			sandboxBound: true
		});
		expect(names(resolved)).not.toContain('write_collection');
		expect(names(resolved)).not.toContain('list_quotes');
		expect(names(resolved)).toContain('sandbox_bash');
	});

	it('rejects denyTools that name a sandbox host tool', async () => {
		await expect(
			assembleToolSpecs({
				surface: 'agent',
				spec: { denyTools: ['sandbox_bash'] },
				planMode: false,
				canSpawnSubagent: false,
				sandboxBound: true
			})
		).rejects.toThrow(/denyTools cannot name sandbox host tool sandbox_bash/);
	});

	it('keeps plan mode on read builtins only, still honoring denyTools', async () => {
		const readOnly = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write' },
			planMode: true,
			canSpawnSubagent: true,
			sandboxBound: true
		});
		expect(names(readOnly)).toEqual([
			'describe_workspace',
			'list_skills',
			'read_collection',
			'read_skill'
		]);

		const denied = await assembleToolSpecs({
			surface: 'agent',
			spec: { access: 'write', denyTools: ['read_collection'] },
			planMode: true,
			canSpawnSubagent: true,
			sandboxBound: true
		});
		expect(names(denied)).toEqual(['describe_workspace', 'list_skills', 'read_skill']);
		expect(names(denied)).not.toContain('sandbox_bash');
		expect(names(denied)).not.toContain('write_collection');
		expect(names(denied)).not.toContain('spawn_subagent');
	});
});
