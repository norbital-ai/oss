import { assert, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { coalescing } from '../src/engine/query/engine.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import type { Sql } from '../src/engine/contracts.ts';

it.effect('two readers share one database call and retain their positional answers', () =>
	Effect.gen(function* () {
		const batches: (readonly Sql[])[] = [];
		const first: Sql = { text: 'SELECT $1::integer AS n', params: [1] };
		const second: Sql = { text: 'SELECT $1::integer AS n', params: [2] };
		const db = TenantDb.typed({
			read: (statements) =>
				Effect.sync(() => {
					batches.push(statements);
					return statements.map((statement) => ({
						rows: [{ n: statement.params[0] ?? null }],
						affected: 1
					}));
				}),
			write: () => Effect.fail(DbError.make('XX000', 'coalesced reads never write')),
			session: () =>
				Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
			transaction: () =>
				Effect.fail(DbError.make('XX000', 'coalesced reads never open a write batch'))
		});
		const reader = yield* coalescing(db);
		const answers = yield* Effect.all([reader.read([first]), reader.read([second])], {
			concurrency: 'unbounded'
		});
		const decode = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ n: Schema.Int })));
		const rows = yield* Effect.forEach(answers, (answer) => decode(answer[0]?.rows ?? []));
		assert.strictEqual(batches.length, 1);
		assert.deepStrictEqual(batches[0], [first, second]);
		assert.deepStrictEqual(rows, [[{ n: 1 }], [{ n: 2 }]]);
	})
);
