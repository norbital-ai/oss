// Fresh nested declarations keep their metadata and their generated callback contexts together.
import { expectTypeOf } from '@effect/vitest';
import { automation, model } from '../../src/index.ts';
import type { CreateRow, Id, Vector, WriteCtx } from '../../src/index.ts';
import type { AutomationCtx } from '../../src/index.ts';
import type { AutomationSpecOf } from '../../src/decl/runtime/names.ts';
import type { StoredRow } from '../../src/decl/names.ts';
import { orders } from './fixture/models.ts';
import './registry.ts';

model('orders', {
	...orders.spec,
	create: {
		columns: { orders: ['customer', 'note', 'due'], 'orders.lines': ['item', 'qty', 'price'] },
		transform: function* (rows, ctx) {
			expectTypeOf(rows).toEqualTypeOf<readonly CreateRow<'orders'>[]>();
			expectTypeOf(ctx).toEqualTypeOf<WriteCtx<'orders'>>();
			return rows;
		}
	},
	search: {
		text: ['note'],
		indexes: {
			by_colour: {
				description: 'Orders of a similar colour',
				dim: 3,
				metric: 'l2',
				input: { lab: { kind: 'vector', dim: 3, metric: 'l2' } },
				candidates: 4,
				vector: (row) => {
					expectTypeOf(row).toEqualTypeOf<StoredRow<'orders'>>();
					return row.colour;
				},
				probe: (input) => {
					expectTypeOf(input).toEqualTypeOf<{ readonly lab: Vector }>();
					return { vector: input.lab };
				},
				rerank: (input, row) => {
					expectTypeOf(input).toEqualTypeOf<{ readonly lab: Vector }>();
					expectTypeOf(row).toEqualTypeOf<StoredRow<'orders'>>();
					return 0;
				}
			}
		}
	}
});

// Fresh automation metadata preserves the generated input and native run context without hoisting its fields.
automation('orders_renote', {
	description: 'Set a note on many orders',
	input: {
		ids: { kind: 'list', of: { kind: 'id', of: 'orders' } },
		note: { kind: 'text' }
	},
	output: { kind: 'int' },
	policies: ['sales_rep'],
	run: function* (input, ctx) {
		expectTypeOf(input).toEqualTypeOf<{
			readonly ids: readonly Id<'orders'>[];
			readonly note: string;
		}>();
		expectTypeOf(ctx).toEqualTypeOf<AutomationCtx<AutomationSpecOf<'orders_renote'>>>();
		return input.ids.length;
	}
});
