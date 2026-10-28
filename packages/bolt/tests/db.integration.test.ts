// Native PGlite batches commit or roll back before their answers are decoded; independent scopes start from pristine.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from 'effect';
import { PgliteDb, Pristine, type PgliteClient } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';

const sql = (text: string) => ({ text, params: [] });
const Pglite = PgliteDb.layer().pipe(Layer.provide(Pristine.layer));
const prepared = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* db.write(sql('create table t (n int)'));
	return db;
});
const count = (db: TenantDb['Service']) => db.value(Schema.Int, sql('select count(*)::int from t'));
const numbers = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })));

describe('PgliteDb', () => {
	it.live(
		'independent workspace scopes reuse one pristine dump and keep their writes isolated',
		() =>
			Effect.gen(function* () {
				const pristine = Pristine.pipe(Effect.flatten, Effect.provide(Pristine.layer));
				const first = yield* pristine;
				const [second, third] = yield* Effect.all([pristine, pristine], {
					concurrency: 'unbounded'
				});
				expect(second).toBe(first);
				expect(third).toBe(first);
				yield* TenantDb.use((db) =>
					db.write(sql('create table pristine_scope_write (n int)'))
				).pipe(Effect.provide(Pglite));
				const rows = yield* TenantDb.use((db) =>
					db.value(
						Schema.Int,
						sql("select count(*)::int from pg_tables where tablename = 'pristine_scope_write'")
					)
				).pipe(Effect.provide(Pglite));
				expect(rows).toBe(0);
			})
	);

	it.live('a locked SQL batch commits and answers each statement in order', () =>
		Effect.gen(function* () {
			const db = yield* prepared;
			const answered = yield* db.transaction({
				statements: [sql('insert into t values (1) returning n'), sql('select n + 1 as n from t')],
				lock: { tables: ['t'] }
			});
			expect(answered).toHaveLength(2);
			expect(yield* numbers(answered[0]?.rows ?? [])).toEqual([{ n: 1 }]);
			expect(yield* numbers(answered[1]?.rows ?? [])).toEqual([{ n: 2 }]);
			expect(yield* count(db)).toBe(1);
		}).pipe(Effect.provide(Pglite))
	);

	it.live(
		'a failing native statement rolls back earlier writes and preserves its SQLSTATE before reuse',
		() =>
			Effect.gen(function* () {
				const db = yield* prepared;
				const failure = yield* Effect.flip(
					db.transaction({
						statements: [
							sql('insert into t values (1)'),
							sql(
								"do $$ begin raise exception using errcode = 'P0001', message = 'refused'; end $$"
							),
							sql('insert into t values (2)')
						]
					})
				);
				expect(failure).toMatchObject({ _tag: 'DbError', sqlstate: 'P0001', message: 'refused' });
				expect(yield* count(db)).toBe(0);
				yield* db.write(sql('insert into t values (3)'));
				expect(yield* count(db)).toBe(1);
			}).pipe(Effect.provide(Pglite))
	);

	it.live('a native dry-run answers its SQL results and rolls back before the next batch', () =>
		Effect.gen(function* () {
			const db = yield* prepared;
			const answered = yield* db.transaction({
				statements: [
					sql('insert into t values (1) returning n'),
					sql('select count(*)::int as n from t')
				],
				rollback: true
			});
			expect(yield* numbers(answered[0]?.rows ?? [])).toEqual([{ n: 1 }]);
			expect(yield* numbers(answered[1]?.rows ?? [])).toEqual([{ n: 1 }]);
			expect(yield* count(db)).toBe(0);
			yield* db.transaction({ statements: [sql('insert into t values (2)')] });
			expect(yield* count(db)).toBe(1);
		}).pipe(Effect.provide(Pglite))
	);

	it.live(
		'interruption waits for a native statement to settle, rolls back its write, then permits reuse',
		() =>
			Effect.gen(function* () {
				const pg = yield* PgliteDb.open();
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const insert = 'insert into t values (2)';
				// Hold only the native driver's result: the application submits complete SQL before acquisition.
				const client: PgliteClient = {
					query: pg.query.bind(pg),
					exec: pg.exec.bind(pg),
					execProtocol: pg.execProtocol.bind(pg),
					parsers: pg.parsers,
					transaction: (body) =>
						pg.transaction((tx) =>
							body({
								query: tx.query.bind(tx),
								exec: async (text) => {
									const answered = await tx.exec(text);
									if (text === insert) {
										entered.resolve();
										await release.promise;
									}
									return answered;
								}
							})
						)
				};
				const db = PgliteDb.make(client);
				yield* db.write(sql('create table t (n int)'));
				yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()));
				const call = yield* db
					.transaction({ statements: [sql(insert), sql('insert into t values (4)')] })
					.pipe(Effect.forkChild);
				yield* Effect.promise(() => entered.promise);
				const stopped = yield* Deferred.make<void>();
				const stopping = yield* Fiber.interrupt(call).pipe(
					Effect.andThen(Deferred.succeed(stopped, undefined)),
					Effect.forkChild({ startImmediately: true })
				);
				yield* Effect.yieldNow;
				const settledBeforeNative = yield* Deferred.isDone(stopped);
				yield* Effect.sync(() => release.resolve());
				yield* Fiber.join(stopping);
				expect(settledBeforeNative).toBe(false);
				expect(Exit.hasInterrupts(yield* Fiber.await(call))).toBe(true);
				expect(yield* count(db)).toBe(0);
				yield* db.write(sql('insert into t values (3)'));
				expect(yield* count(db)).toBe(1);
			}).pipe(Effect.provide(Pristine.layer))
	);
});
