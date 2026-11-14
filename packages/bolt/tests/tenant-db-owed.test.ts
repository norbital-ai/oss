// What a generation owes its database: a cold start makes no trip, and the work runs once before the first statement.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { DbError, type RawDb } from '@norbital-ai/host-api';
import { TenantDb } from '../src/engine/db/tenant-db.ts';

const world = () => {
	const trips: string[] = [];
	const raw: RawDb = {
		read: (statements) =>
			Effect.sync(() => {
				trips.push('read');
				return statements.map(() => ({ rows: [], affected: 0 }));
			}),
		write: () =>
			Effect.sync(() => {
				trips.push('write');
				return { rows: [], affected: 0 };
			}),
		transaction: (batch) => Effect.sync(() => batch.statements.map(() => ({ rows: [], affected: 0 })))
	};
	return { trips, db: TenantDb.typed(raw) };
};

describe('what a generation owes its database', () => {
	it.effect('nothing is owed until the first statement, which waits for it, once', () =>
		Effect.gen(function* () {
			const { trips, db } = world();
			let paid = 0;
			db.owe(
				Effect.gen(function* () {
					paid++;
					yield* db.write({ text: 'recover', params: [] });
				})
			);
			expect(trips).toEqual([]);
			yield* Effect.all(
				[db.read([{ text: 'a', params: [] }]), db.read([{ text: 'b', params: [] }])],
				{ concurrency: 'unbounded' }
			);
			expect(paid).toBe(1);
			expect(trips).toEqual(['write', 'read', 'read']);
		})
	);
	it.effect('a statement behind owed work that fails fails, and the next one tries again', () =>
		Effect.gen(function* () {
			const { trips, db } = world();
			let attempts = 0;
			db.owe(
				Effect.suspend(() =>
					++attempts === 1
						? Effect.fail(DbError.make('08006', 'the database is not answering'))
						: Effect.void
				)
			);
			expect(yield* Effect.flip(db.read([{ text: 'a', params: [] }]))).toBeInstanceOf(DbError);
			expect(trips).toEqual([]);
			yield* db.read([{ text: 'b', params: [] }]);
			expect(attempts).toBe(2);
			expect(trips).toEqual(['read']);
		})
	);
	it.effect('only a finished statement on people or sessions counts as an identity write', () =>
		Effect.gen(function* () {
			const { db } = world();
			yield* db.write({ text: 'INSERT INTO sys_config VALUES (1)', params: [] });
			expect(db.identityWrites()).toBe(0);
			yield* db.write({ text: 'UPDATE "sys_user" SET admin = false', params: [] });
			expect(db.identityWrites()).toBe(1);
			yield* db.transaction({ statements: [{ text: 'DELETE FROM sys_session', params: [] }] });
			expect(db.identityWrites()).toBe(2);
		})
	);
	it.effect('quiet work counts as the database in use only if it writes', () =>
		Effect.gen(function* () {
			const { db } = world();
			expect(yield* db.awake).toBe(false);
			yield* db.quietly(db.read([{ text: 'any work?', params: [] }]));
			expect(yield* db.awake).toBe(false);
			yield* db.quietly(db.write({ text: 'some work', params: [] }));
			expect(yield* db.awake).toBe(true);
		})
	);
});
