import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({
	created: [] as { collection: string; input: Record<string, unknown> }[],
	prepareTurn: async (): Promise<{
		turnId: string;
		promptContent: string;
		inputMessageId: string;
	}> => ({ turnId: 'turn-1', promptContent: 'Inspect this', inputMessageId: 'msg-1' }),
	admit: async (): Promise<void> => undefined,
	failedTurns: [] as { sessionId: string; turnId: string; error: string }[],
	session: { norbital_id: 'chat-1', turns: [] as Record<string, unknown>[] }
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

vi.mock('$lib/server/collection/collection_ops.server.js', () => ({
	createRecord: async (
		_ctx: unknown,
		collection: string,
		input: Record<string, unknown>
	): Promise<Record<string, unknown>> => {
		state.created.push({ collection, input });
		return {
			norbital_id: collection === 'automation_run' ? 'run-1' : 'chat-1',
			...input
		};
	}
}));

vi.mock('$lib/server/agent/agent-spec.server.js', () => ({
	interactiveAgentSpec: async (message: string) => ({
		kind: 'agent',
		description: 'Answers one interactive request from a person in this workspace.',
		task: message,
		access: 'write',
		tools: []
	}),
	interactiveAgentStartSpec: (message: string) => ({
		kind: 'agent',
		description: 'Answers one interactive request from a person in this workspace.',
		task: message,
		access: 'write',
		tools: []
	})
}));

vi.mock('$lib/server/agent/agent-loop.server.js', () => ({
	parseCompactDirective: () => null,
	prepareInteractiveAgentTurn: () => state.prepareTurn(),
	runAgent: async () => ({ runId: 'run-1', text: '' })
}));

vi.mock('$lib/server/run/automation-dispatch.server.js', () => ({
	INTERACTIVE_AGENT_AUTOMATION_NAME: 'agent:interactive',
	admitAgentTurn: () => state.admit()
}));

vi.mock('$lib/server/agent/chat-session.server.js', () => ({
	failOpenInteractiveTurn: async (sessionId: string, turnId: string, error: string) => {
		state.failedTurns.push({ sessionId, turnId, error });
	},
	readChatSession: async () => state.session
}));

vi.mock('$lib/server/collection/sync/outbox-tailer.server.js', () => ({
	currentOutboxWatermark: async () => '1'
}));

vi.mock('$lib/server/facilities.js', () => ({
	requireRuntimeFacility: () => ({})
}));

vi.mock('$lib/server/i18n.js', () => ({
	requestI18n: () => ({ t: (key: string) => key })
}));

vi.mock('$lib/server/agent/conversation-title.server.js', () => ({
	PENDING_CONVERSATION_TITLE: 'Workspace agent'
}));

const { agentChatStart } = await import('../../src/remote/agent_chat.remote.js');

afterEach(() => {
	state.created = [];
	state.failedTurns = [];
	state.session = { norbital_id: 'chat-1', turns: [] };
	state.prepareTurn = async () => ({
		turnId: 'turn-1',
		promptContent: 'Inspect this',
		inputMessageId: 'msg-1'
	});
	state.admit = async () => undefined;
});

describe('agentChatStart persistence', () => {
	it('creates the run as pending so a later send is not refused as already responding', async () => {
		await agentChatStart({ message: 'Inspect this' });
		expect(state.created[0]).toMatchObject({
			collection: 'automation_run',
			input: { status: 'pending', automation_name: null }
		});
	});

	it('persists chat_session even when admit fails after create', async () => {
		state.admit = async () => {
			throw new Error('admit failed');
		};
		await expect(agentChatStart({ message: 'Inspect this' })).rejects.toThrow('admit failed');
		expect(state.created.map((row) => row.collection)).toEqual(['automation_run', 'chat_session']);
		expect(state.created[1]?.input).toMatchObject({
			user_id: 'user-1',
			automation_run_id: 'run-1',
			title: 'Workspace agent',
			visibility: 'personal'
		});
		expect(state.failedTurns).toEqual([
			{ sessionId: 'chat-1', turnId: 'turn-1', error: 'admit failed' }
		]);
	});

	it('returns the session after the turn is opened, not the pre-turn create receipt', async () => {
		state.session = {
			norbital_id: 'chat-1',
			turns: [{ norbital_id: 'turn-1', status: 'running' }]
		};
		const result = await agentChatStart({ message: 'Inspect this' });
		expect(result.session).toEqual(state.session);
	});

	it('persists chat_session even when turn prep fails after create', async () => {
		state.prepareTurn = async () => {
			throw new Error('spec boom');
		};
		await expect(agentChatStart({ message: 'Inspect this' })).rejects.toThrow('spec boom');
		expect(state.created.map((row) => row.collection)).toEqual(['automation_run', 'chat_session']);
	});
});

describe('hosted start path budget', () => {
	it('creates the conversation before spec/admit and does not list host tools on start', () => {
		const source = readFileSync(
			new URL('../../src/remote/agent_chat.remote.ts', import.meta.url),
			'utf8'
		);
		expect(source).toContain("status: 'pending'");
		expect(source).toContain('interactiveAgentStartSpec');
		const startAt = source.indexOf('export const agentChatStart');
		const startFn = source.slice(startAt, source.indexOf('export const agentModels'));
		expect(startFn).toContain('prepareConversation(input.runId)');
		expect(startFn).toContain('interactiveAgentStartSpec');
		expect(startFn).not.toContain('interactiveAgentSpec(');
		expect(startFn).not.toContain("status: 'running'");
		expect(startFn.indexOf('prepareConversation')).toBeLessThan(
			startFn.indexOf('interactiveAgentStartSpec')
		);
		expect(startFn).toContain('failOpenInteractiveTurn');
		expect(startFn).toContain('readChatSession');
	});
});
