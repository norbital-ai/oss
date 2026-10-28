/// <reference types="node" />
// Schema on a real Postgres (PGlite 18): the empty-DB plan, one test per §5.2 / rule 68–69 guarantee.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { TenantDbShape as TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError, fromStore } from '../src/protocol/errors.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../src/test/database.ts';
import { constraintIndex } from '@norbital-ai/store';
import {
	applyPlan,
	plan,
	readApplied,
	type SchemaSlice
} from '../src/engine/schema/plan.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';
let db: TenantDb;
const U = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const exec = (text: string, params: readonly (string | number | null)[] = []) =>
	db.write({ text, params });
// the slice's constraint index, built once: the writer's own map is per manifest, not per refusal
const index = Effect.runSync(Effect.cached(constraintIndex(slice()).pipe(Effect.mapError(fromStore))));
const refusal = Effect.fnUntraced(function* (p: Effect.Effect<unknown, DbError>) {
	const e = yield* Effect.flip(p);
	expect(e).toBeInstanceOf(DbError);
	return refusalOf(e, yield* index);
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
	db = PgliteDb.make(yield* TestDb.open(slice()));
});
describe('next schema on PGlite', () => {
	it.live(
		'applies the empty-database plan with the built-in tables; re-planning is empty and keeps rows',
		() =>
			Effect.gen(function* () {
				yield* setup();
				expect(yield* readApplied(db)).toEqual(JSON.parse(JSON.stringify(slice())));
				expect((yield* plan(yield* readApplied(db), slice())).steps).toEqual([]);

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
			})
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
		})
	);
	it.live('maps every constraint violation, excess precision and a broken arc to its refusal', () =>
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
		})
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
			})
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
				// no connections at all: every named row goes with its credentials and messages; the run-time instance stays
				yield* exec(
					`insert into bolt_credential (instance, name, sealed) values ('mail', 'creds', 'x')`
				);
				yield* exec(`insert into sys_conversation (id, integration) values ('c1', 'mail')`);
				yield* exec(
					`insert into sys_message (id, conversation, seq, integration) values ('m1', 'c1', 1, 'mail')`
				);
				yield* migrate(slice());
				expect((yield* rows()).map((r) => r['id'])).toEqual([run]);
				const [left] = yield* db.read([
					{
						text: `select (select count(*) from bolt_credential)::int
			+ (select count(*) from sys_conversation)::int + (select count(*) from sys_message)::int as n`,
						params: []
					}
				]);
				expect(left?.rows[0]?.n).toBe(0);
			})
	);
});
// Last: its DDL changes the catalogs, so the pooled database reloads afresh for whatever runs after it.
describe('schema changes on a populated database', () => {
	it.live(
		'refuses a populated required column, applies it with a default and refuses a stale plan',
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
				// destructive acceptance is plan-level (schema.test); a plan from a schema that moved since is refused here
				const stale = yield* plan(yield* readApplied(db), { ...withDefault, tz: 'UTC' });
				yield* migrate({ ...withDefault, tz: 'Europe/Paris' });
				expect(yield* Effect.flip(applyPlan(db, stale))).toMatchObject({ code: 'schemaMoved' });
			})
	);
});
