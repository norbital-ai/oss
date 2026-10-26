import { expect, it } from '@effect/vitest';
import { Effect, Fiber, Result, Scheduler } from 'effect';
import type { Sql } from '../src/engine/contracts.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { coalescing } from '../src/engine/query/engine.ts';

const sql = (n: number): Sql => ({ text: 'SELECT $1 AS n', params: [n] });
const unused = () => Effect.die(new Error('unused'));
const macrotask = Effect.callback<void>((resume) => {
	const handle = setImmediate(() => resume(Effect.void));
	return Effect.sync(() => clearImmediate(handle));
});
const fixture = () => {
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
	return { calls, db };
};

it.effect(
	'participant waves wait across native awaits and shrink when a participant finishes without reading',
	() =>
		Effect.gen(function* () {
			const { db, calls } = fixture(),
				reader = yield* coalescing(db, 3);
			const first = yield* reader.read([sql(1), sql(2)]).pipe(Effect.forkScoped);
			yield* macrotask;
			expect(calls).toEqual([]);
			const second = yield* reader.read([sql(3)]).pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			expect(calls).toEqual([]);
			yield* reader.done;
			const answers = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
				concurrency: 'unbounded'
			});
			expect(calls).toHaveLength(1);
			expect(calls[0]?.map((s) => s.params[0])).toEqual([1, 2, 3]);
			expect(answers.map((rs) => rs.map((r) => r.rows[0]?.['n']))).toEqual([[1, 2], [3]]);
			const next = yield* reader.read([sql(4)]).pipe(Effect.forkScoped);
			yield* Effect.yieldNow;
			expect(calls).toHaveLength(1);
			yield* reader.done;
			expect((yield* Fiber.join(next))[0]?.rows[0]?.['n']).toBe(4);
			expect(calls).toHaveLength(2);
			yield* reader.done;
			expect(reader.write).toBe(db.write);
			expect(reader.transaction).toBe(db.transaction);
		})
);

it.effect(
	'default scope gathers microtask-separated reads in one macrotask and isolates later waves and scopes',
	() =>
		Effect.gen(function* () {
			const { db, calls } = fixture(),
				first = yield* coalescing(db),
				second = yield* coalescing(db);
			expect(yield* first.read([])).toEqual([]);
			expect(calls).toEqual([]);
			const a = yield* first.read([sql(1)]).pipe(Effect.forkScoped);
			yield* Effect.promise(() => Promise.resolve());
			const b = yield* first.read([sql(2)]).pipe(Effect.forkScoped);
			expect(calls).toEqual([]);
			yield* Effect.all([Fiber.join(a), Fiber.join(b)], { concurrency: 'unbounded' });
			expect(calls).toHaveLength(1);
			yield* first.read([sql(3)]);
			yield* second.read([sql(4)]);
			expect(calls).toHaveLength(3);
			expect(calls.map((ss) => ss.map((s) => s.params[0]))).toEqual([[1, 2], [3], [4]]);
		}).pipe(Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler('sync')))
);

it.effect('a failed wave fails every waiter with the same error and a later wave can proceed', () =>
	Effect.gen(function* () {
		const failure = DbError.make('08006', 'database');
		let calls = 0;
		const db = TenantDb.typed({
			read: (statements) =>
				Effect.suspend(() =>
					++calls === 1
						? Effect.fail(failure)
						: Effect.succeed(statements.map(() => ({ rows: [], affected: 0 })))
				),
			write: unused,
			session: () =>
				Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
			transaction: unused
		});
		const reader = yield* coalescing(db, 2);
		const outcomes = yield* Effect.all(
			[Effect.result(reader.read([sql(1)])), Effect.result(reader.read([sql(2)]))],
			{ concurrency: 'unbounded' }
		);
		for (const outcome of outcomes) {
			expect(Result.isFailure(outcome)).toBe(true);
			if (Result.isFailure(outcome)) expect(outcome.failure).toBe(failure);
		}
		yield* reader.done;
		expect(yield* reader.read([sql(3)])).toEqual([{ rows: [], affected: 0 }]);
		yield* reader.done;
		expect(calls).toBe(2);
	})
);

it.effect(
	'many participants keep distinct ordered answers across repeated waves and native await interleaving',
	() =>
		Effect.gen(function* () {
			const { db, calls } = fixture(),
				reader = yield* coalescing(db, 100);
			yield* Effect.forEach(
				Array.from({ length: 100 }, (_, i) => i),
				(participant) =>
					Effect.gen(function* () {
						for (let wave = 0; wave < 10; wave++) {
							for (let i = 0; i < participant % 3; i++) yield* Effect.yieldNow;
							const n = wave * 100 + participant;
							expect((yield* reader.read([sql(n)]))[0]?.rows[0]?.['n']).toBe(n);
						}
					}).pipe(Effect.ensuring(reader.done)),
				{ concurrency: 'unbounded' }
			);
			expect(calls).toHaveLength(10);
			expect(calls.every((batch) => batch.length === 100)).toBe(true);
		})
);
