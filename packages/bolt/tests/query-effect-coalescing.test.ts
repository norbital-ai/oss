import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { coalescing } from '../src/engine/query/engine.ts';
import { TenantDb, TenantTx } from '../src/engine/db/tenant-db.ts';
import type { Sql } from '../src/engine/contracts.ts';

it.effect('two readers in one collection window use one database round trip', () =>
	Effect.gen(function* () {
		const batches: (readonly Sql[])[] = [];
		const db = TenantDb.typed({
			read: (statements) =>
				Effect.sync(() => {
					batches.push(statements);
					return statements.map(() => ({ rows: [], affected: 0 }));
				}),
			write: () => Effect.succeed({ rows: [], affected: 0 }),
			transaction: (body) =>
				body.pipe(
					Effect.provideService(TenantTx, {
						query: () => Effect.succeed({ rows: [], affected: 0 })
					})
				)
		});
		const reader = yield* coalescing(db);
		yield* Effect.all(
			[
				reader.read([{ text: 'SELECT 1', params: [] }]),
				reader.read([{ text: 'SELECT 2', params: [] }])
			],
			{ concurrency: 'unbounded' }
		);
		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0]?.length, 2);
	})
);
