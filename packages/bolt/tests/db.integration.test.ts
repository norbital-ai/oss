// PGlite as the service (W2.E1): every call is one PGlite transaction, so a transaction rolls back when its body fails
// and when it is interrupted; a fresh database starts from the process's pristine dump.
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Schema } from 'effect';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { TenantDb, TenantTx } from '../src/engine/db/tenant-db.ts';

const sql = (text: string) => ({ text, params: [] });
const Pglite = PgliteDb.layer().pipe(Layer.provide(Pristine.layer));
const prepared = Effect.gen(function* () {
	const db = yield* TenantDb;
	yield* db.write(sql('create table t (n int)'));
	return db;
});
const count = (db: TenantDb['Service']) =>
	db.value(Schema.Number, sql('select count(*)::int from t'));

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
						Schema.Number,
						sql("select count(*)::int from pg_tables where tablename = 'pristine_scope_write'")
					)
				).pipe(Effect.provide(Pglite));
				expect(rows).toBe(0);
			})
	);

	it.live('a transaction commits its body', () =>
		Effect.gen(function* () {
			const db = yield* prepared;
			yield* db.transaction(TenantTx.use((tx) => tx.query(sql('insert into t values (1)'))));
			expect(yield* count(db)).toBe(1);
		}).pipe(Effect.provide(Pglite))
	);

	it.live('a transaction rolls back when its body fails', () =>
		Effect.gen(function* () {
			const db = yield* prepared;
			const failed = db.transaction(
				TenantTx.use((tx) => tx.query(sql('insert into t values (1)'))).pipe(
					Effect.andThen(Effect.fail('refused' as const))
				)
			);
			expect(yield* Effect.flip(failed)).toBe('refused');
			expect(yield* count(db)).toBe(0);
		}).pipe(Effect.provide(Pglite))
	);

	it.live('an interrupted transaction rolls back', () =>
		Effect.gen(function* () {
			const db = yield* prepared,
				inserted = yield* Deferred.make<void>();
			const call = yield* Effect.forkChild(
				db.transaction(
					TenantTx.use((tx) => tx.query(sql('insert into t values (2)'))).pipe(
						Effect.andThen(Deferred.succeed(inserted, undefined)),
						Effect.andThen(Effect.never)
					)
				)
			);
			yield* Deferred.await(inserted);
			yield* Fiber.interrupt(call);
			expect(yield* count(db)).toBe(0);
		}).pipe(Effect.provide(Pglite))
	);
});
