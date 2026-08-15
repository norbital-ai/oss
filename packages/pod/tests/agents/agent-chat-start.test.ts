import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({
	persisted: [] as Record<string, unknown>[],
	persist: async (input: Record<string, unknown>) => {
		state.persisted.push(input);
		return {
			runId: 'run-1',
			chatId: 'chat-1',
			turnId: 'turn-1',
			promptContent: input.promptContent,
			inputMessageId: 'msg-1',
			session: { norbital_id: 'chat-1', turns: [{ norbital_id: 'turn-1', status: 'running' }] },
			syncSequence: '42'
		};
	}
}));

vi.mock('$lib/server/bootstrap/workspace_store.js', () => {
	const workspace = {
		provision: 'provisioned',
		baseScope: {
			requestor: { norbital_id: 'user-1' },
			organization: { norbital_id: 'org-1', name: 'Org' }
		},
		tenantDb: { query: async () => ({ rows: [] }) }
	};
	return {
		getWorkspace: () => workspace,
		requireWorkspaceAuth: () => workspace,
		currentWorkspaceContext: () => workspace
	};
});

vi.mock('$lib/server/agent/agent-start.server.js', () => ({
	persistInteractiveAgentStart: (input: Record<string, unknown>) => state.persist(input)
}));

vi.mock('$lib/server/agent/agent-spec.server.js', () => ({
	interactiveAgentSpec: (message: string) => ({
		kind: 'agent',
		description: 'Answers one interactive request from a person in this workspace.',
		task: message,
		access: 'write',
		tools: []
	})
}));

vi.mock('$lib/server/agent/agent-loop.server.js', () => ({
	parseCompactDirective: () => null
}));

vi.mock('$lib/server/agent/agent-mentions.server.js', () => ({
	composeMentionContext: async () => null
}));

vi.mock('$lib/server/facilities.js', () => ({
	requireRuntimeFacility: () => ({}),
	getRuntimeFacilities: () => ({})
}));

vi.mock('$lib/server/i18n.js', () => ({
	requestI18n: () => ({ t: (key: string) => key })
}));

const { agentChatStart } = await import('../../src/remote/agent_chat.remote.js');

afterEach(() => {
	state.persisted = [];
	state.persist = async (input) => {
		state.persisted.push(input);
		return {
			runId: 'run-1',
			chatId: 'chat-1',
			turnId: 'turn-1',
			promptContent: input.promptContent,
			inputMessageId: 'msg-1',
			session: { norbital_id: 'chat-1', turns: [{ norbital_id: 'turn-1', status: 'running' }] },
			syncSequence: '42'
		};
	};
});

describe('agentChatStart persistence', () => {
	it('persists a pending interactive start in one batch', async () => {
		const result = await agentChatStart({ message: 'Inspect this' });
		expect(state.persisted[0]).toMatchObject({
			message: 'Inspect this',
			promptContent: 'Inspect this',
			spec: { task: 'Inspect this' }
		});
		expect(result).toMatchObject({
			runId: 'run-1',
			chatId: 'chat-1',
			accepted: true,
			syncSequence: '42'
		});
	});

	it('returns the opened session from persist without a terminal re-read', async () => {
		const openedSession = {
			norbital_id: 'chat-1',
			turns: [{ norbital_id: 'turn-1', status: 'running' }]
		};
		state.persist = async (input) => {
			state.persisted.push(input);
			return {
				runId: 'run-1',
				chatId: 'chat-1',
				turnId: 'turn-1',
				promptContent: input.promptContent,
				inputMessageId: 'msg-1',
				session: openedSession,
				syncSequence: '42'
			};
		};
		const result = await agentChatStart({ message: 'Inspect this' });
		expect(result.session).toEqual(openedSession);
	});

	it('surfaces a persist failure without a leftover conversation', async () => {
		state.persist = async () => {
			throw new Error('persist failed');
		};
		await expect(agentChatStart({ message: 'Inspect this' })).rejects.toThrow('persist failed');
		expect(state.persisted).toEqual([]);
	});
});

describe('hosted start path budget', () => {
	it('persists through drizzle batch and does not list host tools on start', () => {
		const source = readFileSync(
			new URL('../../src/remote/agent_chat.remote.ts', import.meta.url),
			'utf8'
		);
		const persist = readFileSync(
			new URL('../../src/server/agent/agent-start.server.ts', import.meta.url),
			'utf8'
		);
		expect(source).toContain('persistInteractiveAgentStart');
		expect(source).toContain('interactiveAgentSpec');
		const startAt = source.indexOf('export const agentChatStart');
		const startFn = source.slice(startAt, source.indexOf('export const agentModels'));
		expect(startFn).toContain('interactiveAgentSpec(');
		expect(startFn).not.toContain("status: 'running'");
		expect(startFn).not.toContain('createRecord');
		expect(startFn).not.toContain('withCollectionTransaction');
		expect(startFn).not.toContain('admitAgentTurn');
		expect(startFn).not.toContain('prepareInteractiveAgentTurn');
		expect(startFn).not.toContain('readChatSession');
		expect(persist).toContain('executeTenantBatch');
		expect(persist).toContain('db.insert(automation_run)');
		expect(persist).toContain('db.insert(chat_session)');
		expect(persist).not.toContain('WITH new_run AS');
		expect(persist).not.toContain('CREATE TABLE');
	});

	it('registers start on the host-owned agent door, not the API-client remote table', () => {
		const runtime = readFileSync(
			new URL('../../src/server/bootstrap/runtime_request.server.ts', import.meta.url),
			'utf8'
		);
		const client = readFileSync(new URL('../../src/ui/state/client.ts', import.meta.url), 'utf8');
		expect(runtime).toContain("'agent/start'");
		expect(runtime).toContain("'agent/updateVerifier'");
		expect(runtime).not.toContain("'remotes/agentChatStart'");
		expect(runtime).not.toContain("'remotes/agentChatUpdateVerifier'");
		expect(client).toContain("post<AgentChatStartResult>('agent/start', input)");
		expect(client).toContain("post<{ accepted: true }>('agent/updateVerifier', input)");
		expect(client).not.toContain("'remotes/agentChatStart'");
		expect(client).not.toContain("'remotes/agentChatUpdateVerifier'");
	});
});
