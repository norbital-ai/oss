/// <reference types="node" />
// Schema on a real Postgres (PGlite 18): verified SQL migrations, one test per guarantee.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import { DbError } from '@norbital-ai/host-api';
import { from_store } from '../src/protocol/errors.ts';
import { PgliteDb } from '@norbital-ai/host-api/node';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { constraint_index } from '@norbital-ai/store';
import { plan, read_applied, type SchemaSlice } from '../src/engine/schema/plan.ts';
import { apply_migrations } from '../src/engine/schema/migrations.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};
let db: TenantDbShape;
const U = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const exec = (text: string, params: readonly (string | number | null)[] = []) =>
	db.write({ text, params });
// the slice's constraint index, built once: the writer's own map is per manifest, not per refusal
const index = Effect.runSync(
	Effect.cached(constraint_index(slice()).pipe(Effect.mapError(from_store)))
);
const refusal = Effect.fnUntraced(function* (p: Effect.Effect<unknown, DbError>) {
	const e = yield* Effect.flip(p);
	expect(e).toBeInstanceOf(DbError);
	return refusalOf(e, yield* index);
});
const migrate = Effect.fnUntraced(function* (s: SchemaSlice, accept?: true | readonly string[]) {
	const p = yield* plan(yield* read_applied(db), s);
	yield* TestDb.migrate(db, s, accept === undefined ? {} : { accept });
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
	db = TenantDb.typed(PgliteDb.make(yield* TestDb.open(slice())));
});
describe('next schema on PGlite', () => {
	it.live(
		'applies the empty-database plan with the built-in tables; re-planning is empty and keeps rows',
		() =>
			Effect.gen(function* () {
				yield* setup();
				const applied = present(yield* read_applied(db)), held = JSON.parse(JSON.stringify(slice()));
				expect({ original: applied.original, schema: applied.schema }).toEqual({ original: held, schema: held });
				expect((yield* plan(yield* read_applied(db), slice())).steps).toEqual([]);

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
			const row = Schema.decodeUnknownSync(Schema.Struct({
				placed: Schema.String, due: Schema.String, month: Schema.String, label: Schema.String
			}))(r?.rows[0]);
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
			).toMatchObject({ code: 'missing_ref', field: 'customer' });
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
			).toMatchObject({ code: 'invalid_input', field: 'status' });
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
describe('runtime connections survive source schema changes', () => {
	it.live('preserves every account and its state instead of reconstructing source slots', () =>
		Effect.gen(function* () {
			yield* setup();
			yield* exec(`INSERT INTO sys_integration (id,integration,name,active,configuration) VALUES
				('mail','email','Support inbox',true,'{"folder":"in"}'),
				('desk','whatsapp','Sales line',true,'{}'),
				('ops','telegram','Operations',false,'{"lag":15}')`);
			yield* exec(`INSERT INTO bolt_credential (instance,name,sealed) VALUES ('mail','creds','sealed-original')`);
			yield* exec(`INSERT INTO sys_conversation (id,integration) VALUES ('c1','mail')`);
			yield* exec(`INSERT INTO sys_message (id,conversation,seq,integration) VALUES ('m1','c1',1,'mail')`);
			const rows = () => db.rows(
				Schema.Struct({ id: Schema.String, integration: Schema.String, name: Schema.String, active: Schema.Boolean, configuration: Schema.Json }),
				{ text: 'SELECT id,integration,name,active,configuration FROM sys_integration ORDER BY id', params: [] }
			);
			const before = yield* rows();
			const current = slice(), notes = current.tables.notes;
			if (notes === undefined) throw new Error('Missing notes schema');
			yield* migrate({
				...current,
				tables: { ...current.tables, notes: { ...notes, fields: { ...notes.fields, reviewed: { kind: 'bool', default: false } } } }
			});
			expect(yield* rows()).toEqual(before);
			expect(yield* db.rows(Schema.Struct({ sealed: Schema.String }), {
				text: "SELECT sealed FROM bolt_credential WHERE instance='mail'", params: []
			})).toEqual([{ sealed: 'sealed-original' }]);
			expect(yield* db.value(Schema.Number, {
				text: "SELECT count(*)::int FROM sys_message WHERE id='m1' AND integration='mail' AND conversation='c1'", params: []
			})).toBe(1);
			// Reapplying the same source cannot activate, rename, delete or reset any runtime account.
			yield* migrate({
				...current,
				tables: { ...current.tables, notes: { ...notes, fields: { ...notes.fields, reviewed: { kind: 'bool', default: false } } } }
			});
			expect(yield* rows()).toEqual(before);
		})
	);
});
// Last: its DDL changes the catalogs, so the pooled database reloads afresh for whatever runs after it.
describe('schema changes on a populated database', () => {
	it.live(
		'refuses a populated required column, applies it with a default and refuses a stale SQL history',
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
							...present(s.tables.notes),
							fields: { ...present(s.tables.notes).fields, pinned: { kind: 'bool' } }
						}
					}
				};
				yield* exec(
					`insert into notes (id, body, about__customers) values ($1, 'a', $2), ($3, 'b', $2)`,
					[U(40), U(1), U(41)]
				);
				const p = yield* plan(yield* read_applied(db), next);
				expect(p.steps.find((x) => x.id === 'create:notNull:notes.pinned')?.class).toBe(
					'validating'
				);
				const e = yield* Effect.flip(TestDb.migrate(db, next));
				expect(e).toBeInstanceOf(DbError);
				expect(e.message).toContain('notNull:notes.pinned refuses 2 existing row');
				const kept = present(yield* read_applied(db)), before = JSON.parse(JSON.stringify(s));
				expect({ original: kept.original, schema: kept.schema }).toEqual({ original: before, schema: before });
				// with a default the same change applies
				const withDefault: SchemaSlice = {
					...s,
					tables: {
						...s.tables,
						notes: {
							...present(s.tables.notes),
							fields: { ...present(s.tables.notes).fields, pinned: { kind: 'bool', default: false } }
						}
					}
				};
				yield* migrate(withDefault);
				const [r] = yield* db.read([
					{ text: 'select count(*)::int as n from notes where pinned = false', params: [] }
				]);
				expect(r?.rows[0]?.n).toBe(2);
				// A prepared SQL history refuses a database that applied a different successor in the meantime.
				const target = { ...withDefault, tz: 'UTC' };
				const stale = yield* TestDb.prepare_migrations(db, target);
				yield* migrate({ ...withDefault, tz: 'Europe/Paris' });
				expect(yield* Effect.flip(apply_migrations(db, target, stale))).toMatchObject({
					code: 'migration_changed'
				});
			})
	);
});
