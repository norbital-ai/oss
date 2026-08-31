import { describe, expect, it } from 'vitest';
import {
	formatSessionCost,
	toPanelUsage,
	toSessionTotals
} from '../../src/client/ui/agent/transcript.js';

const messages = {
	messages: [
		{
			usage: { inputTokens: 4_000, outputTokens: 200, totalTokens: 4_200, costUsd: 0.01 }
		},
		{
			delegated: true,
			usage: { inputTokens: 90_000, outputTokens: 900, totalTokens: 90_900, costUsd: 0.24 }
		}
	]
};

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
