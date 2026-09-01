import { describe, expect, it } from 'vitest';
import {
	aggregateTaskCharges,
	formatTaskCharge,
	projectAgentUsage
} from '../../src/client/ui/agent/transcript.js';

const rootRun = '00000000-0000-4000-8000-000000000301';
const childRun = '00000000-0000-4000-8000-000000000302';

const usageRows = [
	{
		call_id: 'call-1',
		run_id: rootRun,
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
		run_id: rootRun,
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
		run_id: rootRun,
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
		run_id: childRun,
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
	it('aggregates only settled charges for the selected run set with integer arithmetic', () => {
		const rows = projectAgentUsage(usageRows);
		expect(aggregateTaskCharges(rows, new Set([rootRun]))).toEqual([
			{ currency: 'USD', coefficient: 8750n, scale: 6 }
		]);
		expect(aggregateTaskCharges(rows, new Set([rootRun, childRun]))).toEqual([
			{ currency: 'SGD', coefficient: 65n, scale: 2 },
			{ currency: 'USD', coefficient: 8750n, scale: 6 }
		]);
	});

	it('formats exact decimal charges only at the display boundary', () => {
		expect(formatTaskCharge({ currency: 'USD', coefficient: 8750n, scale: 6 })).toBe(
			'USD 0.00875'
		);
		expect(formatTaskCharge({ currency: 'SGD', coefficient: -6500n, scale: 4 })).toBe(
			'SGD -0.65'
		);
	});
});
