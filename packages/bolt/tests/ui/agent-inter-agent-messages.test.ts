import { describe, expect, it, vi } from 'vitest';
import type { Schema } from 'effect';
import {
	configureAgentRuntime,
	getInitializedWorkspaceClient,
	refreshAgentSessions
} from '../../src/client/ui/agent/client.js';
import { encodeAgentMessage } from '../../src/runtime/agents/agent-message.js';
import { toPanelMessages } from '../../src/client/ui/agent/transcript.js';

const subject = { userId: 'admin-1', tenantId: 'tenant', roles: ['admin'], teams: [] };
const conversationId = 'conversation-inbox';

const sender = {
	sessionId: 'conversation-migrations',
	agentName: 'migrator',
	title: 'Migration and performance verification'
};

/** The panel's view of one stored conversation, through the real store and the real projection. */
const project = async (messages: ReadonlyArray<{ role: string; content: unknown }>) => {
	const command = vi.fn(async (name: string, _input: Schema.Json) => {
		if (name === 'agents.listConversations') return [{ id: conversationId, title: 'Auth module' }];
		if (name === 'agents.history') return { conversationId, title: 'Auth module', messages };
		return null;
	});
	configureAgentRuntime({
		transport: { command },
		subject,
		agentName: 'helper',
		userId: 'admin-1'
	});
	await refreshAgentSessions();
	const session = getInitializedWorkspaceClient('chat_session')
		.db.chat_session.findMany()
		.current.find((row) => row.norbital_id === conversationId);
	if (session === undefined) throw new Error('conversation missing from the session store');
	return { session, panel: toPanelMessages(session.messages, session.turns) };
};

describe('inter-agent messages in the transcript', () => {
	/**
	 * A sibling session's message is stored in the `user` role because that is the only role the log
	 * accepts for words this session did not produce. Projected as ordinary user text it renders in the
	 * reader's own bubble under their own name — a message from a conversation they were never part of,
	 * attributed to them. This is the assertion that says it is shown as what it is.
	 */
	it('shows a received message as a message from the sending session, not as the reader', async () => {
		const { panel } = await project([
			{ role: 'user', content: JSON.stringify('Write the auth module') },
			{
				role: 'user',
				content: encodeAgentMessage(sender, 'Heads-up: four errors in auth-store.ts')
			}
		]);
		const relayed = panel.filter((message) => message.kind === 'agent-message');
		expect(relayed).toHaveLength(1);
		expect(relayed[0]).toMatchObject({
			direction: 'in',
			agentName: 'migrator',
			sessionTitle: 'Migration and performance verification',
			sessionId: 'conversation-migrations',
			content: 'Heads-up: four errors in auth-store.ts',
			state: 'complete'
		});
		// The person's own question is still theirs; only the relayed one moved.
		expect(
			panel.filter((message) => message.kind === 'text' && message.role === 'user')
		).toHaveLength(1);
	});

	/** A received message is somebody else's turn, so it must not become this conversation's name. */
	it('does not title a conversation after a message another agent sent into it', async () => {
		const { session } = await project([
			{
				role: 'user',
				content: encodeAgentMessage(sender, 'Heads-up: four errors in auth-store.ts')
			},
			{ role: 'user', content: JSON.stringify('Write the auth module') }
		]);
		expect(session.title).toBe('Auth module');
	});

	/**
	 * The sending side had the same problem from the other end: the call said a message was sent and
	 * kept what was said inside the arguments payload, behind a disclosure, as JSON.
	 */
	it('shows a sent message with its body and its recipient', async () => {
		const call = {
			kind: 'tool',
			id: 'call-1',
			name: 'message_sandbox_agent',
			input: { sessionId: sender.sessionId, message: 'Those four are already fixed.' }
		};
		const { panel } = await project([
			{ role: 'user', content: JSON.stringify('Reply to the migration agent') },
			{
				role: 'assistant',
				content: {
					id: 'turn-1',
					status: 'completed',
					subagent_id: null,
					parts: [
						call,
						{
							kind: 'tool-result',
							id: call.id,
							name: call.name,
							output: {
								sessionId: sender.sessionId,
								delivered: true,
								agentName: 'migrator',
								title: sender.title
							}
						}
					]
				}
			}
		]);
		const sent = panel.filter((message) => message.kind === 'agent-message');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			direction: 'out',
			agentName: 'migrator',
			sessionTitle: sender.title,
			content: 'Those four are already fixed.',
			state: 'complete'
		});
		// Projected as the message it carried, not as a second wrench-icon row beside it.
		expect(panel.some((message) => message.kind === 'tool')).toBe(false);
	});

	/** A message still in flight, and one the tool refused, are both delivery states of the same row. */
	it('carries the delivery state of a message that has not landed', async () => {
		const { panel } = await project([
			{
				role: 'assistant',
				content: {
					id: 'turn-1',
					status: 'running',
					subagent_id: null,
					parts: [
						{
							kind: 'tool',
							id: 'call-1',
							name: 'message_sandbox_agent',
							input: { sessionId: sender.sessionId, message: 'Still going.' }
						}
					]
				}
			}
		]);
		expect(panel.filter((message) => message.kind === 'agent-message')[0]).toMatchObject({
			direction: 'out',
			state: 'running',
			agentName: null,
			sessionId: sender.sessionId
		});
	});
});
