/// <reference types="node" />
// Schema on a real Postgres (PGlite 18): the empty-DB plan, one test per §5.2 / rule 68–69 guarantee.
import type { PGlite, Results } from '@electric-sql/pglite';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { TenantDbShape as TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError, fromStore } from '../src/protocol/errors.ts';
import { tableOf } from '../src/protocol/catalog.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { PostgresDb, type PgClient } from '../src/node/db/postgres.ts';
import { constraintIndex } from '@norbital-ai/store';
import {
	applyPlan,
	destructiveSteps,
	plan,
	readApplied,
	type SchemaSlice
} from '../src/engine/schema/plan.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';
let db: TenantDb;
let pg: PGlite;
const postgresResult = (result: Results<unknown>) => ({
	rows: [
		...Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
			result.rows
		)
	],
	rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length
});
const U = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const exec = (text: string, params: readonly (string | number | null)[] = []) =>
	db.write({ text, params });
const refusal = Effect.fnUntraced(function* (
	p: Effect.Effect<unknown, DbError>,
	s: SchemaSlice = slice()
) {
	const e = yield* Effect.flip(p);
	expect(e).toBeInstanceOf(DbError);
	return refusalOf(e, yield* constraintIndex(s).pipe(Effect.mapError(fromStore)));
});
const migrate = Effect.fnUntraced(function* (s: SchemaSlice, accept?: true | readonly string[]) {
	const p = yield* plan(yield* readApplied(db), s);
	yield* applyPlan(db, p, accept === undefined ? {} : { accept });
	return p;
});
const seed = Effect.fnUntraced(function* () {
	yield* exec(
		`insert into customers (id, name, email) values ($1, 'Ada', 'ada@x.io'), ($2, 'Bob', null)`,
		[U(1), U(2)]
	);
	yield* exec(
		`insert into orders (id, customer, code, total, qty) values ($1, $2, 'SO-1', '10.50', 3)`,
		[U(10), U(1)]
	);
});
const setup = Effect.fnUntraced(function* () {
	pg = yield* PgliteDb.open();
	db = PgliteDb.make(pg);
	yield* migrate(slice());
});
describe('next schema on PGlite', () => {
	it.live('applies the empty-database plan and records the slice; planning again is empty', () =>
		Effect.gen(function* () {
			yield* setup();
			expect(yield* readApplied(db)).toEqual(JSON.parse(JSON.stringify(slice())));
			expect((yield* plan(yield* readApplied(db), slice())).steps).toEqual([]);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		"the empty-database plan creates the built-in layer's and the engine's tables; a re-apply keeps them and their rows",
		() =>
			Effect.gen(function* () {
				yield* setup();
				const [t] = yield* db.read([
					{
						text: `select count(*)::int as n from pg_tables where tablename in ('sys_user', 'sys_run', 'sys_message', 'approval_request', 'bolt_idem')`,
						params: []
					}
				]);
				expect(t?.rows[0]?.n).toBe(5);
				yield* exec(`insert into sys_user (id, name) values ('u1', 'Ada')`);
				const again = yield* migrate(slice());
				expect(again.steps).toEqual([]);
				const [u] = yield* db.read([
					{ text: `select name from sys_user where id = 'u1'`, params: [] }
				]);
				expect(u?.rows).toEqual([{ name: 'Ada' }]);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		're-planning after the slice round-trips through jsonb is empty; an unrelated field refreshes its native guard',
		() =>
			Effect.gen(function* () {
				yield* setup();
				// `bolt_schema.slice` is jsonb: `states` and predicate fields come back in another key order than declared
				const s: SchemaSlice = {
					...slice(),
					tables: {
						...slice().tables,
						signings: tableOf({
							description: 'signings',
							label: 'status',
							fields: {
								status: {
									kind: 'state',
									initial: 'unstamped',
									states: {
										unstamped: { to: ['voided'] },
										counterparty_stamped: {},
										acknowledged: {},
										voided: {}
									}
								},
								reason: { kind: 'text', optional: true }
							},
							check: {
								void_needs_reason: {
									status: { ne: 'voided', in: ['unstamped', 'voided'] },
									reason: { isNull: false }
								}
							}
						})
					}
				};
				yield* migrate(s);
				expect((yield* plan(yield* readApplied(db), s)).steps).toEqual([]);
				const signings = s.tables.signings!;
				const next: SchemaSlice = {
					...s,
					tables: {
						...s.tables,
						signings: {
							...signings,
							fields: { ...signings.fields, nickname: { kind: 'text', optional: true } }
						}
					}
				};
				expect((yield* migrate(next)).steps.map((x) => x.id).sort()).toEqual([
					'create:column:signings.nickname',
					'replace:trigger:signings.store_row_rules'
				]);
				expect((yield* plan(yield* readApplied(db), next)).steps).toEqual([]);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('computes every operator immutably and emits JSON values', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			const [r] = yield* db.read([{ text: `select * from orders where id = $1`, params: [U(10)] }]);
			expect(r?.rows[0]).toMatchObject({
				gross: '11.45',
				total: '10.50',
				qty: 3,
				big: false,
				per: expect.stringMatching(/^3\.5/),
				status: 'open',
				slug: 'so-1',
				head: 'SO',
				placed: expect.stringMatching(/^\d{4}-\d\d-\d\d$/),
				at: expect.stringMatching(/Z$/)
			});
			const row = r?.rows[0] as {
				placed: string;
				due: string;
				month: string;
				label: string;
			};
			expect(row.label).toBe(`SO-1 / ${row.placed} / 3`);
			expect(row.month).toBe(`${row.placed.slice(0, 8)}01`);
			const [c] = yield* db.read([
				{
					text: `select bolt_search::text as doc, tags from customers where id = $1`,
					params: [U(1)]
				}
			]);
			expect(c?.rows[0]).toEqual({ doc: `'#ad' 'ada'`, tags: [] }); // the multilingual document: the word and its Latin skeleton
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('maps every constraint violation to its refusal through the constraint name', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			expect(
				yield* refusal(exec(`insert into customers (id, name) values ($1, 'Ada')`, [U(3)]))
			).toMatchObject({ code: 'unique', field: 'name' });
			expect(
				yield* refusal(
					exec(`insert into customers (id, name, email) values ($1, 'Cy', 'ada@x.io')`, [U(3)])
				)
			).toMatchObject({ code: 'unique', field: 'email' });
			expect(
				yield* refusal(
					exec(`insert into customers (id, name, email) values ($1, 'Cy', 'nope')`, [U(3)])
				)
			).toMatchObject({ code: 'check', field: 'email' });
			expect(
				yield* refusal(
					exec(`insert into customers (id, name) values ($1, 'a name that is far too long')`, [
						U(3)
					])
				)
			).toMatchObject({ code: 'check', field: 'name' });
			expect(
				yield* refusal(
					exec(
						`insert into orders (id, customer, code, total, qty) values ($1, $2, 'SO-2', '1', 1)`,
						[U(11), U(99)]
					)
				)
			).toMatchObject({ code: 'missingRef', field: 'customer' });
			// Orders are owned and cascade; a non-owned term is the referer that restricts deletion.
			yield* exec(
				`insert into terms (id, customer, period) values ($1, $2, daterange('2026-01-01', '2026-01-02'))`,
				[U(30), U(1)]
			);
			expect(yield* refusal(exec(`delete from customers where id = $1`, [U(1)]))).toMatchObject({
				code: 'restricted'
			});
			expect(
				(yield* db.read([
					{
						text: `select exists(select 1 from customers where id = $1) as customer,
					exists(select 1 from orders where id = $2) as owned_order,
					exists(select 1 from terms where id = $3) as restricting_term`,
						params: [U(1), U(10), U(30)]
					}
				]))[0]?.rows
			).toEqual([{ customer: true, owned_order: true, restricting_term: true }]);
			expect(
				yield* refusal(
					exec(`insert into orders (id, code, total, qty) values ($1, 'SO-2', '1', 1)`, [U(11)])
				)
			).toMatchObject({ code: 'required', field: 'customer' });
			expect(
				yield* refusal(exec(`update orders set status = 'closed', qty = 0 where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', message: expect.stringContaining('closed_has_qty') });
			expect(
				yield* refusal(exec(`update orders set status = 'lost' where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', field: 'status' });
			expect(
				yield* refusal(exec(`update orders set qty = 3000000000 where id = $1`, [U(10)]))
			).toMatchObject({ code: 'overflow' });
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('money and decimals refuse excess precision instead of rounding (rule 68)', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			expect(
				yield* refusal(exec(`update orders set total = '1.005' where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', field: 'total' });
			expect(
				yield* refusal(exec(`update orders set jpy = '1.5' where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', field: 'jpy' });
			expect(
				yield* refusal(exec(`update orders set rate = '1.234' where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', field: 'rate' });
			expect(
				yield* refusal(exec(`update orders set rate = '1000' where id = $1`, [U(10)]))
			).toMatchObject({ code: 'check', field: 'rate' });
			yield* exec(`update orders set jpy = '150', rate = '999.99' where id = $1`, [U(10)]);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('an exclusive arc takes exactly one target', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			yield* exec(`insert into notes (id, body, about__orders) values ($1, 'hi', $2)`, [
				U(20),
				U(10)
			]);
			expect(
				yield* refusal(exec(`insert into notes (id, body) values ($1, 'none')`, [U(21)]))
			).toMatchObject({ code: 'check', field: 'about' });
			expect(
				yield* refusal(
					exec(
						`insert into notes (id, body, about__orders, about__customers) values ($1, 'two', $2, $3)`,
						[U(21), U(10), U(1)]
					)
				)
			).toMatchObject({ code: 'check', field: 'about' });
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'noOverlap: null is a value, periods are valid, and a successor may close its predecessor in one statement',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* seed();
				const term = (
					id: number,
					from: string,
					to: string | null,
					scope: string | null,
					grade: string | null,
					customer = U(1)
				) =>
					exec(
						`insert into terms (id, customer, period, scope, grade) values ($1, $2, daterange($3::date, $4::date, '[]'), $5, $6)`,
						[U(id), customer, from, to, scope, grade]
					);
				yield* term(30, '2024-01-01', null, null, 'g30');
				expect(yield* refusal(term(31, '2024-06-01', null, null, 'g31'))).toMatchObject({
					code: 'overlap'
				});
				yield* term(31, '2024-06-01', null, 'other', 'g31');
				expect(
					yield* refusal(
						exec(`insert into terms (id, customer, period) values ($1, $2, 'empty')`, [U(32), U(1)])
					)
				).toMatchObject({ code: 'check', field: 'period' });
				// successor first, predecessor closed after, in one statement: the EXCLUDE is deferrable
				yield* exec(
					`with s as (insert into terms (id, customer, period, grade) values ($1, $2, daterange('2025-01-01', null, '[]'), 'g33') returning id)
			update terms set period = daterange('2024-01-01', '2024-12-31', '[]') where id = $3`,
					[U(33), U(1), U(30)]
				);
				// composite unique: a null grade is a value
				yield* term(34, '2030-01-01', '2030-01-02', 'a', null);
				expect(yield* refusal(term(35, '2031-01-01', '2031-01-02', 'b', null))).toMatchObject({
					code: 'unique'
				});
				// a partial unique is an EXCLUDE and reports as `unique`
				yield* term(36, '2032-01-01', '2032-01-02', 'x', 'g1');
				expect(yield* refusal(term(37, '2033-01-01', '2033-01-02', 'x', 'g1', U(2)))).toMatchObject(
					{ code: 'unique', message: expect.stringContaining('one_x_grade') }
				);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('builds the search GIN, the vector HNSW and the point GiST indexes', () =>
		Effect.gen(function* () {
			yield* setup();
			const [r] = yield* db.read([
				{
					text: `select indexdef from pg_indexes where tablename = 'customers' order by 1`,
					params: []
				}
			]);
			const defs = r?.rows.map((x) => String(x.indexdef)).join('\n');
			expect(defs).toMatch(/USING gin \(bolt_search\)/);
			expect(defs).toMatch(/USING hnsw \(colour vector_l2_ops\)/);
			expect(defs).toMatch(/USING gist \(place\)/);
			expect(defs).toMatch(/USING gin \(tags\)/);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'a required column on a populated table is refused naming the constraint and row count; nothing changes',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* seed();
				const s = slice();
				const next: SchemaSlice = {
					...s,
					tables: {
						...s.tables,
						notes: {
							...s.tables.notes!,
							fields: { ...s.tables.notes!.fields, pinned: { kind: 'bool' } }
						}
					}
				};
				yield* exec(
					`insert into notes (id, body, about__customers) values ($1, 'a', $2), ($3, 'b', $2)`,
					[U(40), U(1), U(41)]
				);
				const p = yield* plan(yield* readApplied(db), next);
				expect(p.steps.find((x) => x.id === 'create:notNull:notes.pinned')?.class).toBe(
					'validating'
				);
				const e = yield* applyPlan(db, p).pipe(Effect.catch((x) => Effect.succeed(x)));
				expect(e).toBeInstanceOf(BoltError);
				expect((e as BoltError).message).toBe('notNull:notes.pinned refuses 2 existing rows');
				expect(yield* readApplied(db)).toEqual(JSON.parse(JSON.stringify(s)));
				// with a default the same change applies
				const withDefault: SchemaSlice = {
					...s,
					tables: {
						...s.tables,
						notes: {
							...s.tables.notes!,
							fields: { ...s.tables.notes!.fields, pinned: { kind: 'bool', default: false } }
						}
					}
				};
				yield* migrate(withDefault);
				const [r] = yield* db.read([
					{ text: 'select count(*)::int as n from notes where pinned = false', params: [] }
				]);
				expect(r?.rows[0]?.n).toBe(2);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('a destructive step needs acceptance; accepted, it drops the column', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			const s = slice();
			const { note: _, ...fields } = s.tables.orders!.fields;
			const next: SchemaSlice = {
				...s,
				tables: { ...s.tables, orders: { ...s.tables.orders!, fields } }
			};
			expect(yield* destructiveSteps(s, next)).toEqual(['drop:column:orders.note']);
			expect(yield* Effect.flip(migrate(next))).toMatchObject({ code: 'destructiveNotAccepted' });
			yield* migrate(next, ['drop:column:orders.note']);
			const [r] = yield* db.read([
				{
					text: `select count(*)::int as n from information_schema.columns where table_name = 'orders' and column_name = 'note'`,
					params: []
				}
			]);
			expect(r?.rows[0]?.n).toBe(0);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'a new roll-up is backfilled from existing children; a changed enum is validated against rows',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* seed();
				const s = slice();
				const cust = s.tables.customers!;
				const next: SchemaSlice = {
					...s,
					tables: {
						...s.tables,
						customers: {
							...cust,
							fields: {
								...cust.fields,
								all_orders: { kind: 'count', of: 'orders' },
								tags: { kind: 'enum', values: ['new'], many: true, default: [] }
							}
						}
					}
				};
				yield* exec(`update customers set tags = '{vip}' where id = $1`, [U(1)]);
				const p = yield* plan(yield* readApplied(db), next);
				expect(p.steps.find((x) => x.id === 'create:backfill:customers.all_orders')?.class).toBe(
					'backfill'
				);
				expect(yield* Effect.flip(applyPlan(db, p))).toMatchObject({
					code: 'schemaInvalid',
					message: expect.stringMatching(/refuses 1 existing row$/)
				});
				yield* exec(`update customers set tags = '{}'`);
				yield* applyPlan(db, yield* plan(yield* readApplied(db), next));
				const [r] = yield* db.read([
					{ text: 'select all_orders from customers where id = $1', params: [U(1)] }
				]);
				expect(r?.rows[0]?.all_orders).toBe(1);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('a plan made against an older schema is refused once another apply has moved it', () =>
		Effect.gen(function* () {
			yield* setup();
			const s = slice();
			const stale = yield* plan(yield* readApplied(db), { ...s, tz: 'UTC' });
			yield* migrate({ ...s, tz: 'Europe/Paris' });
			expect(yield* Effect.flip(applyPlan(db, stale))).toMatchObject({ code: 'schemaMoved' });
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'write takes the sorted table and advisory locks in the same transaction as its statement',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* seed();
				const r = yield* db.write(
					{
						text: `select count(*)::int as n from pg_locks where locktype in ('relation', 'advisory') and granted and mode in ('ShareRowExclusiveLock', 'ExclusiveLock')`,
						params: []
					},
					{ tables: ['orders', 'customers'], advisory: ['k'] }
				);
				expect(r.rows[0]?.n).toBeGreaterThanOrEqual(3);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live(
		'the node-postgres adapter bounds each batch, shares its connection and rolls back failed writes',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* seed();
				const calls: Parameters<PgClient['query']>[0][] = [];
				const released: boolean[] = [];
				let acquired = 0;
				const client: PgClient = {
					async query(q) {
						calls.push(q);
						if (q.values !== undefined)
							return pg.query<unknown>(q.text, q.values).then(postgresResult);
						return (await pg.exec(q.text)).map(postgresResult);
					},
					release(destroy) {
						released.push(destroy ?? false);
					}
				};
				const remote = PostgresDb.make({
					connect: async () => {
						acquired++;
						return client;
					}
				});
				const rows = yield* remote.read([
					{ text: 'select name from customers where id = $1', params: [U(1)] },
					{
						text: `select code from orders where customer = $1 and code = $2`,
						params: [U(1), 'SO-1']
					}
				]);
				expect(rows.map((r) => r.rows)).toEqual([[{ name: 'Ada' }], [{ code: 'SO-1' }]]);
				expect(calls).toHaveLength(4);
				expect(calls[0]?.text.split(';\n')).toEqual([
					'begin isolation level repeatable read read only',
					"set local lock_timeout = '5s'",
					"set local statement_timeout = '15s'",
					"set local idle_in_transaction_session_timeout = '5s'"
				]);
				expect(calls.slice(1, 3).map(({ text, values }) => ({ text, values }))).toEqual([
					{ text: 'select name from customers where id = $1', values: [U(1)] },
					{
						text: 'select code from orders where customer = $1 and code = $2',
						values: [U(1), 'SO-1']
					}
				]);
				expect(calls[3]?.text).toBe('commit');
				expect(acquired).toBe(1);
				expect(released).toEqual([false]);
				const w = yield* remote.write(
					{
						text: `update customers set name = $1 where id = $2 returning name`,
						params: ["O'Brien", U(2)]
					},
					{ tables: ['customers'], advisory: ['x'] }
				);
				expect(w.rows).toEqual([{ name: "O'Brien" }]);
				expect(calls).toHaveLength(7);
				expect(calls[4]?.text).toMatch(/^begin;/i);
				expect(calls[4]?.text).toContain('lock table "customers" in SHARE ROW EXCLUSIVE mode');
				expect(calls[4]?.text).toContain('pg_advisory_xact_lock');
				expect(calls[5]).toMatchObject({
					text: 'update customers set name = $1 where id = $2 returning name',
					name: expect.stringMatching(/^b/),
					values: ["O'Brien", U(2)]
				});
				expect(calls[6]?.text).toBe('commit');
				expect(
					yield* Effect.flip(
						remote.write({
							text: `insert into customers (id, name) values ($1, 'Ada')`,
							params: [U(5)]
						})
					)
				).toMatchObject({ sqlstate: '23505' });
				expect(calls.at(-1)?.text).toBe('rollback');
				expect(acquired).toBe(3);
				expect(released).toEqual([false, false, false]);
				expect(
					(yield* db.read([
						{
							text: 'select name from customers order by id',
							params: []
						}
					]))[0]?.rows
				).toEqual([{ name: 'Ada' }, { name: "O'Brien" }]);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('locked writes bind a stable statement name after acquiring bounded locks', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			const calls: Parameters<PgClient['query']>[0][] = [];
			const client: PgClient = {
				async query(q) {
					calls.push(q);
					if (q.values !== undefined)
						return pg.query<unknown>(q.text, q.values).then(postgresResult);
					return (await pg.exec(q.text)).map(postgresResult);
				},
				release() {}
			};
			const remote = PostgresDb.make({ connect: async () => client });
			const sql = {
				text: `update customers set name = $1 where id = $2 returning name`,
				params: ['Eve', U(1)]
			};
			const lock = { tables: ['customers'] as const };
			expect((yield* remote.write(sql, lock)).rows).toEqual([{ name: 'Eve' }]);
			expect(calls.map((q) => q.text)).toEqual([
				expect.stringMatching(/^begin;/i),
				sql.text,
				'commit'
			]);
			expect(calls[0]?.text).toContain("set local statement_timeout = '15s'");
			expect(calls[0]?.text).toContain('lock table "customers" in SHARE ROW EXCLUSIVE mode');
			expect(calls[1]).toMatchObject({ name: expect.stringMatching(/^b/), values: ['Eve', U(1)] });
			expect((yield* remote.write({ ...sql, params: ['Fay', U(1)] }, lock)).rows).toEqual([
				{ name: 'Fay' }
			]);
			expect(calls.slice(3).map((q) => q.text)).toEqual([
				expect.stringMatching(/^begin;/i),
				sql.text,
				'commit'
			]);
			expect(calls[3]?.text).toContain('lock table "customers" in SHARE ROW EXCLUSIVE mode');
			expect(calls[4]?.name).toBe(calls[1]?.name);
			expect(calls[4]?.values).toEqual(['Fay', U(1)]);
			expect(
				(yield* db.read([
					{
						text: 'select name from customers where id = $1',
						params: [U(1)]
					}
				]))[0]?.rows
			).toEqual([{ name: 'Fay' }]);
		}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('an unlocked write binds its named statement between native deadlines and commit', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* seed();
			const seen: Parameters<PgClient['query']>[0][] = [];
			const client: PgClient = {
				async query(q) {
					seen.push(q);
					if (q.values !== undefined)
						return pg.query<unknown>(q.text, q.values).then(postgresResult);
					return (await pg.exec(q.text)).map(postgresResult);
				},
				release() {}
			};
			const remote = PostgresDb.make({ connect: async () => client });
			const w = yield* remote.write({
				text: `update customers set name = $1 where id = $2 returning name`,
				params: ['Ada 2', U(1)]
			});
			expect(w.rows).toEqual([{ name: 'Ada 2' }]);
			expect(seen).toHaveLength(3);
			expect(seen[0]?.text).toMatch(/^begin;/i);
			expect(seen[0]?.text).toContain("set local statement_timeout = '15s'");
			expect(seen[0]?.text).not.toMatch(/lock table|pg_advisory_xact_lock/i);
			expect(seen[1]).toMatchObject({
				text: 'update customers set name = $1 where id = $2 returning name',
				name: expect.stringMatching(/^b/),
				values: ['Ada 2', U(1)]
			});
			expect(seen[2]?.text).toBe('commit');
			expect(
				(yield* db.read([
					{
						text: 'select name from customers where id = $1',
						params: [U(1)]
					}
				]))[0]?.rows
			).toEqual([{ name: 'Ada 2' }]);
		}).pipe(Effect.provide(Pristine.layer))
	);
});
describe('source:connections: a connection is its named instance', () => {
	const rows = Effect.fnUntraced(function* () {
		return (yield* db.read([
			{
				text: `select id, integration, name, named, envoy, active, configuration from sys_integration order by id`,
				params: []
			}
		]))[0]!.rows;
	});
	const c = {};
	const run = U(90);
	it.live(
		'inserts each slot once with its configuration, keeps run-time edits and unnamed instances, deletes a dropped slot and replaces a slot moved to another definition',
		() =>
			Effect.gen(function* () {
				yield* setup();
				yield* migrate({
					...slice(),
					connections: {
						mail: { integration: 'email', configuration: c },
						desk: { integration: 'whatsapp', envoy: 'desk', configuration: c },
						ops: { integration: 'telegram', configuration: { lag: 15 } }
					}
				});
				expect(yield* rows()).toEqual([
					{
						id: 'desk',
						integration: 'whatsapp',
						name: 'desk',
						named: true,
						envoy: 'desk',
						active: true,
						configuration: {}
					},
					{
						id: 'mail',
						integration: 'email',
						name: 'mail',
						named: true,
						envoy: null,
						active: true,
						configuration: {}
					},
					{
						id: 'ops',
						integration: 'telegram',
						name: 'ops',
						named: true,
						envoy: null,
						active: true,
						configuration: { lag: 15 }
					}
				]);
				// run time: an instance created in the UI, and the default envoy, name and configuration of a named one changed
				yield* exec(
					`insert into sys_integration (id, integration, name) values ($1, 'whatsapp', 'Sales line')`,
					[run]
				);
				yield* exec(
					`update sys_integration set envoy = null, name = 'Support inbox', configuration = '{"folder":"in"}' where id = 'mail'`
				);
				const p = yield* migrate({
					...slice(),
					connections: {
						mail: { integration: 'email', envoy: 'desk', configuration: { folder: 'all' } },
						ops: { integration: 'slack', configuration: c },
						alerts: { integration: 'telegram', configuration: c }
					}
				});
				expect(p.steps.map((s) => s.id)).toEqual(['replace:source:connections']);
				expect(yield* rows()).toEqual(
					[
						{
							id: run,
							integration: 'whatsapp',
							name: 'Sales line',
							named: false,
							envoy: null,
							active: true,
							configuration: {}
						},
						{
							id: 'alerts',
							integration: 'telegram',
							name: 'alerts',
							named: true,
							envoy: null,
							active: true,
							configuration: {}
						},
						{
							id: 'mail',
							integration: 'email',
							name: 'Support inbox',
							named: true,
							envoy: null,
							active: true,
							configuration: { folder: 'in' }
						},
						{
							id: 'ops',
							integration: 'slack',
							name: 'ops',
							named: true,
							envoy: null,
							active: true,
							configuration: {}
						}
					].sort((a, b) => (a.id < b.id ? -1 : 1))
				);
				// no connections at all: every named row goes, the run-time instance stays
				yield* migrate(slice());
				expect((yield* rows()).map((r) => r['id'])).toEqual([run]);
			}).pipe(Effect.provide(Pristine.layer))
	);
	it.live('a deleted instance takes its credentials and messages with it', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* migrate({
				...slice(),
				connections: { mail: { integration: 'email', configuration: c } }
			});
			yield* exec(
				`insert into bolt_credential (instance, name, sealed) values ('mail', 'creds', 'x')`
			);
			yield* exec(`insert into sys_conversation (id, integration) values ('c1', 'mail')`);
			yield* exec(
				`insert into sys_message (id, conversation, seq, integration) values ('m1', 'c1', 1, 'mail')`
			);
			yield* migrate(slice());
			const [left] = yield* db.read([
				{
					text: `select (select count(*) from bolt_credential)::int
			+ (select count(*) from sys_conversation)::int + (select count(*) from sys_message)::int as n`,
					params: []
				}
			]);
			expect(left?.rows[0]?.n).toBe(0);
		}).pipe(Effect.provide(Pristine.layer))
	);
});
