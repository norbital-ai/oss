// The tenant database as a service (W2.E1) over node-postgres fakes: one connection per call under the database wall,
// destroyed (never returned) when the call is interrupted or rollback fails; a SQL batch rolls back on failure and,
// interrupted, leaves the rollback to the server; typed reads refuse a malformed row naming its table.
import { describe, expect, expectTypeOf, it } from '@effect/vitest';
import { Effect, Exit, Fiber, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { LIMITS } from '../src/engine/contracts.ts';
import { PostgresDb, type PgClient } from '../src/node/db/postgres.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { row, type Row } from '../src/engine/system/rows.ts';

type Answer = Awaited<ReturnType<PgClient['query']>>;
const EMPTY: Answer = { rows: [], rowCount: 0 };
const statement = { text: 'select 1', params: [] };
const begin = [
	'begin',
	"select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '15s', true), set_config('idle_in_transaction_session_timeout', '5s', true)"
].join(';\n');
const hang = () => new Promise<Answer>(() => {});
/** A pool of one connection whose queries `answer` decides; what was sent and how it was released are recorded. */
function fake(answer: (text: string) => Promise<Answer>) {
	const sent: string[] = [],
		released: boolean[] = [];
	const client: PgClient = {
		query: (q) => (sent.push(q.text), answer(q.text)),
		release: (destroy) => {
			released.push(destroy === true);
		}
	};
	return { pool: { connect: async () => client }, sent, released };
}
/** A promise that settles when the fake receives `text`, and the answer that settles it. */
function reaching(text: string, then: () => Promise<Answer> = hang) {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		reached: promise,
		answer: (sent: string) => (sent === text ? (resolve(), then()) : Promise.resolve(EMPTY))
	};
}

describe('PostgresDb', () => {
	it.live('pool leak: an interrupted call destroys its connection instead of returning it', () =>
		Effect.gen(function* () {
			const r = reaching('select 1'),
				f = fake(r.answer);
			const call = yield* Effect.forkChild(PostgresDb.make(f.pool).read([statement]));
			yield* Effect.promise(() => r.reached);
			yield* Fiber.interrupt(call);
			expect(f.released).toEqual([true]);
		})
	);

	it.effect(
		'the wall: a call past LIMITS.callMs.database fails 57014 and destroys its connection',
		() =>
			Effect.gen(function* () {
				const r = reaching('select 1'),
					f = fake(r.answer);
				const call = yield* Effect.forkChild(PostgresDb.make(f.pool).read([statement]));
				yield* Effect.promise(() => r.reached);
				yield* TestClock.adjust(LIMITS.callMs.database);
				const error = yield* Effect.flip(Fiber.join(call));
				expect(error).toMatchObject({ _tag: 'DbError', sqlstate: '57014' });
				expect(f.released).toEqual([true]);
			})
	);

	it.live('a failed call fails with the SQLSTATE and returns its connection', () =>
		Effect.gen(function* () {
			const f = fake((text) =>
				text === statement.text
					? Promise.reject(
							Object.assign(new Error('duplicate key'), {
								code: '23505',
								constraint: 'customers_email'
							})
						)
					: Promise.resolve(EMPTY)
			);
			const error = yield* Effect.flip(PostgresDb.make(f.pool).write(statement));
			expect(error).toBeInstanceOf(DbError);
			expect(error).toMatchObject({
				sqlstate: '23505',
				constraint: 'customers_email',
				message: 'duplicate key'
			});
			expect(f.released).toEqual([false]);
		})
	);

	it.live('a transaction commits its SQL batch on one connection, its locks first', () =>
		Effect.gen(function* () {
			const f = fake((text) =>
				Promise.resolve(text === statement.text ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY)
			);
			const out = yield* PostgresDb.make(f.pool).transaction({
				statements: [statement],
				lock: { advisory: ['k'] }
			});
			expect(out).toEqual([{ rows: [{ n: 7 }], affected: 1 }]);
			expect(f.sent).toEqual([
				`${begin};\nselect pg_advisory_xact_lock(hashtext('k'))`,
				'select 1',
				'commit'
			]);
			expect(f.released).toEqual([false]);
		})
	);

	it.live('a transaction rolls back when a statement fails, and returns its connection', () =>
		Effect.gen(function* () {
			const f = fake((text) =>
				text === statement.text
					? Promise.reject(Object.assign(new Error('refused'), { code: 'P0001' }))
					: Promise.resolve(EMPTY)
			);
			const error = yield* Effect.flip(
				PostgresDb.make(f.pool).transaction({ statements: [statement] })
			);
			expect(error).toMatchObject({ _tag: 'DbError', sqlstate: 'P0001', message: 'refused' });
			expect(f.sent).toEqual([begin, 'select 1', 'rollback']);
			expect(f.released).toEqual([false]);
		})
	);

	it.live('a dry-run batch returns its results and rolls back instead of committing', () =>
		Effect.gen(function* () {
			const f = fake((text) =>
				Promise.resolve(text === statement.text ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY)
			);
			expect(
				yield* PostgresDb.make(f.pool).transaction({ statements: [statement], rollback: true })
			).toEqual([{ rows: [{ n: 7 }], affected: 1 }]);
			expect(f.sent).toEqual([begin, 'select 1', 'rollback']);
			expect(f.released).toEqual([false]);
		})
	);

	it.live('a failed rollback destroys the connection and retains the statement failure', () =>
		Effect.gen(function* () {
			const refused = DbError.make('23505', 'duplicate key');
			const f = fake((text) =>
				text === statement.text
					? Promise.reject(refused)
					: text === 'rollback'
						? Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }))
						: Promise.resolve(EMPTY)
			);
			const error = yield* Effect.flip(
				PostgresDb.make(f.pool).transaction({ statements: [statement] })
			);
			expect(error).toBe(refused);
			expect(f.sent).toEqual([begin, 'select 1', 'rollback']);
			expect(f.released).toEqual([true]);
		})
	);

	it.live(
		'an interrupted transaction destroys its connection: the server rolls back what it held',
		() =>
			Effect.gen(function* () {
				const r = reaching('select 1'),
					f = fake(r.answer);
				const call = yield* Effect.forkChild(
					PostgresDb.make(f.pool).transaction({ statements: [statement] })
				);
				yield* Effect.promise(() => r.reached);
				yield* Fiber.interrupt(call);
				expect(f.sent).toEqual([begin, 'select 1']);
				expect(f.released).toEqual([true]);
			})
	);
});

describe('typed reads', () => {
	const Claim = row('sys_run', ['id', 'state', 'attempts']);
	expectTypeOf<Row<'sys_run'>['key']>().toEqualTypeOf<string | null>();
	expectTypeOf<Row<'sys_run'>['attempts']>().toEqualTypeOf<number>();
	expectTypeOf<Row<'sys_message'>['integration']>().toEqualTypeOf<string | null>();
	expectTypeOf<Row<'sys_session'>['via']>().toEqualTypeOf<
		'code' | 'invitation' | 'signup' | 'host'
	>();
	expectTypeOf<Row<'sys_user'>['phone_key']>().toEqualTypeOf<string | null>();
	expectTypeOf<'id' extends keyof Row<'sys_config'> ? true : false>().toEqualTypeOf<false>();

	it.live("a system row decodes by its table's declaration; extra columns pass through", () =>
		Effect.gen(function* () {
			const f = fake(() =>
				Promise.resolve({
					rows: [{ id: 'r1', state: 'queued', attempts: 0, extra: true }],
					rowCount: 1
				})
			);
			expect(yield* PostgresDb.make(f.pool).rows(Claim, statement)).toEqual([
				{ id: 'r1', state: 'queued', attempts: 0, extra: true }
			]);
		})
	);

	it.live('a malformed system row is BoltError internal naming its table', () =>
		Effect.gen(function* () {
			const f = fake(() =>
				Promise.resolve({ rows: [{ id: 'r1', state: 7, attempts: 0 }], rowCount: 1 })
			);
			const error = yield* Effect.flip(PostgresDb.make(f.pool).rows(Claim, statement));
			expect(error).toBeInstanceOf(BoltError);
			expect(error).toMatchObject({ code: 'internal', phase: 'decode' });
			expect(error.message).toContain('sys_run');
		})
	);

	it.live('one answers at most one row; value the one column of the one row', () =>
		Effect.gen(function* () {
			const one = PostgresDb.make(
				fake(() => Promise.resolve({ rows: [{ n: 3 }], rowCount: 1 })).pool
			);
			expect(yield* one.value(Schema.Number, statement)).toBe(3);
			expect(
				Option.getOrNull(yield* one.one(Schema.Struct({ n: Schema.Number }), statement))
			).toEqual({ n: 3 });
			const none = PostgresDb.make(fake(() => Promise.resolve(EMPTY)).pool);
			expect(Option.isNone(yield* none.one(Schema.Struct({ n: Schema.Number }), statement))).toBe(
				true
			);
			expect(yield* Effect.flip(none.value(Schema.Number, statement))).toMatchObject({
				code: 'internal'
			});
			const two = PostgresDb.make(
				fake(() => Promise.resolve({ rows: [{ n: 1 }, { n: 2 }], rowCount: 2 })).pool
			);
			expect(
				yield* Effect.flip(two.one(Schema.Struct({ n: Schema.Number }), statement))
			).toMatchObject({ code: 'internal' });
		})
	);
});

describe('native transaction boundaries', () => {
	it.live('cancellation destroys the connection and remains interruption', () =>
		Effect.gen(function* () {
			const r = reaching('select 1'),
				f = fake(r.answer);
			const pending = yield* PostgresDb.make(f.pool).read([statement]).pipe(Effect.forkScoped);
			yield* Effect.promise(() => r.reached);
			yield* Fiber.interrupt(pending);
			const exit = yield* Fiber.await(pending);
			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(f.released).toEqual([true]);
		})
	);

	it.live('a native statement failure passes through unchanged and rolls back', () =>
		Effect.gen(function* () {
			const mine = DbError.make('22003', 'mine');
			const f = fake((text) =>
				text === statement.text ? Promise.reject(mine) : Promise.resolve(EMPTY)
			);
			const error = yield* Effect.flip(
				PostgresDb.make(f.pool).transaction({ statements: [statement] })
			);
			expect(error).toBe(mine);
			expect(f.sent).toEqual([begin, 'select 1', 'rollback']);
		})
	);

	it.live(
		'a failing native batch rolls back, preserves its typed failure, and the next transaction commits',
		() =>
			Effect.gen(function* () {
				const refused = DbError.make('P0001', 'refused');
				const f = fake((text) =>
						text === statement.text
							? Promise.reject(refused)
							: Promise.resolve(text === 'select 7' ? { rows: [{ n: 7 }], rowCount: 1 } : EMPTY)
					),
					db = PostgresDb.make(f.pool);
				expect(yield* Effect.flip(db.transaction({ statements: [statement] }))).toBe(refused);
				expect(f.sent).toEqual([begin, 'select 1', 'rollback']);
				expect(yield* db.transaction({ statements: [{ text: 'select 7', params: [] }] })).toEqual([
					{ rows: [{ n: 7 }], affected: 1 }
				]);
				expect(f.sent.slice(3)).toEqual([begin, 'select 7', 'commit']);
				expect(f.released).toEqual([false, false]);
			})
	);
});
