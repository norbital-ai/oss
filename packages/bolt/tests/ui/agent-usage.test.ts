import { describe, expect, it } from 'vitest';
import {
	formatSessionCost,
	projectStoredChatMessages,
	toPanelMessages,
	toPanelUsage,
	toSessionTotals
} from '../../src/client/ui/agent/transcript.js';

const spawnCallId = 'turn-1:tool:0:0';
const childTurnId = 'child-turn-1';
const grandchildSpawnCallId = 'child-turn-1:tool:0:0';
const grandchildTurnId = 'grandchild-turn-1';

const messages = projectStoredChatMessages([
	{
		id: 'message-1',
		conversation_id: 'conversation-1',
		role: 'user',
		turn_id: 'turn-1',
		content: 'Summarise headcount'
	},
	{
		id: 'message-2',
		conversation_id: 'conversation-1',
		role: 'assistant',
		turn_id: 'turn-1',
		content: {
			id: 'turn-1',
			status: 'completed',
			usage: { inputTokens: 4_000, outputTokens: 200, totalTokens: 4_200, costUsd: 0.01 },
			parts: [
				{ kind: 'tool', id: spawnCallId, name: 'spawn_agent', input: { task: 'Count staff' } },
				{
					kind: 'tool-result',
					id: spawnCallId,
					name: 'spawn_agent',
					output: { agentId: `agent:${spawnCallId}`, taskId: childTurnId, status: 'running' }
				},
				{ kind: 'text', text: 'Forty-two people.' }
			]
		}
	},
	{
		id: 'message-3',
		conversation_id: `agent:${spawnCallId}`,
		role: 'user',
		turn_id: childTurnId,
		content: 'Count staff'
	},
	{
		id: 'message-4',
		conversation_id: `agent:${spawnCallId}`,
		role: 'assistant',
		turn_id: childTurnId,
		content: {
			id: childTurnId,
			status: 'completed',
			usage: { inputTokens: 90_000, outputTokens: 900, totalTokens: 90_900, costUsd: 0.24 },
			parts: [
				{ kind: 'text', text: 'Forty-two.' },
				{
					kind: 'tool',
					id: grandchildSpawnCallId,
					name: 'spawn_agent',
					input: { task: 'Verify the total' }
				},
				{
					kind: 'tool-result',
					id: grandchildSpawnCallId,
					name: 'spawn_agent',
					output: {
						agentId: `agent:${grandchildSpawnCallId}`,
						taskId: grandchildTurnId,
						status: 'running'
					}
				}
			]
		}
	},
	{
		id: 'message-5',
		conversation_id: `agent:${grandchildSpawnCallId}`,
		role: 'user',
		turn_id: grandchildTurnId,
		content: 'Verify the total'
	},
	{
		id: 'message-6',
		conversation_id: `agent:${grandchildSpawnCallId}`,
		role: 'assistant',
		turn_id: grandchildTurnId,
		content: {
			id: grandchildTurnId,
			status: 'completed',
			parts: [{ kind: 'text', text: 'Verified forty-two.' }]
		}
	}
]);

const session = {
	usage_cost_usd: 0.25,
	usage_cost_micro_units: 650_000,
	usage_cost_currency: 'SGD',
	usage_total_tokens: 95_100,
	usage_turns_counted: 2,
	usage_turns_unreported: 0
};

describe('conversation usage', () => {
	it('reports the durable conversation total, delegated work included', () => {
		expect(toSessionTotals(session)).toEqual({
			costUsd: 0.25,
			costMicroUnits: 650_000,
			currency: 'SGD',
			totalTokens: 95_100,
			turnsCounted: 2,
			turnsUnreported: 0
		});
	});

	it('measures the parent window rather than a delegated agent window', () => {
		expect(toPanelUsage(messages.messages, 200_000).contextTokens).toBe(4_000);
	});

	it('nests delegated messages beneath the spawning call', () => {
		const panel = toPanelMessages(messages.messages, messages.turns);
		const spawn = panel.find(
			(message) => message.kind === 'tool' && message.name === 'spawn_agent'
		);
		if (spawn?.kind !== 'tool') throw new Error('spawn tool was not projected');
		expect(
			spawn.children.map((child) => (child.kind === 'text' ? child.content : child.kind))
		).toEqual(['Count staff', 'Forty-two.', 'tool']);
		const grandchildSpawn = spawn.children.find(
			(child) => child.kind === 'tool' && child.name === 'spawn_agent'
		);
		if (grandchildSpawn?.kind !== 'tool') throw new Error('grandchild spawn was not projected');
		expect(
			grandchildSpawn.children.map((child) =>
				child.kind === 'text' ? child.content : child.kind
			)
		).toEqual(['Verify the total', 'Verified forty-two.']);
		expect(panel.flatMap((message) => (message.kind === 'text' ? [message.content] : []))).toEqual([
			'Summarise headcount',
			'Forty-two people.'
		]);
	});

	it('says nothing when no turn has settled', () => {
		expect(
			toSessionTotals({
				...session,
				usage_cost_usd: 0,
				usage_cost_micro_units: 0,
				usage_cost_currency: null,
				usage_total_tokens: 0,
				usage_turns_counted: 0
			})
		).toBeNull();
	});

	it('shows the host invoice amount', () => {
		expect(formatSessionCost(toSessionTotals(session))).toBe('SGD 0.6500');
	});

	it('marks incomplete pricing as a floor', () => {
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
});
