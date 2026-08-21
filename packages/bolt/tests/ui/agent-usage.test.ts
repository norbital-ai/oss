import { describe, expect, it, vi } from 'vitest';
import type { Schema } from 'effect';
import {
	configureAgentRuntime,
	getInitializedWorkspaceClient,
	refreshAgentSessions
} from '../../src/client/ui/agent/client.js';
import {
	formatSessionCost,
	toPanelMessages,
	toPanelUsage,
	toSessionTotals
} from '../../src/client/ui/agent/transcript.js';

const subject = { userId: 'admin-1', tenantId: 'tenant', teamPath: ['admin'], policies: [] };

/** The id `spawn_subagent` mints, and therefore the join the panel makes to nest a delegated agent. */
const spawnCallId = 'turn-1:tool:0:0';
const childTurnId = 'child-turn-1';

/**
 * One conversation that delegated a task, exactly as `agents.history` now answers it.
 *
 * The delegated session's rows come back inside the parent's transcript, tagged with the turn that
 * produced them, and the session counters already include what that agent spent. Both are the point:
 * the reader is looking at one conversation, and its cost is the cost of everything it caused.
 */
const history = {
	conversationId: 'conversation-1',
	title: 'Headcount review',
	messages: [
		{ role: 'user', content: 'Summarise headcount', turn_id: 'turn-1' },
		{
			role: 'assistant',
			turn_id: 'turn-1',
			content: {
				id: 'turn-1',
				status: 'completed',
				subagent_id: null,
				usage: { inputTokens: 4_000, outputTokens: 200, totalTokens: 4_200, costUsd: 0.01 },
				parts: [
					{ kind: 'tool', id: spawnCallId, name: 'spawn_subagent', input: { task: 'Count staff' } },
					{
						kind: 'tool-result',
						id: spawnCallId,
						name: 'spawn_subagent',
						output: { waiting: true, conversationId: `subagent:${spawnCallId}` }
					},
					{ kind: 'text', text: 'Forty-two people.' }
				]
			}
		},
		{ role: 'user', content: 'Count staff', turn_id: childTurnId },
		{
			role: 'assistant',
			turn_id: childTurnId,
			content: {
				id: childTurnId,
				status: 'completed',
				subagent_id: `subagent:${spawnCallId}`,
				// A window of its own, and a large one. Reading this as the parent's occupancy is exactly
				// the mistake the projection has to avoid.
				usage: { inputTokens: 90_000, outputTokens: 900, totalTokens: 90_900, costUsd: 0.24 },
				parts: [{ kind: 'text', text: 'Forty-two.' }]
			}
		}
	],
	// Cost, tokens and turns for the whole tree: one turn here, one delegated. `costMicroUnits` is the
	// host's own charge — SGD 0.65 against USD 0.25 of provider spend — and it is the figure a person
	// looking at this conversation is actually invoiced.
	usage: {
		costUsd: 0.25,
		costMicroUnits: 650_000,
		costCurrency: 'SGD',
		totalTokens: 95_100,
		turnsCounted: 2,
		turnsUnreported: 0
	}
};

const loadSession = async (answer: Record<string, unknown> = history) => {
	const command = vi.fn(async (name: string, _input: Schema.Json) => {
		if (name === 'agents.listConversations') {
			return [{ id: 'conversation-1', title: 'Headcount review' }];
		}
		if (name === 'agents.history') return answer;
		return null;
	});
	configureAgentRuntime({
		transport: { command },
		subject,
		agentName: 'helper',
		userId: 'admin-1'
	});
	await refreshAgentSessions();
	const rows = getInitializedWorkspaceClient('chat_session').db.chat_session.findMany().current;
	return rows.find((row) => row.norbital_id === 'conversation-1');
};

describe('conversation usage', () => {
	it('reports the whole conversation, delegated work included, as its cost', async () => {
		const session = await loadSession();
		const totals = toSessionTotals(session as unknown as Record<string, unknown>);
		expect(totals).toEqual({
			costUsd: 0.25,
			costMicroUnits: 650_000,
			currency: 'SGD',
			totalTokens: 95_100,
			turnsCounted: 2,
			turnsUnreported: 0
		});
	});

	it('measures window occupancy against this conversation, not against a subagent', async () => {
		const session = await loadSession();
		const usage = toPanelUsage(session?.messages ?? [], 200_000);
		// The delegated agent's 90k-token window is not the window the person's next prompt lands in.
		// Before delegated rows were marked, the newest usage row won and the composer reported 45%.
		expect(usage.contextTokens).toBe(4_000);
	});

	it('nests a delegated transcript under the call that spawned it', async () => {
		const session = await loadSession();
		const panel = toPanelMessages(session?.messages ?? [], session?.turns ?? []);
		const spawn = panel.find(
			(message) => message.kind === 'tool' && message.name === 'spawn_subagent'
		);
		expect(spawn?.kind).toBe('tool');
		if (spawn?.kind !== 'tool') return;
		// The subagent's own words, under its call — not interleaved into the parent by write order,
		// where its task prompt reads as something the person typed.
		expect(
			spawn.children.map((child) => (child.kind === 'text' ? child.content : child.kind))
		).toEqual(['Count staff', 'Forty-two.']);
		// And the delegated rows are not also loose in the parent transcript.
		const texts = panel.flatMap((message) => (message.kind === 'text' ? [message.content] : []));
		expect(texts).toEqual(['Summarise headcount', 'Forty-two people.']);
	});

	it('says nothing rather than zero for a conversation that has settled no turn', async () => {
		const session = await loadSession({
			...history,
			usage: {
				costUsd: 0,
				costMicroUnits: 0,
				costCurrency: null,
				totalTokens: 0,
				turnsCounted: 0,
				turnsUnreported: 0
			}
		});
		expect(toSessionTotals(session as unknown as Record<string, unknown>)).toBeNull();
	});

	it('shows what the host will invoice, not what the provider charged it', async () => {
		const session = await loadSession();
		// USD 0.25 of provider spend is SGD 0.65 on the bill. Showing `$0.2500` beside a conversation
		// its owner is invoiced SGD 0.65 for is not a rounding difference; it is the wrong number.
		expect(formatSessionCost(toSessionTotals(session as unknown as Record<string, unknown>))).toBe(
			'SGD 0.6500'
		);
	});

	it('marks a total as a floor when some turn was never priced', () => {
		expect(
			formatSessionCost({
				costUsd: 0.25,
				costMicroUnits: 650_000,
				currency: 'SGD',
				totalTokens: 95_100,
				turnsCounted: 3,
				turnsUnreported: 1
			})
		).toBe('≥SGD 0.6500');
	});

	it('falls back to the provider charge on a host that prices nothing', () => {
		expect(
			formatSessionCost({
				costUsd: 0.25,
				costMicroUnits: 0,
				currency: null,
				totalTokens: 95_100,
				turnsCounted: 2,
				turnsUnreported: 0
			})
		).toBe('$0.2500');
	});

	it('titles the conversation from the person, not from a delegated task prompt', async () => {
		const session = await loadSession({ ...history, title: 'New conversation' });
		expect(session?.title).toBe('Summarise headcount');
	});
});
