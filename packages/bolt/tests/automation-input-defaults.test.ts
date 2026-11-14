// An automation body receives each declared input default in place of an absent or null field.
import { describe, expect, it } from '@effect/vitest';
import { withInputDefaults } from '../src/engine/callables/decode.ts';

describe('automation input defaults', () => {
	it('fills absent and null fields, a clock default from the run clock, and leaves given values', () => {
		const spec = {
			unit: { kind: 'enum', values: ['a', 'b'], default: 'a' },
			due: { kind: 'date', default: { var: 'today + days(7)' } },
			note: { kind: 'text', optional: true }
		} as const;
		expect(
			withInputDefaults(spec, { due: null }, { now: '2026-11-14T00:00:00.000Z', today: '2026-11-14' })
		).toEqual({ unit: 'a', due: '2026-11-21' });
		expect(withInputDefaults(spec, { unit: 'b', due: '2026-12-01' }, { now: '', today: '' })).toEqual({
			unit: 'b',
			due: '2026-12-01'
		});
	});
});
