// Fresh nested declarations keep their metadata and their generated callback contexts together.
import { expectTypeOf } from '@effect/vitest';
import { automation } from '../../src/index.ts';
import { bind_model } from '../../src/declarations.ts';
import type { Change, CreatedRow, Id, Vector, WriteCtx } from '../../src/index.ts';
import type { CreateSet } from '../../src/decl/ctx.ts';
import type { AutomationCtx } from '../../src/index.ts';
import type { AutomationSpecOf } from '../../src/decl/runtime/names.ts';
import type { StoredRow } from '../../src/decl/names.ts';
import { orders } from './fixture/models.ts';
import './registry.ts';

bind_model('orders')({
	...orders.spec,
	create: {
		columns: { fields: ['customer', 'note', 'due'], lines: { fields: ['item', 'qty', 'price'] } },
		transform: function* (rows, ctx) {
			expectTypeOf(rows).toEqualTypeOf<readonly Change<null, CreateSet<'orders'>, CreatedRow<'orders'>>[]>();
			expectTypeOf(ctx).toEqualTypeOf<WriteCtx<'orders'>>();
			expectTypeOf(rows[0]?.before).toEqualTypeOf<null | undefined>();
			// Proposed creates have no generated sequence until commit.
			expectTypeOf(rows[0]?.after.number).toEqualTypeOf<undefined>();
			if (rows[0] !== undefined) expectTypeOf(rows[0].changed('customer')).toEqualTypeOf<boolean>();
			return rows.map(({ set }) => set);
		}
	},
	indexes: {
		find: { text: ['note'] },
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
});

// Fresh automation metadata preserves the generated input and native run context without hoisting its fields.
automation({
	description: 'Set a note on many orders',
	input: {
		ids: { kind: 'ref', to: 'orders', many: true },
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
