import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { computed_expr } from '../src/lang/computed.ts';
import type { Expr } from '../src/schema/spec.ts';

const text = new Set(['name', 'email', 'phone']);
const cases: readonly (readonly [string, Expr])[] = [
	["'Trial ' + string(trial_no)", { concat: ['Trial ', { text: { field: 'trial_no' } }] }],
	["name + ' v' + string(version)", { concat: [{ field: 'name' }, ' v', { text: { field: 'version' } }] }],
	['name + email', { concat: [{ field: 'name' }, { field: 'email' }] }],
	['size(items) + 1', { plus: [{ json_length: { field: 'items' } }, 1] }],
	[
		'round(base * 100 / (base + coalesce(pigment, 0)), 3)',
		{
			round: [
				{ div: [{ times: [{ field: 'base' }, 100] }, { plus: [{ field: 'base' }, { coalesce: [{ field: 'pigment' }, 0] }] }] },
				3
			]
		}
	],
	["lower(regex_replace(trim(email), '^@?', '@'))", { lower: { regex_replace: [{ trim: { field: 'email' } }, '^@?', '@'] } }],
	["regex_replace(phone, r'\\D', '')", { regex_replace: [{ field: 'phone' }, '\\D', ''] }],
	["json_text(party, 'id')", { json_text: [{ field: 'party' }, 'id'] }],
	[
		"a > 1 && b || !c ? start_of(d, 'month') : plus_days(d, -2)",
		{
			when: [
				{ or: [{ and: [{ gt: [{ field: 'a' }, 1] }, { field: 'b' }] }, { not: { field: 'c' } }] },
				{ start_of: [{ field: 'd' }, 'month'] },
				{ plus_days: [{ field: 'd' }, -2] }
			]
		}
	]
];

describe('computed CEL', () => {
	it('compiles to the stored Expr tree', () => {
		for (const [cel, expected] of cases)
			assert.deepEqual(computed_expr(cel, (field) => text.has(field)), expected, cel);
	});
	it('refuses constructs a generated column cannot express', () => {
		assert.throws(() => computed_expr('max(a, b)', () => false), /function 'max'/);
		assert.throws(() => computed_expr('party.id', () => false), /not supported/);
	});
});
