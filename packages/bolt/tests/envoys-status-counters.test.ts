import { describe, expect, it } from 'vitest';
import { envoyReceiptCounts } from '../src/runtime/envoys/envoys.js';

describe('Envoy receipt counters', () => {
	/**
	 * `count(*)` is an eight-byte integer. node-postgres hands it over as a string and the facility
	 * preserves it, so a number-only decode read every row as zero and every envoy as idle traffic.
	 */
	it('reads a driver numeric string and a number alike', () =>
		expect(
			envoyReceiptCounts([
				{ direction: 'inbound', count: '3' },
				{ direction: 'outbound', count: 2 }
			])
		).toEqual({ received: 3, replied: 2 }));

	it('answers zero for an absent direction or an unusable count', () =>
		expect(envoyReceiptCounts([{ direction: 'inbound', count: 'not a number' }])).toEqual({
			received: 0,
			replied: 0
		}));
});
