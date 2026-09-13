import { describe, expect, it } from 'vitest';
import {
	aggregateTaskCharges,
	aggregateTaskTokens,
	formatTaskCharge,
	formatAgentTokens,
	latestContextTokens,
	projectTurns,
	projectAgentUsage
} from '../src/client/ui/agent/transcript.js';

const rootRun = '00000000-0000-4000-8000-000000000301';
const childRun = '00000000-0000-4000-8000-000000000302';

const usageRows = [
	{
		call_id: 'call-1',
		turn_id: rootRun,
		provider: 'openrouter',
		model: 'openrouter/model-a',
		operation: 'language',
		usage: null,
		charge: { currency: 'USD', coefficient: '1250', scale: 6 },
		charge_source: 'provider',
		pricing_version: 'provider-2026-09-01',
		settlement_id: 'settlement-1',
		settlement_state: 'settled'
	},
	{
		call_id: 'call-2',
		turn_id: rootRun,
		provider: 'openrouter',
		model: 'openrouter/model-a',
		operation: 'language',
		usage: null,
		charge: { currency: 'USD', coefficient: '75', scale: 4 },
		charge_source: 'price-table',
		pricing_version: 'prices-4',
		settlement_id: 'settlement-2',
		settlement_state: 'settled'
	},
	{
		call_id: 'call-attention',
		turn_id: rootRun,
		provider: 'openrouter',
		model: 'openrouter/model-a',
		operation: 'language',
		usage: null,
		charge: { currency: 'USD', coefficient: '999', scale: 2 },
		charge_source: 'provider',
		pricing_version: 'provider-2026-09-01',
		settlement_id: 'settlement-attention',
		settlement_state: 'attention'
	},
	{
		call_id: 'call-child',
		turn_id: childRun,
		provider: 'openrouter',
		model: 'openrouter/model-a',
		operation: 'language',
		usage: null,
		charge: { currency: 'SGD', coefficient: '65', scale: 2 },
		charge_source: 'price-table',
		pricing_version: 'prices-4',
		settlement_id: 'settlement-child',
		settlement_state: 'settled'
	}
];

describe('exact Task charges', () => {
	it('shows reported charges before settlement and includes the selected child runs', () => {
		const rows = projectAgentUsage(usageRows);
		expect(aggregateTaskCharges(rows, new Set([rootRun]))).toEqual([
			{ currency: 'USD', coefficient: 9998750n, scale: 6 }
		]);
		expect(aggregateTaskCharges(rows, new Set([rootRun, childRun]))).toEqual([
			{ currency: 'SGD', coefficient: 65n, scale: 2 },
			{ currency: 'USD', coefficient: 9998750n, scale: 6 }
		]);
		expect(
			aggregateTaskCharges(
				projectAgentUsage([{ ...usageRows[0], settlement_state: 'pending' }]),
				new Set([rootRun])
			)
		).toEqual([{ currency: 'USD', coefficient: 1250n, scale: 6 }]);
	});

	it('counts cached input once and exposes incomplete usage without inventing tokens', () => {
		const rows = projectAgentUsage([
			{
				...usageRows[0],
				usage: {
					inputTokens: { total: 100, uncached: 20, cacheRead: 80, cacheWrite: 0 },
					outputTokens: { total: 30, text: 10, reasoning: 20 }
				}
			},
			usageRows[1],
			{ ...usageRows[3], usage: { billableUnits: { inputTokens: '50' } } }
		]);
		expect(aggregateTaskTokens(rows, new Set([rootRun]))).toEqual({
			input: 100,
			output: 30,
			cacheRead: 80,
			reasoning: 20,
			reportedCalls: 1,
			missingCalls: 1
		});
		expect(aggregateTaskTokens(rows, new Set([childRun]))).toMatchObject({
			input: 50,
			output: 0,
			reportedCalls: 1,
			missingCalls: 0
		});
	});

	it('formats exact decimal charges only at the display boundary', () => {
		expect(formatTaskCharge({ currency: 'USD', coefficient: 8750n, scale: 6 })).toBe('USD <0.01');
		expect(formatTaskCharge({ currency: 'SGD', coefficient: -6500n, scale: 4 })).toBe('SGD -0.65');
	});
});

it('rounds display costs and token counts without changing exact accounting', () => {
	expect(formatTaskCharge({ currency: 'USD', coefficient: 12995n, scale: 3 })).toBe('USD 13.00');
	expect(formatTaskCharge({ currency: 'USD', coefficient: 0n, scale: 9 })).toBe('USD 0.00');
	expect(formatTaskCharge({ currency: 'USD', coefficient: 2940168n, scale: 9 })).toBe('USD <0.01');
	expect(formatAgentTokens(24580)).toBe('24.6K');
	expect(formatAgentTokens(1048576)).toBe('1M');
});

it('uses the latest root request for context size, never cumulative or child tokens', () => {
	const run = projectTurns([
		{
			id: rootRun,
			conversation_id: rootRun,
			input_message_id: rootRun,
			mode: 'agent',
			phase: 'model',
			input_through_sequence: 0,
			context_window_tokens: 1048576,
			model_id: 'openrouter/model-a',
			status: 'running'
		}
	])[0]!;
	const observation = (total: number) => ({
		inputTokens: { total, uncached: total, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 10, text: 10, reasoning: 0 }
	});
	const rows = projectAgentUsage([
		{ ...usageRows[0], usage: observation(15000) },
		{ ...usageRows[0], call_id: 'new', usage: observation(4000) },
		{ ...usageRows[3], model: 'openrouter/model-a', usage: observation(99000) }
	]);
	expect(latestContextTokens(rows, run)).toBe(4000);
	expect(latestContextTokens(rows, undefined)).toBeUndefined();
});
