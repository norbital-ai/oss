import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { build, destructive_steps, generate, plan, read_snapshot, schema, schema_snapshot, statements, table, type FieldSpec, type SchemaObject } from '../src/index.ts';
import { database, script } from './support.ts';
import { unaccepted } from '../src/schema/plan.ts';

describe('lossless schema planning', () => {
	it.live('adds, recalculates and removes an optional indexed record label on existing rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const source = (record_label?: string) =>
					schema({
						people: table({
							key: 'text',
							fields: { name: { kind: 'text' } },
							...(record_label === undefined ? {} : { record_label })
						})
					});
				const pg = yield* database;
				let current = yield* schema_snapshot(source());
				yield* script(pg, `${(yield* build(current.schema)).join(';\n')};`);
				yield* script(pg, "insert into people (id, name) values ('person', 'Ada')");
				let number = 2;
				for (const [expression, expected] of [
					["'First ' + record.name", 'First Ada'],
					["'Second ' + record.name", 'Second Ada']
				] as const) {
					const next = source(expression);
					const migration = yield* generate(current, next, {
						number: number++,
						name: 'identifier'
					});
					yield* script(pg, migration.file.sql);
					const result = yield* Effect.promise(() =>
						pg.query<{ bolt_record_label: string }>(
							`select bolt_record_label from people where bolt_search @@ plainto_tsquery('simple', '${expected}')`
						)
					);
					expect(result.rows).toEqual([{ bolt_record_label: expected }]);
					current = yield* read_snapshot(migration.snapshot);
				}
				const removal = yield* generate(current, source(), { number, name: 'remove_identifier' });
				yield* script(pg, removal.file.sql);
				const remaining = yield* Effect.promise(() =>
					pg.query<{ name: string }>('select name from people')
				);
				expect(remaining.rows).toEqual([{ name: 'Ada' }]);
				const hidden = yield* Effect.promise(() =>
					pg.query<{ column_name: string }>(
						"select column_name from information_schema.columns where table_name='people' and column_name in ('bolt_record_label', 'bolt_search')"
					)
				);
				expect(hidden.rows).toEqual([]);
			})
		)
	);
	it.live('adds search fields before rebuilding the generated document on populated tables', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const old = schema({
					requests: table({
						key: 'text',
						fields: { title: { kind: 'text' } },
						search: { text: ['title'] }
					})
				});
				const next = schema({
					requests: table({
						key: 'text',
						fields: { title: { kind: 'text' }, record_label: { kind: 'text', optional: true } },
						search: { text: ['record_label'] }
					})
				});
				const pg = yield* database;
				yield* script(pg, `${(yield* build(old)).join(';\n')};`);
				yield* script(pg, "insert into requests (id, title) values ('request', 'Original')");
				const migration = yield* generate(yield* schema_snapshot(old), next, {
					number: 2,
					name: 'labels'
				});
				yield* script(pg, migration.file.sql);
				yield* script(
					pg,
					"update requests set record_label = 'Overnight travel' where id = 'request'"
				);
				const result = yield* Effect.promise(() =>
					pg.query<{ title: string; record_label: string }>(
						"select title, record_label from requests where bolt_search @@ plainto_tsquery('simple', 'travel')"
					)
				);
				expect(result.rows).toEqual([{ title: 'Original', record_label: 'Overnight travel' }]);
			})
		)
	);
	it.effect('preserves distinct host-owned table identities in an unchanged plan', () =>
		Effect.gen(function* () {
			const empty = schema({});
			const beside = () =>
				Effect.succeed<readonly SchemaObject[]>(
					['first', 'second'].map((name): SchemaObject => ({
						id: `engine:${name}`,
						rank: 'table',
						table: '',
						deps: [],
						create: [`create table if not exists ${name} (id int primary key)`],
						drop: null
					}))
				);
			expect((yield* plan(null, empty, beside)).steps.map((step) => step.id)).toEqual([
				'create:engine:first',
				'create:engine:second'
			]);
			expect((yield* plan(empty, empty, beside)).steps).toEqual([]);
		})
	);

	it.live('widens populated int columns with ALTER TYPE and keeps nulls and boundary values', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const cases: readonly { field: FieldSpec; type: string }[] = [
					{ field: { kind: 'int', storage: 'int64', optional: true }, type: 'bigint' },
					{ field: { kind: 'decimal', scale: 0, optional: true }, type: 'numeric' }
				];
				for (const target of cases) {
					const old = schema({
						entry: table({ key: 'text', fields: { n: { kind: 'int', optional: true } } })
					});
					const next = schema({ entry: table({ key: 'text', fields: { n: target.field } }) });
					const pg = yield* database;
					yield* script(pg, `${(yield* build(old)).join(';\n')};`);
					yield* script(
						pg,
						"insert into entry (id, n) values ('low', -2147483648), ('high', 2147483647), ('null', null)"
					);
					const migration = yield* generate(yield* schema_snapshot(old), next, {
						number: 2,
						name: 'widen'
					});
					const sql = statements(migration.plan);
					const widen = sql.filter((s) => s.step.startsWith('widen:'));
					expect(widen).toHaveLength(1);
					expect(widen[0]?.sql).toBe(`alter table "entry" alter column "n" type ${target.type}`);
					expect(widen[0]?.risks).toEqual([
						'access-exclusive-lock',
						'table-rewrite',
						'index-rebuild'
					]);
					expect(sql.some((s) => /\b(?:drop|add) column\b|\bdrop table\b/i.test(s.sql))).toBe(
						false
					);
					expect(unaccepted(migration.plan)).toEqual([]);
					expect(yield* destructive_steps(old, next)).toEqual([]);
					yield* script(pg, migration.file.sql);
					const rows = yield* Effect.promise(() =>
						pg.query<{ id: string; n: string | null; type: string }>(
							'select id, n::text as n, pg_typeof(n)::text as type from entry order by id'
						)
					);
					expect(rows.rows).toEqual([
						{ id: 'high', n: '2147483647', type: target.type },
						{ id: 'low', n: '-2147483648', type: target.type },
						{ id: 'null', n: null, type: target.type }
					]);
				}
			})
		)
	);

	it.live('rebuilds derived dependants around a widening and preserves renamed stored values', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const old = schema({
					entry: table({
						key: 'text',
						fields: { n: { kind: 'int' } },
						computed: { twice: { kind: 'decimal', expr: { times: [{ field: 'n' }, 2] } } },
						indexes: [{ on: ['twice'] }]
					})
				});
				const next = schema({
					record: table({
						key: 'text',
						was: 'entry',
						fields: { value: { kind: 'int', storage: 'int64', was: 'n' } },
						computed: { twice: { kind: 'decimal', expr: { times: [{ field: 'value' }, 2] } } },
						indexes: [{ on: ['twice'] }]
					})
				});
				const pg = yield* database;
				yield* script(pg, `${(yield* build(old)).join(';\n')};`);
				yield* script(pg, "insert into entry (id, n) values ('kept', 21)");
				const migration = yield* generate(yield* schema_snapshot(old), next, {
					number: 2,
					name: 'rename and widen'
				});
				const sql = statements(migration.plan).map((s) => s.sql);
				const alter = sql.indexOf('alter table "record" alter column "value" type bigint');
				expect(alter).toBeGreaterThan(
					sql.indexOf('alter table "record" rename column "n" to "value"')
				);
				expect(
					sql.indexOf('alter table "entry" drop column if exists "twice" cascade')
				).toBeLessThan(alter);
				expect(
					sql.findIndex((s) => s.startsWith('alter table "record" add column "twice"'))
				).toBeGreaterThan(alter);
				expect(unaccepted(migration.plan)).toEqual([]);
				expect(yield* destructive_steps(old, next)).toEqual([]);
				yield* script(pg, migration.file.sql);
				expect(
					(yield* Effect.promise(() =>
						pg.query<{ value: string; twice: string }>(
							'select value::text as value, twice::text as twice from "record"'
						)
					)).rows
				).toEqual([{ value: '21', twice: '42' }]);
			})
		)
	);

	it.effect('keeps narrowing and unsupported casts behind destructive acceptance', () =>
		Effect.gen(function* () {
			const target = schema({ entry: table({ fields: { n: { kind: 'int' } } }) });
			const cases: readonly FieldSpec[] = [
				{ kind: 'int', storage: 'int64' },
				{ kind: 'decimal', scale: 0 },
				{ kind: 'text' }
			];
			for (const field of cases) {
				const old = schema({ entry: table({ fields: { n: field } }) });
				const p = yield* plan(old, target);
				expect(unaccepted(p).map((s) => s.id)).toContain('replace:column:entry.n');
				expect(yield* destructive_steps(old, target)).toEqual(['replace:column:entry.n']);
				expect(p.steps.some((s) => s.alter !== undefined)).toBe(false);
			}
			const unsupported = yield* plan(
				target,
				schema({ entry: table({ fields: { n: { kind: 'number' } } }) })
			);
			expect(unaccepted(unsupported).map((s) => s.id)).toContain('replace:column:entry.n');
			expect(unsupported.steps.some((s) => s.alter !== undefined)).toBe(false);
		})
	);

	it.effect('reports locks and scans for additive indexes, columns and constraint validation', () =>
		Effect.gen(function* () {
			const old = schema({ entry: table({ fields: { n: { kind: 'int', optional: true } } }) });
			const next = schema({
				entry: table({
					fields: { n: { kind: 'int' }, label: { kind: 'text', optional: true } },
					indexes: [{ on: ['n'] }]
				})
			});
			const sql = statements(yield* plan(old, next));
			expect(sql.find((s) => s.sql.startsWith('create index'))?.risks).toEqual([
				'writes-blocked',
				'table-scan'
			]);
			expect(sql.find((s) => s.sql.includes('add column "label"'))?.risks).toEqual([
				'access-exclusive-lock'
			]);
			expect(sql.find((s) => s.sql.includes('set not null'))?.risks).toEqual([
				'access-exclusive-lock',
				'table-scan'
			]);
		})
	);
});
