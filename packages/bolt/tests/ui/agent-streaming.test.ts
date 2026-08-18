// @vitest-environment happy-dom
import './setup-happy-dom.js';
import { describe, expect, it } from 'vitest';
import {
	AGENT_TURN_POLL_MS,
	configureAgentRuntime,
	getInitializedWorkspaceClient,
	startInteractiveAgent
} from '../../src/client/ui/agent/client.svelte.js';
import { agentOrbState } from '../../src/client/ui/agent/agent-orb-state.js';
import { toPanelMessages } from '../../src/client/ui/agent/transcript.js';

const subject = { userId: 'admin-1', tenantId: 'tenant-1', roles: ['admin'], teams: [] };
const conversationId = 'conversation-streaming';
const turnId = 'turn-1';
const call = {
	kind: 'tool',
	id: 'call-1',
	name: 'payroll_export',
	input: { collection: 'payroll' }
};

/** The parts of the assistant turn as the store holds them at this instant. */
type StoredParts = ReadonlyArray<Record<string, unknown>>;

const historyOf = (status: string, parts: StoredParts) => ({
	conversationId,
	title: 'Export payroll',
	messages: [
		{ role: 'user', content: 'Export payroll' },
		{ role: 'assistant', content: { id: turnId, status, subagent_id: null, parts } }
	]
});

const sessionsNow = () =>
	getInitializedWorkspaceClient('chat_session').db.chat_session.findMany().current;

const activeSession = () => {
	const session = sessionsNow().find((row) => row.norbital_id === conversationId);
	if (session === undefined) throw new Error('conversation missing from the session store');
	return session;
};

/**
 * A step reaches the reader before the turn it belongs to has settled.
 *
 * This is the whole point of committing per step, and the assertion has to be taken while
 * `agents.turn` is still pending — a check on the end state passes whether the panel learned about
 * the call when it was made or when the turn returned, which is exactly how the unresponsive
 * version passed its tests. The store here answers `agents.history` with what the loop would have
 * written so far: the call is in the turn, the answer is not, and the turn is still running.
 */
describe('agent turn streaming', () => {
	it('shows a part while the turn is still running, then settles it into the same message', async () => {
		let parts: StoredParts = [];
		let status = 'running';
		let settled = false;
		let releaseTurn: () => void = () => undefined;
		const turnFinished = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});

		const command = async (name: string, _input: unknown): Promise<unknown> => {
			if (name === 'agents.history') return historyOf(status, parts);
			if (name === 'agents.listConversations')
				return [{ id: conversationId, title: 'Export payroll' }];
			if (name === 'agents.turn') {
				// Stands in for the loop: the call is committed the moment it is made, and the turn keeps
				// running until this test lets it finish.
				parts = [call];
				await turnFinished;
				parts = [
					call,
					{ kind: 'tool-result', id: call.id, name: call.name, output: { rows: 2 } },
					{ kind: 'text', text: 'Exported 2 rows' }
				];
				status = 'completed';
				settled = true;
				return { conversationId, output: { text: 'Exported 2 rows' }, status: 'completed' };
			}
			return [];
		};

		configureAgentRuntime({
			transport: { command },
			subject,
			agentName: 'helper',
			userId: 'admin-1'
		});
		const pending = startInteractiveAgent({ message: 'Export payroll', runId: conversationId });

		// Long enough for one poll to land, and no longer — the reader should not have to wait for the
		// turn, which this test never lets finish until after the assertions below.
		await new Promise((resolve) => setTimeout(resolve, AGENT_TURN_POLL_MS * 2));

		expect(settled).toBe(false);
		const midTurn = activeSession();
		const projected = toPanelMessages(midTurn.messages, midTurn.turns);
		const tool = projected.find((message) => message.kind === 'tool');
		expect(tool).toMatchObject({ name: 'payroll_export', state: 'running', detail: 'payroll' });
		// The turn it belongs to is still open, so the composer stays locked and the orb keeps working.
		expect(midTurn.turns).toEqual([{ norbital_id: turnId, status: 'running', subagent_id: null }]);
		expect(agentOrbState({ messages: midTurn.messages, turns: midTurn.turns })).toBe('working');

		releaseTurn();
		await pending;

		const done = activeSession();
		// Still one assistant message. A second one here is the per-round split rendering as two blocks.
		expect(done.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
		expect(done.turns).toEqual([{ norbital_id: turnId, status: 'completed', subagent_id: null }]);
		const finalProjection = toPanelMessages(done.messages, done.turns);
		expect(finalProjection.find((message) => message.kind === 'tool')).toMatchObject({
			name: 'payroll_export',
			state: 'complete'
		});
		expect(
			finalProjection.filter((message) => message.kind === 'text').map((message) => message.content)
		).toEqual(['Export payroll', 'Exported 2 rows']);
		expect(agentOrbState({ messages: done.messages, turns: done.turns })).toBe('ready');
	});
});
