import { describe, expect, it, vi } from 'vitest';
import type { Schema } from 'effect';
import {
	configureAgentRuntime,
	getInitializedWorkspaceClient,
	refreshAgentSessions,
	startInteractiveAgent
} from '../../src/client/ui/agent/client.js';
import { agentOrbState } from '../../src/client/ui/agent/agent-orb-state.js';
import { toPanelMessages } from '../../src/client/ui/agent/transcript.js';

describe('agent session refresh', () => {
	it('merges persisted history without wiping an in-flight local conversation', async () => {
		// The transport hands commands arbitrary JSON, so the stub takes what it is actually called with
		// and reads the one field it needs, rather than declaring a narrower parameter than it can receive.
		const command = vi.fn(async (name: string, input: Schema.Json) => {
			const fields = (input ?? {}) as Readonly<Record<string, Schema.Json>>;
			if (name === 'agents.listConversations') {
				return [{ id: 'conversation-1', title: 'Saved thread' }];
			}
			if (name === 'agents.history') {
				return {
					conversationId: 'conversation-1',
					title: 'Saved thread',
					messages: [
						{ role: 'user', content: JSON.stringify('Earlier question') },
						{ role: 'assistant', content: JSON.stringify({ text: 'Earlier answer' }) }
					]
				};
			}
			if (name === 'agents.turn') {
				return {
					conversationId: fields['conversationId'],
					output: { text: 'Fresh reply' },
					status: 'completed'
				};
			}
			return null;
		});
		configureAgentRuntime({
			transport: { command },
			subject: { userId: 'admin-1', tenantId: 'tenant', roles: ['admin'], teams: [] },
			agentName: 'helper',
			userId: 'admin-1'
		});
		await refreshAgentSessions();
		const afterRefresh =
			getInitializedWorkspaceClient('chat_session').db.chat_session.findMany().current;
		expect(afterRefresh).toHaveLength(1);
		expect(afterRefresh[0]?.title).toBe('Saved thread');
		await startInteractiveAgent({ message: 'New question', runId: 'conversation-2' });
		await refreshAgentSessions();
		const rows = getInitializedWorkspaceClient('chat_session').db.chat_session.findMany().current;
		expect(rows).toHaveLength(2);
		expect(JSON.stringify(rows)).toContain('Earlier answer');
		expect(JSON.stringify(rows)).toContain('Fresh reply');
	});
});

/**
 * The turn lifecycle the runtime records, read back the way the panel reads it.
 *
 * This is the exact regression a reader hit: a conversation whose agent plainly called a tool showed
 * none of them. Nothing recorded the turn, so the client synthesised `turns: []`, no stored call ever
 * reached the projection, and the orb had only a local pending flag to go on. Both halves are checked
 * here — mid-flight, where the call has no answer yet, and settled, where it does.
 *
 * One agent turn is one assistant message, so the fixture is one message whose parts are the steps
 * it took. A partly-run turn is that same message with fewer parts in it.
 */
describe('agent turn lifecycle', () => {
	const historyOf = (turnStatus: string, answered: boolean) => ({
		conversationId: 'conversation-tools',
		title: 'Tool thread',
		messages: [
			{ role: 'user', content: 'Which employees are there?' },
			{
				role: 'assistant',
				content: {
					id: 'turn-1',
					status: turnStatus,
					subagent_id: null,
					parts: [
						{ kind: 'tool', id: 'call-1', name: 'read_collection', input: { collection: 'employees' } },
						...(answered
							? [
									{ kind: 'tool-result', id: 'call-1', name: 'read_collection', output: { rows: 2 } },
									{ kind: 'text', text: 'Two employees.' }
								]
							: [])
					]
				}
			}
		]
	});

	const loadConversation = async (turnStatus: string, answered: boolean) => {
		const command = vi.fn(async (name: string) => {
			if (name === 'agents.listConversations') {
				return [{ id: 'conversation-tools', title: 'Tool thread' }];
			}
			if (name === 'agents.history') return historyOf(turnStatus, answered);
			return null;
		});
		configureAgentRuntime({
			transport: { command },
			subject: { userId: 'admin-1', tenantId: 'tenant', roles: ['admin'], teams: [] },
			agentName: 'helper',
			userId: 'admin-1'
		});
		await refreshAgentSessions();
		const row = getInitializedWorkspaceClient('chat_session')
			.db.chat_session.findMany()
			.current.find((session) => session.norbital_id === 'conversation-tools');
		if (row === undefined) throw new Error('history did not project into a session row');
		return row;
	};

	/**
	 * The whole point of the re-grain: two rounds are two sets of parts inside one message.
	 *
	 * Asserted on the count of assistant-authored blocks rather than on the parts themselves, because a
	 * projection that emitted one message per round would still contain every part — and would still
	 * render the turn as two separate agent blocks, which is the defect.
	 */
	it('projects a two-round turn as one message whose parts stay in order', async () => {
		const command = vi.fn(async (name: string) => {
			if (name === 'agents.listConversations') return [{ id: 'two-rounds', title: 'Two rounds' }];
			if (name === 'agents.history') {
				return {
					conversationId: 'two-rounds',
					title: 'Two rounds',
					messages: [
						{ role: 'user', content: 'Compare the two teams' },
						{
							role: 'assistant',
							content: {
								id: 'turn-1',
								status: 'completed',
								subagent_id: null,
								parts: [
									{ kind: 'tool', id: 'call-1', name: 'read_collection', input: { collection: 'employees' } },
									{ kind: 'tool-result', id: 'call-1', name: 'read_collection', output: { rows: 2 } },
									{ kind: 'tool', id: 'call-2', name: 'read_collection', input: { collection: 'companies' } },
									{ kind: 'tool-result', id: 'call-2', name: 'read_collection', output: { rows: 1 } },
									{ kind: 'text', text: 'Two employees across one company.' }
								]
							}
						}
					]
				};
			}
			return null;
		});
		configureAgentRuntime({
			transport: { command },
			subject: { userId: 'admin-1', tenantId: 'tenant', roles: ['admin'], teams: [] },
			agentName: 'helper',
			userId: 'admin-1'
		});
		await refreshAgentSessions();
		const row = getInitializedWorkspaceClient('chat_session')
			.db.chat_session.findMany()
			.current.find((session) => session.norbital_id === 'two-rounds');
		if (row === undefined) throw new Error('history did not project into a session row');
		// One assistant message, not one per round.
		expect(row.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
		expect(row.turns).toEqual([{ norbital_id: 'turn-1', status: 'completed', subagent_id: null }]);
		const projected = toPanelMessages(row.messages, row.turns);
		expect(
			projected.map((message) =>
				message.kind === 'tool'
					? `tool:${message.detail}`
					: message.kind === 'text'
						? `text:${message.role}`
						: message.kind
			)
		).toEqual(['text:user', 'tool:employees', 'tool:companies', 'text:assistant']);
		// Every part of the turn shares the turn's key prefix, which is what makes them one message.
		const keys = projected.slice(1).map((message) => message.key.split(':')[0]);
		expect(new Set(keys)).toEqual(new Set(['turn-1']));
	});

	it('projects a running turn with an unanswered call into a running tool part', async () => {
		const row = await loadConversation('running', false);
		expect(row.turns).toEqual([{ norbital_id: 'turn-1', status: 'running', subagent_id: null }]);
		const projected = toPanelMessages(row.messages, row.turns);
		expect(projected.find((message) => message.kind === 'tool')).toMatchObject({
			name: 'read_collection',
			detail: 'employees',
			state: 'running'
		});
		expect(agentOrbState({ messages: row.messages, turns: row.turns })).toBe('working');
	});

	it('projects a settled turn with its answer into a complete tool part', async () => {
		const row = await loadConversation('completed', true);
		const projected = toPanelMessages(row.messages, row.turns);
		const tool = projected.find((message) => message.kind === 'tool');
		expect(tool).toMatchObject({ name: 'read_collection', state: 'complete' });
		// The answer is shown on the call that names the arguments which produced it, not on its own.
		expect(tool?.kind === 'tool' ? tool.output : null).toContain('"rows": 2');
		expect(
			projected.some(
				(message) =>
					message.kind === 'text' &&
					message.role === 'assistant' &&
					message.content === 'Two employees.'
			)
		).toBe(true);
		expect(agentOrbState({ messages: row.messages, turns: row.turns })).toBe('ready');
	});
});
