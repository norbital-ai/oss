import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	build,
	generate,
	plan,
	schema,
	statements,
	table,
	type SchemaSpec,
	type TableSpec
} from '../src/index.ts';
import { database, exec, script } from './support.ts';

it.effect(
	'upgrades legacy and v1 native rules with forward SQL while retaining original migration bytes and rows',
	() =>
		Effect.gen(function* () {
			const target: 'parent' = 'parent';
			const historical = {
				tables: {
					parent: { key: 'text', fields: { name: { kind: 'text' } } },
					child: {
						key: 'text',
						audit: true,
						managedDeletes: true,
						fields: {
							parent: { kind: 'ref', to: target, owned: true },
							name: { kind: 'text' }
						}
					}
				},
				tz: 'UTC',
				currency: null
			} satisfies SchemaSpec;
			const current = schema({
				parent: table(historical.tables.parent),
				child: table(historical.tables.child)
			});
			const nativeV1: SchemaSpec = {
				...current,
				tables: Object.fromEntries(
					Object.entries(current.tables).map(([name, spec]): [string, TableSpec] => [
						name,
						{ ...spec, nativeRules: 1 }
					])
				)
			};
			const original = yield* generate(null, historical, { number: 1, name: 'legacy' });
			const originalSql = original.file.sql;
			const pg = yield* database;
			yield* script(pg, originalSql);
			yield* script(
				pg,
				"INSERT INTO parent(id,name) VALUES ('parent','Parent'); INSERT INTO child(id,parent,name) VALUES ('child','parent','Child')"
			);
			const oldDefinitions = yield* build(historical);
			expect(oldDefinitions.some((text) => text.includes('store_row_rules'))).toBe(false);
			expect(oldDefinitions.some((text) => text.includes('on delete cascade'))).toBe(false);
			const change = yield* plan(historical, nativeV1);
			expect(change.steps.some((step) => step.class === 'destructive')).toBe(false);
			const generated = yield* generate(historical, nativeV1, { number: 2, name: 'native_rules' });
			const nativeV1Sql = generated.file.sql;
			expect(generated.file.sql).toContain('on delete cascade on update restrict');
			expect(generated.file.sql).not.toContain('store_anonymise_fields');
			for (const statement of statements(change)) yield* script(pg, statement.sql);
			const upgrade = yield* plan(nativeV1, current);
			expect(upgrade.steps.map(({ id, class: kind, drop }) => ({ id, kind, drop }))).toEqual([
				{ id: 'replace:function:store_row_rules', kind: 'additive', drop: null }
			]);
			const nativeV2 = yield* generate(nativeV1, current, { number: 3, name: 'native_rules_v2' });
			expect(nativeV2.file.sql).toContain(
				'create or replace function store_row_rules() returns trigger'
			);
			expect(nativeV2.file.sql).toContain('store_anonymise_fields');
			expect(nativeV2.file.sql).not.toContain('drop function');
			for (const statement of statements(upgrade)) yield* script(pg, statement.sql);
			expect(
				yield* exec(pg)({ text: 'SELECT id,parent,name,revision FROM child', params: [] })
			).toEqual([{ id: 'child', parent: 'parent', name: 'Child', revision: 1 }]);
			const invalidKey = yield* Effect.flip(
				Effect.tryPromise({
					try: () => pg.query("UPDATE parent SET id='changed' WHERE id='parent'"),
					catch: (error: unknown) => error
				})
			);
			expect(
				yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))(invalidKey)
			).toEqual({ code: '23514' });
			yield* script(pg, "DELETE FROM parent WHERE id='parent'");
			expect(yield* exec(pg)({ text: 'SELECT count(*)::int AS n FROM child', params: [] })).toEqual(
				[{ n: 0 }]
			);
			expect(original.file.sql).toBe(originalSql);
			expect((yield* generate(null, historical, { number: 1, name: 'legacy' })).file.sql).toBe(
				originalSql
			);
			expect(
				(yield* generate(historical, nativeV1, { number: 2, name: 'native_rules' })).file.sql
			).toBe(nativeV1Sql);
		})
);
