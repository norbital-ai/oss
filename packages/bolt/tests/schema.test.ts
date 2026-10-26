/// <reference types="node" />
import { describe, expect, it } from '@effect/vitest';
import { Effect, Result, Schema } from 'effect';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError, storeSync } from '../src/protocol/errors.ts';
import { tableOf } from '../src/protocol/catalog.ts';
import { inline } from '../src/engine/db/wire.ts';
import { parse } from '../src/engine/db/wire.ts';
import { SchemaSliceSchema, type SchemaSlice } from '../src/engine/schema/plan.ts';
import { constraintIndex, schemaObjects } from '@norbital-ai/store';
import { applyPlan, engineBeside, fingerprint, plan } from '../src/engine/schema/plan.ts';
import { SYSTEM } from '../src/system/index.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';

const withModel = (
	s: SchemaSlice,
	name: string,
	m: SchemaSlice['tables'][string]
): SchemaSlice => ({ ...s, tables: { ...s.tables, [name]: m } });
const classes = (from: SchemaSlice, to: SchemaSlice) =>
	Object.fromEntries(storeSync(plan(from, to)).steps.map((s) => [s.id, s.class]));

describe('next schema: fingerprint and plan', () => {
	it('fingerprints the canonical slice: key order is irrelevant, a json shape is not', () => {
		const s = slice();
		const reverse = (v: unknown): unknown =>
			v !== null && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(
						Object.entries(v)
							.reverse()
							.map(([k, x]) => [k, reverse(x)])
					)
				: v;
		const reordered = Schema.decodeUnknownSync(SchemaSliceSchema)(reverse(s));
		expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(s));
		expect(fingerprint(reordered)).toBe(fingerprint(s));
		const notes = s.tables.notes!;
		expect(
			fingerprint(
				withModel(s, 'notes', {
					...notes,
					fields: { body: { kind: 'json', shape: { kind: 'int' } } }
				})
			)
		).not.toBe(
			fingerprint(
				withModel(s, 'notes', {
					...notes,
					fields: { body: { kind: 'json', shape: { kind: 'text' } } }
				})
			)
		);
	});

	it('plans nothing with keys reordered; adding a field also refreshes its native row guard', () => {
		// jsonb orders keys by length: the applied slice comes back with `states` and predicate fields in another order
		const s = withModel(
			slice(),
			'signings',
			tableOf({
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
		);
		const reverse = (v: unknown): unknown =>
			v !== null && typeof v === 'object' && !Array.isArray(v)
				? Object.fromEntries(
						Object.entries(v)
							.reverse()
							.map(([k, x]) => [k, reverse(x)])
					)
				: Array.isArray(v)
					? v.map(reverse)
					: v;
		const applied = Schema.decodeUnknownSync(SchemaSliceSchema)(reverse(s));
		expect(storeSync(plan(applied, s)).steps).toEqual([]);
		const signings = s.tables.signings!;
		expect(
			classes(
				applied,
				withModel(s, 'signings', {
					...signings,
					fields: { ...signings.fields, nickname: { kind: 'text', optional: true } }
				})
			)
		).toEqual({
			'create:column:signings.nickname': 'additive',
			'replace:trigger:signings.store_row_rules': 'additive'
		});
		// the refusal map names what the plan created
		expect([...storeSync(constraintIndex(applied)).keys()].sort()).toEqual(
			[...storeSync(constraintIndex(s)).keys()].sort()
		);
	});

	it('a money field with a declared scale checks that many places instead of the minor unit (a unit price)', () => {
		const s = withModel(
			slice(),
			'prices',
			tableOf({
				description: 'prices',
				label: 'code',
				fields: {
					code: { kind: 'text' },
					unit: { kind: 'money', currency: 'SGD', scale: 4 },
					total: { kind: 'money', currency: 'JPY' }
				}
			})
		);
		const sql = storeSync(schemaObjects(s))
			.filter((o) => o.table === 'prices')
			.flatMap((o) => o.create)
			.join('\n');
		expect(sql).toContain('round("unit", 4) = "unit"');
		expect(sql).toContain('round("total", 0) = "total"');
	});

	it('an empty database plans every object as additive', () => {
		const steps = storeSync(plan(null, slice())).steps;
		expect(steps.length).toBeGreaterThan(50);
		expect(new Set(steps.map((s) => s.class))).toEqual(new Set(['additive']));
	});

	it('classifies each change: additive, backfill, validating, destructive', () => {
		const s = slice();
		const notes = s.tables.notes!;
		const orders = s.tables.orders!;
		expect(
			classes(
				s,
				withModel(s, 'notes', {
					...notes,
					fields: { ...notes.fields, tag: { kind: 'text', optional: true } }
				})
			)
		).toEqual({
			'create:column:notes.tag': 'additive',
			'replace:trigger:notes.store_row_rules': 'additive'
		});
		expect(
			classes(
				s,
				withModel(s, 'notes', { ...notes, fields: { ...notes.fields, tag: { kind: 'text' } } })
			)
		).toEqual({
			'create:column:notes.tag': 'additive',
			'create:notNull:notes.tag': 'validating',
			'replace:trigger:notes.store_row_rules': 'additive'
		});
		expect(
			classes(
				s,
				withModel(s, 'notes', {
					...notes,
					fields: { ...notes.fields, body: { kind: 'text', optional: true } }
				})
			)
		).toEqual({ 'drop:notNull:notes.body': 'additive' });
		expect(
			classes(
				s,
				withModel(s, 'notes', { ...notes, fields: { ...notes.fields, body: { kind: 'int' } } })
			)
		).toMatchObject({
			'replace:column:notes.body': 'destructive',
			'replace:notNull:notes.body': 'validating'
		});
		expect(
			classes(
				s,
				withModel(s, 'orders', {
					...orders,
					computed: {
						...orders.computed,
						big: { kind: 'bool', expr: { gt: [{ field: 'qty' }, 99] } }
					}
				})
			)
		).toEqual({ 'replace:column:orders.big': 'backfill' });
		// enum → state keeps the text column: only its CHECK and default change
		const st = classes(
			s,
			withModel(s, 'orders', {
				...orders,
				fields: {
					...orders.fields,
					status: { kind: 'enum', values: ['open', 'closed'], default: 'open' }
				}
			})
		);
		expect(Object.values(st)).not.toContain('destructive');
		const { notes: _, ...tables } = s.tables;
		expect(classes(s, { ...s, tables })).toMatchObject({
			'drop:table:notes': 'destructive'
		});
	});

	it('names constraints <table>__<kind>__<hash8> and refuses an identifier over 63 bytes', () => {
		const names = storeSync(schemaObjects(slice())).flatMap((o) =>
			o.meta === undefined ? [] : [o.meta.name]
		);
		expect(names.every((n) => /^[a-z_]{1,40}__(uq|key|ck|ex|fk)__[0-9a-f]{8}$/.test(n))).toBe(true);
		const s = slice();
		const long = 'x'.repeat(55);
		expect(() =>
			storeSync(
				schemaObjects(
					withModel(s, 'notes', {
						...s.tables.notes!,
						fields: {
							...s.tables.notes!.fields,
							[long]: { kind: 'ref', to: ['customers', 'orders'] }
						}
					})
				)
			)
		).toThrow(/over 63 bytes/);
	});

	it('an FK column takes its target id type: text to a system table, uuid to a tenant model', () => {
		const s: SchemaSlice = {
			tz: 'UTC',
			currency: null,
			tables: {
				sys_user: tableOf(SYSTEM.models.sys_user!),
				notes: {
					fields: {
						body: { kind: 'text' },
						owner_id: { kind: 'ref', to: 'sys_user' },
						parent_id: { kind: 'ref', to: 'notes', optional: true }
					},
					audit: true
				}
			}
		};
		const col = (c: string) =>
			storeSync(schemaObjects(s)).find((o) => o.id === `column:notes.${c}`)!.create[0];
		expect(col('owner_id')).toMatch(/"owner_id" text$/);
		expect(col('parent_id')).toMatch(/"parent_id" uuid$/);
	});

	it("a declared index on an FK column is the relationship's own index, created once", () => {
		const s: SchemaSlice = {
			tz: 'UTC',
			currency: null,
			tables: {
				sys_user: tableOf(SYSTEM.models.sys_user!),
				notes: {
					fields: { body: { kind: 'text' }, owner_id: { kind: 'ref', to: 'sys_user' } },
					audit: true,
					index: ['owner_id']
				}
			}
		};
		const ids = storeSync(schemaObjects(s)).map((o) => o.id);
		expect(ids.filter((id) => id.startsWith('index:notes.'))).toHaveLength(1);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('initial tenant schema contains committed record metadata without approval stamps or ownership indexes', () => {
		const s: SchemaSlice = {
			tz: 'UTC',
			currency: null,
			tables: {
				notes: tableOf({ description: 'n', label: 'body', fields: { body: { kind: 'text' } } })
			}
		};
		const objects = storeSync(schemaObjects(s));
		expect(objects.flatMap((object) => object.create).join('\n')).not.toMatch(
			/approval_id|__approval__/
		);
		expect(objects.find((object) => object.id === 'table:notes')?.create.join('\n')).toMatch(
			/revision int not null default 1/
		);
	});

	it("the built-in layer plans like a workspace; the engine's private objects are never dropped and re-asserted", () => {
		const s = slice();
		const objects = storeSync(schemaObjects(s, engineBeside(s)));
		for (const t of [
			'sys_user',
			'sys_run',
			'sys_notification',
			'sys_file',
			'sys_conversation',
			'sys_message',
			'sys_integration',
			'approval_request',
			'requestor'
		])
			expect(objects.find((o) => o.id === `table:${t}`)?.drop).toBe(
				`drop table if exists "${t}" cascade`
			);
		// teams are source declarations: no table, no projection, no foreign key to one
		expect(objects.filter((o) => o.table === 'sys_team' || o.id === 'source:teams')).toEqual([]);
		expect(objects.flatMap((o) => o.create).join('\n')).not.toContain('sys_team');
		const engine = objects.filter((o) => o.id.startsWith('engine:'));
		const creates = engine.flatMap((o) => o.create).join('\n');
		for (const t of [
			'bolt_schema',
			'bolt_history',
			'bolt_seq',
			'bolt_idem',
			'bolt_approvals',
			'bolt_credential'
		])
			expect(creates).toContain(`create table if not exists ${t} (`);
		expect(engine.every((o) => o.drop === null)).toBe(true);
		expect(new Set(engine.map((o) => o.id)).size).toBe(engine.length);
		expect(
			storeSync(plan(null, s)).steps.filter((x) => x.id.startsWith('create:engine:'))
		).toHaveLength(engine.length);
		expect(storeSync(plan(s, s)).steps).toEqual([]);
	});

	it.effect('refuses an unaccepted destructive step before touching the database', () =>
		Effect.gen(function* () {
			const s = slice();
			const { notes: _, ...tables } = s.tables;
			const untouched = TenantDb.typed({
				read: () => Effect.die('touched'),
				write: () => Effect.die('touched'),
				session: () =>
					Effect.fail(DbError.make('0A000', 'this fixture does not support leased sessions')),
				transaction: () => Effect.die('touched')
			});
			const untouchable = new Proxy(untouched, {
				get: () => {
					throw new Error('touched');
				}
			});
			const refusal = yield* Effect.result(
				applyPlan(untouchable, yield* plan(s, { ...s, tables }))
			);
			expect(Result.isFailure(refusal) && refusal.failure).toMatchObject({
				code: 'destructiveNotAccepted'
			});
		})
	);
});

describe('next schema: SQLSTATE → refusal (§5.2, every row)', () => {
	const idx = storeSync(constraintIndex(slice()));
	const name = (model: string, kind: string) =>
		[...idx].find(([, m]) => m.model === model && m.kind === kind)?.[0];
	const cases: [DbError, object][] = [
		[DbError.make('23505', 'dup', name('customers', 'unique')), { code: 'unique' }],
		[
			DbError.make('23001', 'delete restricted by a foreign key', name('orders', 'fk')),
			{ code: 'restricted' }
		],
		[
			DbError.make(
				'23503',
				'insert or update on table "orders" violates foreign key constraint',
				name('orders', 'fk')
			),
			{ code: 'missingRef', field: expect.any(String) }
		],
		[
			DbError.make(
				'23503',
				'update or delete on table "customers" violates foreign key constraint',
				name('orders', 'fk')
			),
			{ code: 'restricted' }
		],
		[DbError.make('23514', 'check', name('orders', 'check')), { code: 'check' }],
		[DbError.make('23P01', 'excl', name('terms', 'overlap')), { code: 'overlap' }],
		[
			DbError.make(
				'23502',
				'null value in column "qty" of relation "orders" violates not-null constraint'
			),
			{ code: 'required', field: 'qty' }
		],
		[DbError.make('22003', 'integer out of range'), { code: 'overflow' }]
	];
	it.each(cases)('%s', (e, expected) =>
		expect(refusalOf(e, idx)).toMatchObject({ kind: 'refused', ...expected })
	);
	it('serialization and deadlock failures are a conflict to replay; anything else is a bug keeping its cause', () => {
		expect(refusalOf(DbError.make('40001', 'x'), idx)).toBe('conflict');
		expect(refusalOf(DbError.make('40P01', 'x'), idx)).toBe('conflict');
		const e = DbError.make('42P01', 'relation "x" does not exist');
		const bug = refusalOf(e, idx);
		expect(bug).toBeInstanceOf(BoltError);
		if (!(bug instanceof BoltError)) throw new Error('unexpected schema refusal');
		expect([bug.code, bug.cause]).toEqual(['bug', e]);
		expect(refusalOf(DbError.make('57014', 'cancel'), idx)).toMatchObject({
			code: 'timeout',
			phase: 'facility'
		});
	});
});

describe('next db wire', () => {
	it('inlines parameters as quoted literals, leaving quoted text alone', () => {
		expect(
			inline({
				text: `select $1, '$2', "$1", $2::jsonb, $3, $10`,
				params: ["it's", { a: [1] }, null, 1, 2, 3, 4, 5, 6, 7]
			})
		).toBe(`select 'it''s', '$2', "$1", '{"a":[1]}'::jsonb, null, '7'`);
		expect(() => inline({ text: 'select $2', params: [1] })).toThrow(DbError);
	});
	it('parses Postgres text to JSON the same on every adapter', () => {
		expect(parse(1009, '{a,"b c","q\\"x",NULL}')).toEqual(['a', 'b c', 'q"x', null]);
		expect(parse(1184, '2026-01-02 03:04:05.123456+00')).toBe('2026-01-02T03:04:05.123456Z');
		expect(parse(1184, '2026-01-02 11:04:05+08')).toBe('2026-01-02T03:04:05.000Z');
		expect(parse(20, '9007199254740993')).toBe('9007199254740993');
		expect([
			parse(20, '5'),
			parse(1700, '1.50'),
			parse(1082, '2026-01-02'),
			parse(16, 't')
		]).toEqual([5, '1.50', '2026-01-02', true]);
	});
});
