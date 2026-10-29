import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
	catalogOf,
	compile,
	isOperand,
	semantic,
	similar,
	where,
	type Scope
} from '../src/index.ts';

const cat = catalogOf({
	tables: {
		document: {
			fields: {
				title: { kind: 'text' },
				day: { kind: 'date' },
				at: { kind: 'instant' },
				period: { kind: 'period', of: 'date' },
				vector: { kind: 'vector', dim: 2, metric: 'l2' }
			},
			search: {
				semantic: { model: 'text', dim: 2, fields: ['title'] },
				indexes: {
					stored: { field: 'vector', dim: 2, metric: 'l2' },
					derived: { dim: 2, metric: 'cosine' }
				}
			}
		}
	}
});

describe('read contract', () => {
	it.effect('takes materialized time and requestor variables, and rejects time variables', () =>
		Effect.gen(function* () {
			for (const { field, clock } of [
				{ field: 'day', clock: { today: '' } },
				{ field: 'at', clock: { now: '-1h' } },
				{ field: 'day', clock: { startOf: 'month', shift: -1 } }
			]) {
				expect((yield* Effect.flip(where(cat, 'document', { [field]: { gte: clock } }))).code).toBe(
					'invalid'
				);
				expect(isOperand(clock)).toBe(false);
			}
			expect(
				(yield* Effect.flip(
					where(cat, 'document', {
						period: { overlaps: { from: { startOf: 'month' }, to: '2026-10-31' } }
					})
				)).code
			).toBe('invalid');
			expect(yield* where(cat, 'document', { day: { gte: '2026-10-01' } })).toEqual({
				t: 'cmp',
				field: 'day',
				op: 'gte',
				arg: { _tag: 'Lit', value: '2026-10-01' }
			});
			for (const text of ['today', 'today - days(7)', 'startOfMonth(today)'])
				expect(
					(yield* Effect.flip(where(cat, 'document', { day: { gte: { var: text } } }))).message
				).toContain('materialize time before reading');
			expect(
				(yield* Effect.flip(where(cat, 'document', { day: { gte: { var: 'requestor.id' } } })))
					.message
			).toContain('not a date');
			expect(
				(yield* Effect.flip(where(cat, 'document', { title: { eq: { var: 'requestor.email' } } })))
					.code
			).toBe('invalid');
			for (const old of [{ param: 'from' }, { actor: 'id' }, { clock: 'today' }])
				expect((yield* Effect.flip(where(cat, 'document', { title: { eq: old } }))).code).toBe(
					'invalid'
				);
			expect(yield* where(cat, 'document', { title: { eq: { var: 'requestor.id' } } })).toEqual({
				t: 'cmp',
				field: 'title',
				op: 'eq',
				arg: { _tag: 'Var', text: 'requestor.id' }
			});
		})
	);

	it.effect('compiles declared and hidden search indexes and validates their probes', () =>
		Effect.gen(function* () {
			const stored = yield* similar(cat, 'document', 'stored', {}, { limit: 3 });
			expect(stored).toMatchObject({ kind: 'similar', index: 'stored' });
			const scope: Scope = { rows: () => undefined };
			const storedSql = yield* compile(
				cat,
				stored,
				{ scope },
				{ field: 'vector', vector: [1, 2], take: 3 }
			);
			expect(storedSql.sql.text).toContain('a0."vector"');
			expect(storedSql.sql.text).toContain('<->');
			const derived = yield* similar(cat, 'document', 'derived', {}, { limit: 3 });
			const derivedSql = yield* compile(
				cat,
				derived,
				{},
				{ field: 'derived', vector: [1, 2], take: 3 }
			);
			expect(derivedSql.sql.text).toContain('a0."$idx_derived"');
			expect(derivedSql.sql.text).toContain('<=>');
			for (const vector of [[1], [1, Number.POSITIVE_INFINITY]])
				expect(
					(yield* Effect.flip(compile(cat, derived, {}, { field: 'derived', vector, take: 3 })))
						.code
				).toBe('invalid');
			expect((yield* Effect.flip(similar(cat, 'document', 'missing', {}, { limit: 3 }))).code).toBe(
				'invalid'
			);
			const meaning = yield* semantic(cat, 'document', { to: 'needle', limit: 3 });
			expect(meaning).toMatchObject({ kind: 'similar', index: '$semantic' });
			expect(
				(yield* compile(cat, meaning, {}, { field: '$semantic', vector: [1, 2], take: 3 })).sql.text
			).toContain('a0."bolt_embedding"');
		})
	);
});
