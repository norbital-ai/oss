// Reproductions for Bolt audit bugs 20-22: the write-side predicate, filter aggregates and sort keys agree with the read side.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { catalog_of, order, own_pred_sql, UNSORTABLE, where, type Pred } from '../src/index.ts';
import type { Json } from '../src/values.ts';
import { schema, table } from '../src/index.ts';
import { database, exec } from './support.ts';

/** The titles of three rows (one null) a write-side predicate admits, as a same-row guard evaluates it. */
const admitted = (pred: Pred) =>
	Effect.gen(function* () {
		const pg = yield* database;
		const params: Json[] = [];
		const sql = yield* own_pred_sql(pred, 't.', { p: (v) => (params.push(v), `$${params.length}`) }, true);
		const rows = yield* exec(pg)({
			text: `SELECT t.title FROM (VALUES ('Alpha'), ('beta'), (NULL)) AS t(title) WHERE ${sql} ORDER BY t.title NULLS LAST`,
			params
		});
		return rows.map((row) => row['title'] ?? null);
	});

describe('bug 20: like and ne mean the same on the write side as on the read side', () => {
	it.live('like is case-insensitive, as a read ILIKE is', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(yield* admitted({ t: 'like', field: 'title', pattern: '%ALP%' })).toEqual(['Alpha']);
			})
		)
	);
	it.live('ne is IS DISTINCT FROM: a null differs from a value, as a read treats it', () =>
		Effect.scoped(
			Effect.gen(function* () {
				expect(
					yield* admitted({ t: 'cmp', field: 'title', op: 'ne', arg: { _tag: 'Lit', value: 'beta' } })
				).toEqual(['Alpha', null]);
			})
		)
	);
});

const cat = catalog_of(
	schema({
		order: table({
			fields: {
				number: { kind: 'text' },
				placed_on: { kind: 'date' },
				address: { kind: 'object', optional: true, fields: { city: { kind: 'text' } } },
				labels: { kind: 'text', many: true, default: [] }
			}
		}),
		line: table({
			fields: {
				order: { kind: 'ref', to: 'order', inverse: 'lines', owned: true },
				weight: { kind: 'number' },
				qty: { kind: 'int' }
			}
		})
	})
);

describe('bug 21: a filter aggregate over a number field is accepted', () => {
	it.effect('sum and avg of a number child field decode', () =>
		Effect.gen(function* () {
			for (const q of ['sum', 'avg', 'min', 'max'] as const)
				expect(
					Result.isSuccess(yield* Effect.result(where(cat, 'order', { lines: { [q]: { of: 'weight', gt: 1 } } })))
				).toBe(true);
		})
	);
});

describe('bug 22: the sortable kinds the filter builder offers are the ones the store accepts', () => {
	it.effect('order_by refuses exactly the kinds in the shared UNSORTABLE set', () =>
		Effect.gen(function* () {
			for (const [field, kind] of [
				['number', 'text'],
				['placed_on', 'date'],
				['address', 'object']
			] as const) {
				const sorted = yield* Effect.result(order(field, cat, 'order'));
				expect([field, Result.isFailure(sorted)]).toEqual([field, UNSORTABLE.has(kind)]);
			}
		})
	);
});
