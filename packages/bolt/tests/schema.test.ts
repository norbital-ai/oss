/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { BoltError, DbError, type TenantDb } from '../src/engine/contracts.ts';
import { inline } from '../src/engine/db/postgres.ts';
import { parse } from '../src/engine/db/wire.ts';
import { constraintIndex, schemaObjects, type SchemaSlice } from '../src/engine/schema/ddl.ts';
import { applyPlan, fingerprint, plan } from '../src/engine/schema/plan.ts';
import { refusalOf } from '../src/engine/schema/refusal.ts';
import { slice } from './schema-fixture.ts';

const withModel = (s: SchemaSlice, name: string, m: SchemaSlice['models'][string]): SchemaSlice => ({ ...s, models: { ...s.models, [name]: m } });
const classes = (from: SchemaSlice, to: SchemaSlice) => Object.fromEntries(plan(from, to).steps.map((s) => [s.id, s.class]));

describe('next schema: fingerprint and plan', () => {
	it('fingerprints the canonical slice: key order is irrelevant, a json shape is not', () => {
		const s = slice();
		const reverse = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v);
		const reordered = reverse(s) as SchemaSlice;
		expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(s));
		expect(fingerprint(reordered)).toBe(fingerprint(s));
		const notes = s.models.notes!;
		expect(fingerprint(withModel(s, 'notes', { ...notes, fields: { body: { kind: 'json', shape: { kind: 'int' } } } })))
			.not.toBe(fingerprint(withModel(s, 'notes', { ...notes, fields: { body: { kind: 'json', shape: { kind: 'text' } } } })));
	});

	it('plans nothing against its own slice with keys reordered, as jsonb returns it; an unrelated field is one step', () => {
		// jsonb orders keys by length: the applied slice comes back with `states` and predicate fields in another order
		const s = withModel(slice(), 'signings', { description: 'signings', label: 'status', fields: {
			status: { kind: 'state', initial: 'unstamped', states: { unstamped: { to: ['voided'] }, counterparty_stamped: {}, acknowledged: {}, voided: {} } },
			reason: { kind: 'text', optional: true },
		}, check: { void_needs_reason: { status: { ne: 'voided', in: ['unstamped', 'voided'] }, reason: { isNull: false } } } });
		const reverse = (v: unknown): unknown => (v !== null && typeof v === 'object' && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : Array.isArray(v) ? v.map(reverse) : v);
		const applied = reverse(s) as SchemaSlice;
		expect(plan(applied, s).steps).toEqual([]);
		const signings = s.models.signings!;
		expect(classes(applied, withModel(s, 'signings', { ...signings, fields: { ...signings.fields, nickname: { kind: 'text', optional: true } } })))
			.toEqual({ 'create:column:signings.nickname': 'additive' });
		// the refusal map names what the plan created
		expect([...constraintIndex(applied).keys()].sort()).toEqual([...constraintIndex(s).keys()].sort());
	});

	it('a money field with a declared scale checks that many places instead of the minor unit (a unit price)', () => {
		const s = withModel(slice(), 'prices', { description: 'prices', label: 'code', fields: {
			code: { kind: 'text' }, unit: { kind: 'money', currency: 'SGD', scale: 4 }, total: { kind: 'money', currency: 'JPY' },
		} });
		const sql = schemaObjects(s).filter((o) => o.table === 'prices').flatMap((o) => o.create).join('\n');
		expect(sql).toContain('round("unit", 4) = "unit"');
		expect(sql).toContain('round("total", 0) = "total"');
	});

	it('an empty database plans every object as additive', () => {
		const steps = plan(null, slice()).steps;
		expect(steps.length).toBeGreaterThan(50);
		expect(new Set(steps.map((s) => s.class))).toEqual(new Set(['additive']));
	});

	it('classifies each change: additive, backfill, validating, destructive', () => {
		const s = slice();
		const notes = s.models.notes!;
		const orders = s.models.orders!;
		expect(classes(s, withModel(s, 'notes', { ...notes, fields: { ...notes.fields, tag: { kind: 'text', optional: true } } })))
			.toEqual({ 'create:column:notes.tag': 'additive' });
		expect(classes(s, withModel(s, 'notes', { ...notes, fields: { ...notes.fields, tag: { kind: 'text' } } })))
			.toEqual({ 'create:column:notes.tag': 'additive', 'create:notNull:notes.tag': 'validating' });
		expect(classes(s, withModel(s, 'notes', { ...notes, fields: { body: { kind: 'text', optional: true } } })))
			.toEqual({ 'drop:notNull:notes.body': 'additive' });
		expect(classes(s, withModel(s, 'notes', { ...notes, fields: { body: { kind: 'int' } } })))
			.toMatchObject({ 'replace:column:notes.body': 'destructive', 'replace:notNull:notes.body': 'validating' });
		expect(classes(s, withModel(s, 'orders', { ...orders, computed: { ...orders.computed, big: { kind: 'bool', expr: { gt: [{ field: 'qty' }, 99] } } } })))
			.toEqual({ 'replace:column:orders.big': 'backfill' });
		// enum → state keeps the text column: only its CHECK and default change
		const st = classes(s, withModel(s, 'orders', { ...orders, fields: { ...orders.fields, status: { kind: 'enum', values: ['open', 'closed'], default: 'open' } } }));
		expect(Object.values(st)).not.toContain('destructive');
		const { notes: _, ...models } = s.models;
		const { 'notes.about': __, ...relationships } = s.relationships;
		expect(classes(s, { ...s, models, relationships })).toMatchObject({ 'drop:table:notes': 'destructive' });
	});

	it('names constraints <table>__<kind>__<hash8> and refuses an identifier over 63 bytes', () => {
		const names = schemaObjects(slice()).flatMap((o) => (o.meta === undefined ? [] : [o.meta.name]));
		expect(names.every((n) => /^[a-z_]{1,40}__(uq|key|ck|ex|fk)__[0-9a-f]{8}$/.test(n))).toBe(true);
		const s = slice();
		const long = 'x'.repeat(55);
		expect(() => schemaObjects(withModel({ ...s, relationships: { ...s.relationships, [`notes.${long}`]: { to: ['customers', 'orders'] } } }, 'notes', s.models.notes!)))
			.toThrow(/over 63 bytes/);
	});

	it('an FK column takes its target id type: text to a system table, uuid to a tenant model', () => {
		const s: SchemaSlice = { tz: 'UTC', currency: null, relationships: { 'notes.owner_id': { to: 'sys_user' }, 'notes.parent_id': { to: 'notes', optional: true } },
			models: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } } } } } as unknown as SchemaSlice;
		const col = (c: string) => schemaObjects(s).find((o) => o.id === `column:notes.${c}`)!.create[0];
		expect(col('owner_id')).toMatch(/"owner_id" text$/);
		expect(col('parent_id')).toMatch(/"parent_id" uuid$/);
	});

	it('a declared index on an FK column is the relationship\'s own index, created once', () => {
		const s: SchemaSlice = { tz: 'UTC', currency: null, relationships: { 'notes.owner_id': { to: 'sys_user' } },
			models: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } }, index: ['owner_id'] } } } as unknown as SchemaSlice;
		const ids = schemaObjects(s).map((o) => o.id);
		expect(ids.filter((id) => id.startsWith('index:notes.') && !id.includes('__approval__'))).toHaveLength(1);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every tenant table carries the approval ownership index on approval_id (L-BOLT-103)', () => {
		const s: SchemaSlice = { tz: 'UTC', currency: null, relationships: {}, models: { notes: { description: 'n', label: 'body', fields: { body: { kind: 'text' } } } } } as unknown as SchemaSlice;
		const ix = schemaObjects(s).filter((o) => o.id.startsWith('index:notes.notes__approval__'));
		expect(ix.map((o) => o.create[0])).toEqual([expect.stringMatching(/^create index "notes__approval__\w+" on "notes" \(approval_id\) where approval_id is not null$/)]);
	});

	it('the built-in layer plans like a workspace; the engine\'s private objects are never dropped and re-asserted', () => {
		const s = slice();
		const objects = schemaObjects(s);
		for (const t of ['sys_user', 'sys_team', 'sys_assignment', 'sys_run', 'sys_notification', 'sys_file', 'sys_conversation', 'sys_message', 'approval_request', 'requestor'])
			expect(objects.find((o) => o.id === `table:${t}`)?.drop).toBe(`drop table if exists "${t}" cascade`);
		const engine = objects.filter((o) => o.id.startsWith('engine:'));
		const creates = engine.flatMap((o) => o.create).join('\n');
		for (const t of ['bolt_schema', 'bolt_history', 'bolt_seq', 'bolt_idem', 'bolt_sync', 'bolt_approvals'])
			expect(creates).toContain(`create table if not exists ${t} (`);
		expect(engine.every((o) => o.drop === null)).toBe(true);
		expect(new Set(engine.map((o) => o.id)).size).toBe(engine.length);
		expect(plan(null, s).steps.filter((x) => x.id.startsWith('create:engine:'))).toHaveLength(engine.length);
		expect(plan(s, s).steps).toEqual([]);
	});

	it('refuses an unaccepted destructive step before touching the database', async () => {
		const s = slice();
		const { notes: _, ...models } = s.models;
		const { 'notes.about': __, ...relationships } = s.relationships;
		const untouchable = new Proxy({}, { get: () => { throw new Error('touched'); } }) as TenantDb;
		await expect(applyPlan(untouchable, plan(s, { ...s, models, relationships }))).rejects.toMatchObject({ code: 'destructiveNotAccepted' });
	});
});

describe('next schema: SQLSTATE → refusal (§5.2, every row)', () => {
	const idx = constraintIndex(slice());
	const name = (model: string, kind: string) => [...idx].find(([, m]) => m.model === model && m.kind === kind)?.[0];
	const cases: [DbError, unknown][] = [
		[new DbError('23505', 'dup', name('customers', 'unique')), { code: 'unique' }],
		[new DbError('23503', 'insert or update on table "orders" violates foreign key constraint', name('orders', 'fk')), { code: 'missingRef', field: expect.any(String) }],
		[new DbError('23503', 'update or delete on table "customers" violates foreign key constraint', name('orders', 'fk')), { code: 'restricted' }],
		[new DbError('23514', 'check', name('orders', 'check')), { code: 'check' }],
		[new DbError('23P01', 'excl', name('terms', 'overlap')), { code: 'overlap' }],
		[new DbError('23502', 'null value in column "qty" of relation "orders" violates not-null constraint'), { code: 'required', field: 'qty' }],
		[new DbError('22003', 'integer out of range'), { code: 'overflow' }],
	];
	it.each(cases)('%s', (e, expected) => expect(refusalOf(e, idx)).toMatchObject({ kind: 'refused', ...(expected as object) }));
	it('serialization and deadlock failures are a conflict to replay; anything else is a bug keeping its cause', () => {
		expect(refusalOf(new DbError('40001', 'x'), idx)).toBe('conflict');
		expect(refusalOf(new DbError('40P01', 'x'), idx)).toBe('conflict');
		const e = new DbError('42P01', 'relation "x" does not exist');
		const bug = refusalOf(e, idx) as BoltError;
		expect(bug).toBeInstanceOf(BoltError);
		expect([bug.code, bug.cause]).toEqual(['bug', e]);
		expect(refusalOf(new DbError('57014', 'cancel'), idx)).toMatchObject({ code: 'timeout', phase: 'facility' });
	});
});

describe('next db wire', () => {
	it('inlines parameters as quoted literals, leaving quoted text alone', () => {
		expect(inline({ text: `select $1, '$2', "$1", $2::jsonb, $3, $10`, params: ["it's", { a: [1] }, null, 1, 2, 3, 4, 5, 6, 7] }))
			.toBe(`select 'it''s', '$2', "$1", '{"a":[1]}'::jsonb, null, '7'`);
		expect(() => inline({ text: 'select $2', params: [1] })).toThrow(DbError);
	});
	it('parses Postgres text to JSON the same on every adapter', () => {
		expect(parse(1009, '{a,"b c","q\\"x",NULL}')).toEqual(['a', 'b c', 'q"x', null]);
		expect(parse(1184, '2026-01-02 03:04:05.123456+00')).toBe('2026-01-02T03:04:05.123456Z');
		expect(parse(1184, '2026-01-02 11:04:05+08')).toBe('2026-01-02T03:04:05.000Z');
		expect(parse(20, '9007199254740993')).toBe('9007199254740993');
		expect([parse(20, '5'), parse(1700, '1.50'), parse(1082, '2026-01-02'), parse(16, 't')]).toEqual([5, '1.50', '2026-01-02', true]);
	});
});
