import { describe, expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import type { Sql } from '../src/engine/contracts.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { coalescing, memoReads } from '../src/engine/query/engine.ts';

const a: Sql = { text: 'SELECT $1 AS n', params: [1] };
const b: Sql = { text: 'SELECT $1 AS n', params: [2] };
const unused = () => Effect.die(new Error('unused'));

describe('planning-scoped SQL answer cache', () => {
	it.effect(
		'deduplicates concurrent and repeated SQL without losing coalescing, order or first-answer identity',
		() =>
			Effect.gen(function* () {
				const calls: (readonly Sql[])[] = [];
				const db = TenantDb.typed({
					read: (statements) =>
						Effect.sync(() => {
							calls.push(statements);
							return statements.map((s) => ({ rows: [{ n: s.params[0]! }], affected: 1 }));
						}),
					write: unused,
					session: () =>
						Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
					transaction: unused
				});
				const cached = yield* memoReads(yield* coalescing(db));
				const [first, second] = yield* Effect.all(
					[cached.read([a, { ...a }, b]), cached.read([a])],
					{ concurrency: 'unbounded' }
				);
				expect(calls).toHaveLength(1);
				expect(calls[0]).toHaveLength(2);
				expect(first.map((r) => r.rows[0]?.['n'])).toEqual([1, 1, 2]);
				expect(first[0]).toBe(first[1]);
				expect(first[0]).toBe(second[0]);
				expect((yield* cached.read([b, a]))[1]).toBe(first[0]);
				expect(calls).toHaveLength(1);
			})
	);
	it.effect(
		'preserves the original cached failure instead of silently retrying in the same planning scope',
		() =>
			Effect.gen(function* () {
				const failure = DbError.make('08006', 'refused');
				let calls = 0;
				const cached = yield* memoReads(
					TenantDb.typed({
						read: () =>
							Effect.suspend(() => {
								calls++;
								return Effect.fail(failure);
							}),
						write: unused,
						session: () =>
							Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
						transaction: unused
					})
				);
				const results = yield* Effect.all(
					[Effect.result(cached.read([a])), Effect.result(cached.read([a]))],
					{ concurrency: 'unbounded' }
				);
				for (const result of results) {
					expect(Result.isFailure(result)).toBe(true);
					if (Result.isFailure(result)) expect(result.failure).toBe(failure);
				}
				const again = yield* Effect.result(cached.read([a]));
				expect(Result.isFailure(again) && again.failure).toBe(failure);
				expect(calls).toBe(1);
			})
	);
	it.effect('isolates lookup scopes between acts and leaves writes/transactions alone', () =>
		Effect.gen(function* () {
			const calls: (readonly Sql[])[] = [];
			const db = TenantDb.typed({
				read: (statements) =>
					Effect.sync(() => {
						calls.push(statements);
						return statements.map(() => ({ rows: [], affected: 0 }));
					}),
				write: unused,
				session: () =>
					Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
				transaction: unused
			});
			const first = yield* memoReads(db),
				second = yield* memoReads(db);
			expect(yield* first.read([])).toEqual([]);
			expect(calls).toHaveLength(0);
			yield* first.read([a]);
			yield* first.read([a]);
			yield* second.read([a]);
			expect(calls).toEqual([[a], [a]]);
			expect(first.write).toBe(db.write);
			expect(first.transaction).toBe(db.transaction);
		})
	);
});
