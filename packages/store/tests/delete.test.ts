import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	build,
	schema,
	store,
	table,
	type SchemaSpec,
	type Sql,
	type TableSpec
} from '../src/index.ts';
import { database, exec as executeSql, required, run, script } from './support.ts';

const rejected = Effect.fnUntraced(function* (pg: Effect.Success<typeof database>, statement: Sql) {
	const error = yield* Effect.flip(
		Effect.tryPromise({
			try: () => pg.query(statement.text, [...statement.params]),
			catch: (cause) => cause
		})
	);
	return yield* Schema.decodeUnknownEffect(Schema.Struct({ code: Schema.String }))(error);
});

for (const audited of [false, true]) {
	it.effect(
		`enforces cascade, nulling and restrictive deletes on ${audited ? 'audited' : 'plain'} tables`,
		() =>
			Effect.gen(function* () {
				const audit: Pick<TableSpec, 'audit'> = audited ? { audit: true } : {};
				const records = schema({
					parent: table({ ...audit, key: 'text', fields: { name: { kind: 'text' } } }),
					owned: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent', owned: true } }
					}),
					cascade: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent', onDelete: 'cascade' } }
					}),
					grandchild: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'owned', owned: true } }
					}),
					nullable: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent', optional: true, onDelete: 'setNull' } }
					}),
					restrict: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent', onDelete: 'restrict' } }
					}),
					default_ref: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent' } }
					}),
					override: table({
						...audit,
						key: 'text',
						fields: { parent: { kind: 'ref', to: 'parent', owned: true, onDelete: 'restrict' } }
					})
				});
				const db = store(records),
					pg = yield* database,
					execute = run(pg);
				yield* script(pg, `${(yield* build(records)).join(';\n')};`);
				expect(
					yield* executeSql(pg)({
						text: `SELECT c.relname AS owner, confdeltype::text AS deletion, confupdtype::text AS updating
					FROM pg_constraint JOIN pg_class c ON c.oid = conrelid WHERE contype = 'f' ORDER BY owner`,
						params: []
					})
				).toEqual([
					{ owner: 'cascade', deletion: 'c', updating: 'r' },
					{ owner: 'default_ref', deletion: 'r', updating: 'r' },
					{ owner: 'grandchild', deletion: 'c', updating: 'r' },
					{ owner: 'nullable', deletion: 'n', updating: 'r' },
					{ owner: 'override', deletion: 'r', updating: 'r' },
					{ owner: 'owned', deletion: 'c', updating: 'r' },
					{ owner: 'restrict', deletion: 'r', updating: 'r' }
				]);
				yield* execute(
					yield* db.create(
						'parent',
						['deleted', 'restricted', 'default', 'override', 'kept'].map((id) => ({ id, name: id }))
					)
				);
				yield* execute(
					yield* db.create('owned', [
						{ id: 'owned', parent: 'deleted' },
						{ id: 'blocked', parent: 'restricted' }
					])
				);
				yield* execute(yield* db.create('cascade', { id: 'cascade', parent: 'deleted' }));
				yield* execute(
					yield* db.create('grandchild', [
						{ id: 'grandchild', parent: 'owned' },
						{ id: 'blocked-grandchild', parent: 'blocked' }
					])
				);
				yield* execute(yield* db.create('nullable', { id: 'nullable', parent: 'deleted' }));
				yield* execute(yield* db.create('restrict', { id: 'restrict', parent: 'restricted' }));
				yield* execute(yield* db.create('default_ref', { id: 'default', parent: 'default' }));
				yield* execute(yield* db.create('override', { id: 'override', parent: 'override' }));

				for (const id of ['restricted', 'default', 'override']) {
					const deletion = yield* db.delete('parent', { key: { id } });
					expect(yield* rejected(pg, deletion.sql)).toEqual({ code: '23001' });
					expect((yield* execute(yield* db.get('parent', { id })))?.id).toBe(id);
				}
				expect((yield* execute(yield* db.get('owned', { id: 'blocked' })))?.parent).toBe(
					'restricted'
				);
				expect(
					(yield* execute(yield* db.get('grandchild', { id: 'blocked-grandchild' })))?.parent
				).toBe('blocked');
				expect((yield* execute(yield* db.get('restrict', { id: 'restrict' })))?.parent).toBe(
					'restricted'
				);
				expect((yield* execute(yield* db.get('default_ref', { id: 'default' })))?.parent).toBe(
					'default'
				);
				expect((yield* execute(yield* db.get('override', { id: 'override' })))?.parent).toBe(
					'override'
				);

				expect(yield* execute(yield* db.delete('parent', { key: { id: 'deleted' } }))).toEqual([
					{ id: 'deleted' }
				]);
				expect(yield* execute(yield* db.get('parent', { id: 'deleted' }))).toBeNull();
				expect(yield* execute(yield* db.get('owned', { id: 'owned' }))).toBeNull();
				expect(yield* execute(yield* db.get('cascade', { id: 'cascade' }))).toBeNull();
				expect(yield* execute(yield* db.get('grandchild', { id: 'grandchild' }))).toBeNull();
				expect((yield* execute(yield* db.get('nullable', { id: 'nullable' })))?.parent).toBeNull();
				expect(
					(yield* execute(yield* db.read('parent', { orderBy: 'id', all: true }))).rows.map(
						(row) => row.id
					)
				).toEqual(['default', 'kept', 'override', 'restricted']);
			})
	);
}

it.effect('preserves historical managed-delete DDL without changing its physical constraints', () =>
	Effect.gen(function* () {
		const target: 'parent' = 'parent';
		const records = {
			tables: {
				parent: { key: 'text', fields: { name: { kind: 'text' } } },
				child: {
					audit: true,
					managedDeletes: true,
					key: 'text',
					fields: { parent: { kind: 'ref', to: target, owned: true } }
				}
			},
			tz: 'UTC',
			currency: null
		} satisfies SchemaSpec;
		const db = store(records),
			pg = yield* database,
			execute = run(pg);
		yield* script(pg, `${(yield* build(records)).join(';\n')};`);
		expect(
			yield* executeSql(pg)({
				text: "SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'child'::regclass AND tgname = 'store_audit_update'",
				params: []
			})
		).toEqual([{ n: 0 }]);
		yield* execute(yield* db.create('parent', { id: 'parent', name: 'Kept' }));
		yield* execute(yield* db.create('child', { id: 'child', parent: 'parent' }));
		expect(
			yield* rejected(pg, (yield* db.delete('parent', { key: { id: 'parent' } })).sql)
		).toEqual({ code: '23503' });
		expect((yield* execute(yield* db.get('parent', { id: 'parent' })))?.name).toBe('Kept');
		expect((yield* execute(yield* db.get('child', { id: 'child' })))?.revision).toBe(1);
		yield* execute(yield* db.delete('child', { key: { id: 'child' }, observed: 1 }));
		expect(yield* execute(yield* db.delete('parent', { key: { id: 'parent' } }))).toEqual([
			{ id: 'parent' }
		]);
	})
);

it.effect(
	'advances an audited child after native SET NULL and refuses its stale observed revision',
	() =>
		Effect.gen(function* () {
			const records = schema({
				parent: table({ key: 'text', fields: { name: { kind: 'text' } } }),
				child: table({
					audit: true,
					key: 'text',
					fields: {
						name: { kind: 'text' },
						parent: { kind: 'ref', to: 'parent', optional: true, onDelete: 'setNull' }
					},
					computed: { name_upper: { kind: 'text', expr: { upper: { field: 'name' } } } }
				})
			});
			const db = store(records),
				pg = yield* database,
				execute = run(pg);
			yield* script(pg, `${(yield* build(records)).join(';\n')};`);
			yield* execute(yield* db.create('parent', { id: 'parent', name: 'Parent' }));
			const created = required(
				(yield* execute(
					yield* db.create(
						'child',
						{
							id: 'child',
							name: 'Created',
							parent: 'parent'
						},
						{ actor: 'creator' }
					)
				))[0]
			);
			expect(created.revision).toBe(1);
			const written = required(
				(yield* execute(
					yield* db.update('child', {
						key: { id: 'child' },
						set: { name: 'Kept' },
						observed: 1,
						actor: 'writer'
					})
				))[0]
			);
			expect(written.revision).toBe(2);
			expect(written.updated_by).toBe('writer');
			// A native command's fixed timestamp makes the later FK action observable without a sleep.
			yield* script(
				pg,
				`BEGIN; SET LOCAL store.write = '{"mode":"write","actor":null,"at":"2000-01-01T00:00:00Z"}';
			UPDATE child SET name = name WHERE id = 'child'; COMMIT`
			);
			const before = required((yield* execute(yield* db.read('child', { all: true }))).rows[0]);
			yield* execute(yield* db.delete('parent', { key: { id: 'parent' } }));
			const after = required(
				(yield* execute(
					yield* db.read('child', {
						select: {
							parent: true,
							name_upper: true,
							revision: true,
							updated_at: true,
							updated_by: true,
							created_at: true
						},
						all: true
					})
				)).rows[0]
			);
			expect(after.parent).toBeNull();
			expect(after.name_upper).toBe('KEPT');
			expect(after.revision).toBe(before.revision + 1);
			expect(after.updated_at).not.toEqual(before.updated_at);
			expect(after.updated_by).toBeNull();
			expect(after.created_at).toEqual(before.created_at);
			const stale = yield* Effect.flip(
				Effect.flatMap(
					db.update('child', {
						key: { id: 'child' },
						set: { name: 'Lost' },
						observed: before.revision
					}),
					execute
				)
			);
			expect(stale.code).toBe('stale');
			expect((yield* execute(yield* db.get('child', { id: 'child' })))?.name).toBe('Kept');
		})
);
