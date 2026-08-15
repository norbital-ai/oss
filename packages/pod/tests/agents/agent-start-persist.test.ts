import { describe, expect, it, vi } from 'vitest';
import {
	createWorkspaceContext,
	type ProvisionedContext,
	type TenantDbClient
} from '$lib/server/bootstrap/workspace_store.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
	ctx: null as ProvisionedContext | null,
	batches: [] as { text: string; values?: readonly unknown[] }[][]
}));

vi.mock('$lib/server/bootstrap/workspace_store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/bootstrap/workspace_store.js')>();
	return {
		...actual,
		getWorkspace: () => {
			if (!state.ctx) throw new Error('Workspace context was not installed');
			return state.ctx;
		}
	};
});

const tenantDb: TenantDbClient = {
	query: async () => ({ rows: [], rowCount: 0 }),
	batch: async (statements) => {
		const compiled = statements.map((statement) =>
			typeof statement === 'string'
				? { text: statement }
				: { text: statement.text ?? '', values: statement.values }
		);
		state.batches.push(compiled);
		return compiled.map((statement, index) =>
			index === compiled.length - 1
				? { rows: [{ seq: 42n }], rowCount: 1 }
				: { rows: [], rowCount: 1 }
		);
	}
};

state.ctx = createWorkspaceContext({
	provision: 'provisioned',
	manifestCtx: {
		nodeId: 'test-node',
		manifest: { integrations: {} },
		getCollection: () => ({}),
		getRelationshipsForCollection: () => []
	} as unknown as Parameters<typeof createWorkspaceContext>[0]['manifestCtx'],
	organization: { norbital_id: ORG_ID, name: 'Test Org' },
	baseScope: {
		requestor: { norbital_id: USER_ID, role: 'admin' },
		organization: { norbital_id: ORG_ID, name: 'Test Org' }
	} as unknown as Parameters<typeof createWorkspaceContext>[0]['baseScope'],
	tenantDb
});

const { persistInteractiveAgentStart } =
	await import('../../src/server/agent/agent-start.server.js');

describe('persistInteractiveAgentStart', () => {
	it('flushes a new conversation as one drizzle batch', async () => {
		const result = await persistInteractiveAgentStart({
			message: 'Inspect this',
			promptContent: 'Inspect this',
			artifact: {
				artifactId: 'test-artifact',
				checkpointId: 'test-checkpoint',
				treeHash: 'test-tree',
				runtimeVersion: 'test-runtime'
			},
			spec: {
				kind: 'agent',
				description: 'Answers one interactive request from a person in this workspace.',
				task: 'Inspect this',
				access: 'write',
				tools: []
			},
			extras: { intent: 'do' }
		});
		expect(state.batches).toHaveLength(1);
		expect(state.batches[0]).toHaveLength(4);
		const texts = state.batches[0]?.map((statement) => statement.text).join('\n') ?? '';
		expect(texts).toContain('automation_run');
		expect(texts).toContain('chat_session');
		expect(texts).toContain('_norbital_automation_job');
		expect(texts).toContain('sync_outbox');
		expect(result.syncSequence).toBe('42');
		expect(result.session.user_id).toBe(USER_ID);
		expect(result.session.visibility).toBe('personal');
		expect(result.session.automation_run_id).toBe(result.runId);
		expect(result.session.turns).toHaveLength(1);
		expect((result.session.messages as { role: string }[])[0]?.role).toBe('user');
	});
});
