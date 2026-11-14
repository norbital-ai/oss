/** `HostApi.schema.carry`: an author's `migrations/` set on top of live's, every carried file replayed on PGlite. */
import { Effect } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { PgliteDb, Pristine } from '@norbital-ai/host-api/node';
import {
	build,
	executable,
	generate,
	INTROSPECT,
	IntrospectRow,
	lock_of,
	read_snapshot,
	snapshot_of,
	type MigrationFile,
	type SchemaSpec
} from '@norbital-ai/store';
import { carry_migrations } from '../src/engine/schema/carry.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { migration_lines, migration_objects } from '../src/engine/schema/migrations.ts';

const notes = (fields: SchemaSpec['tables'][string]['fields']): SchemaSpec => ({
	tz: 'UTC',
	currency: null,
	tables: { notes: { audit: true, fields } }
});
const TITLE = { title: { kind: 'text' } } as const;
const base = notes(TITLE);
const accepted = (sql: string) =>
	sql.replace(/^-- step (\S+) \(destructive\)\s*$/gm, '$&\n-- accept: $1');
/** What a build writes for a schema change. */
const generated = (from: SchemaSpec | null, to: SchemaSpec, number: number, name = 'schema') =>
	Effect.gen(function* () {
		const previous = from === null ? null : yield* read_snapshot(snapshot_of(from));
		const { file } = yield* generate(previous, to, { number, name }, migration_objects);
		return { ...file, sql: accepted(file.sql) };
	});
/** A tree's `migrations/`: the files, the snapshot of `schema` and the lock over both. */
const migrationsOf = (files: readonly MigrationFile[], schema: SchemaSpec) => {
	const snapshot = snapshot_of(schema);
	return {
		...Object.fromEntries(files.map((file) => [`migrations/${file.name}`, file.sql])),
		'migrations/snapshot.json': snapshot,
		'migrations/migrations.lock.json': lock_of(snapshot, files)
	};
};
const started = generated(null, base, 1, 'initial');
/** The definitions a history leaves on a pristine database, and those the schema itself leaves: a build's proof. */
const proved = (files: readonly MigrationFile[], schema: SchemaSpec) =>
	Effect.scoped(
		Effect.gen(function* () {
			const lines = (db: ReturnType<typeof PgliteDb.make>) =>
				TenantDb.typed(db)
					.rows(IntrospectRow, { text: INTROSPECT, params: [] })
					.pipe(Effect.map((rows) => [...new Set(migration_lines(rows, true, true))].sort()));
			const replayed = PgliteDb.make(yield* PgliteDb.open());
			for (const file of files) yield* replayed.write({ text: executable(file), params: [] });
			const declared = PgliteDb.make(yield* PgliteDb.open());
			yield* declared.write({
				text: [
					...(yield* build(schema)),
					...(yield* migration_objects(schema)).flatMap((object) => object.create)
				]
					.map((sql) => `${sql.trim().replace(/;$/, '')};`)
					.join('\n'),
				params: []
			});
			expect(yield* lines(replayed)).toEqual(yield* lines(declared));
		})
	).pipe(Effect.provide(Pristine.layer));
const fileOf = (name: string, sql: string | undefined): MigrationFile => ({ name, sql: sql ?? '' });

describe('schema.carry', () => {
	it.live(
		'renumbers the author on top of what merged first and regenerates what both tables share',
		() =>
			Effect.gen(function* () {
				const first = yield* started,
					ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
					cai = notes({ ...TITLE, archived: { kind: 'bool', optional: true } }),
					merged = yield* generated(base, ben, 2),
					mine = yield* generated(base, cai, 2);
				const [step, ...rest] = yield* carry_migrations({
					base: migrationsOf([first], base),
					live: migrationsOf([first, merged], ben),
					line: [migrationsOf([first, mine], cai)]
				});
				expect(rest).toEqual([]);
				expect(step).toMatchObject({
					path: 'migrations/0002_schema.sql',
					target: 'migrations/0003_schema.sql',
					clashes: [],
					at: 0
				});
				const sql = step?.text ?? '';
				expect(sql).toContain('-- 0003_schema.sql:');
				// the table's history schema lists every column, whoever added it
				expect(sql).toMatch(/bolt_history_register\('notes','[^']*"archived"[^']*"priority"/);
				expect(sql).not.toContain('add column "priority"');
				const schema = (yield* read_snapshot(step?.snapshot ?? '')).schema;
				expect(Object.keys(schema.tables.notes?.fields ?? {}).sort()).toEqual([
					'archived',
					'priority',
					'title'
				]);
				yield* proved([first, merged, fileOf('0003_schema.sql', sql)], schema);
			})
	);
	it.live('hands an edited generated file to the host to merge, with both generations', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				cai = notes({ ...TITLE, level: { kind: 'text', optional: true } }),
				merged = yield* generated(base, ben, 2),
				written = yield* generated(base, cai, 2),
				after = `-- step data:notes.tidy (data)\nupdate "notes" set "level" = lower("level");`,
				mine = `${written.sql}\n${after}\n`;
			const [step] = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [migrationsOf([first, { ...written, sql: mine }], cai)]
			});
			expect(step?.text).toBeUndefined();
			expect(step?.merge?.base).toBe(written.sql);
			expect(step?.merge?.theirs).toBe(mine);
			expect(step?.merge?.ours).toMatch(/bolt_history_register\('notes','[^']*"level"[^']*"priority"/);
			expect(step?.clashes).toEqual([]);
		})
	);
	it.live('keeps a line of migrations in order, each at the commit that brought it', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				one = notes({ ...TITLE, a: { kind: 'text', optional: true } }),
				two = notes({
					...TITLE,
					a: { kind: 'text', optional: true },
					b: { kind: 'text', optional: true }
				}),
				merged = yield* generated(base, ben, 2),
				mineOne = yield* generated(base, one, 2),
				mineTwo = yield* generated(one, two, 3);
			const steps = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [
					migrationsOf([first], base),
					migrationsOf([first, mineOne], one),
					migrationsOf([first, mineOne, mineTwo], two)
				]
			});
			expect(steps.map(({ target, at }) => ({ target, at }))).toEqual([
				{ target: 'migrations/0003_schema.sql', at: 1 },
				{ target: 'migrations/0004_schema.sql', at: 2 }
			]);
			yield* proved(
				[
					first,
					merged,
					fileOf('0003_schema.sql', steps[0]?.text),
					fileOf('0004_schema.sql', steps[1]?.text)
				],
				(yield* read_snapshot(steps[1]?.snapshot ?? '')).schema
			);
		})
	);
	it.live('stops on a column live already added or retyped, and keeps live’s', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				ana = notes({
					...TITLE,
					priority: { kind: 'enum', values: ['low', 'normal', 'high'], optional: true }
				}),
				merged = yield* generated(base, ben, 2),
				mine = yield* generated(base, ana, 2);
			const [step] = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [migrationsOf([first, mine], ana)]
			});
			expect(step?.clashes).toEqual([
				'Live changed notes.priority after your work started, and your work changes it too.'
			]);
			const schema = (yield* read_snapshot(step?.snapshot ?? '')).schema;
			expect(schema.tables.notes?.fields.priority).toEqual({ kind: 'int', optional: true });
		})
	);
	it.live('stops on a data step that uses a column live changed, though the author’s schema left it', () =>
		Effect.gen(function* () {
			const first = yield* started,
				wide = notes({ ...TITLE, size: { kind: 'int', optional: true } }),
				retyped = notes({ ...TITLE, size: { kind: 'text', optional: true } }),
				mineSchema = notes({
					...TITLE,
					size: { kind: 'int', optional: true },
					score: { kind: 'int', optional: true }
				}),
				second = yield* generated(base, wide, 2),
				merged = yield* generated(wide, retyped, 3),
				written = yield* generated(wide, mineSchema, 3),
				mine = { ...written, sql: `${written.sql}\nupdate "notes" set "score" = "size" + 1;\n` };
			const [step] = yield* carry_migrations({
				base: migrationsOf([first, second], wide),
				live: migrationsOf([first, second, merged], retyped),
				line: [migrationsOf([first, second, mine], mineSchema)]
			});
			expect(step?.target).toBe('migrations/0004_schema.sql');
			expect(step?.clashes).toEqual([
				'Your data step uses notes.size, which changed on live after your work started.'
			]);
			expect(step?.merge?.theirs).toContain('"score" = "size" + 1');
		})
	);
	it.live('carries what no schema explains as it stands: a file by hand, in its place in the line', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				merged = yield* generated(base, ben, 2),
				mine = {
					name: '0002_tidy.sql',
					sql: '-- 0002_tidy.sql\nupdate "notes" set "title" = trim("title");\n'
				};
			const [step] = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [migrationsOf([first, mine], base)]
			});
			expect(step).toMatchObject({
				target: 'migrations/0003_tidy.sql',
				text: '-- 0003_tidy.sql\nupdate "notes" set "title" = trim("title");\n',
				clashes: []
			});
			yield* proved(
				[first, merged, fileOf('0003_tidy.sql', step?.text)],
				(yield* read_snapshot(step?.snapshot ?? '')).schema
			);
		})
	);
	it.live('two generations in one commit have no schema between them: the first carries as it stands', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				one = notes({ ...TITLE, a: { kind: 'text', optional: true } }),
				two = notes({
					...TITLE,
					a: { kind: 'text', optional: true },
					b: { kind: 'text', optional: true }
				}),
				merged = yield* generated(base, ben, 2),
				mineOne = yield* generated(base, one, 2),
				mineTwo = yield* generated(one, two, 3);
			const steps = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [migrationsOf([first, mineOne, mineTwo], two)]
			});
			expect(steps.map(({ target }) => target)).toEqual([
				'migrations/0003_schema.sql',
				'migrations/0004_schema.sql'
			]);
			expect(steps[0]?.text).toContain('add column "a"');
			expect(steps[1]?.merge?.theirs).toContain('add column "b"');
		})
	);
	it.live('a file deleted and generated again under its number speaks for the new schema', () =>
		Effect.gen(function* () {
			const first = yield* started,
				ben = notes({ ...TITLE, priority: { kind: 'int', optional: true } }),
				dropped = notes({ ...TITLE, a: { kind: 'text', optional: true } }),
				kept = notes({ ...TITLE, b: { kind: 'text', optional: true } }),
				merged = yield* generated(base, ben, 2),
				old = yield* generated(base, dropped, 2),
				mine = yield* generated(base, kept, 2);
			const [step] = yield* carry_migrations({
				base: migrationsOf([first], base),
				live: migrationsOf([first, merged], ben),
				line: [
					migrationsOf([first, old], dropped),
					migrationsOf([first], base),
					migrationsOf([first, mine], kept)
				]
			});
			expect(step?.at).toBe(2);
			expect(step?.text).toContain('add column "b"');
			expect(step?.text).not.toContain('add column "a"');
		})
	);
	it.live('fails when the generator cannot write the author’s migration on live', () =>
		Effect.gen(function* () {
			const start = notes({ ...TITLE, a: { kind: 'text', optional: true } }),
				first = yield* generated(null, start, 1, 'initial'),
				dropped = notes(TITLE),
				renamed = notes({ ...TITLE, b: { kind: 'text', optional: true, was: 'a' } }),
				merged = yield* generated(start, dropped, 2),
				mine = yield* generated(start, renamed, 2);
			const failed = yield* Effect.flip(
				carry_migrations({
					base: migrationsOf([first], start),
					live: migrationsOf([first, merged], dropped),
					line: [migrationsOf([first, mine], renamed)]
				})
			);
			expect(failed.message).not.toBe('');
		})
	);
	it.live('leaves a line with no migration of its own alone', () =>
		Effect.gen(function* () {
			const first = yield* started,
				merged = yield* generated(base, notes(TITLE), 2);
			expect(
				yield* carry_migrations({
					base: migrationsOf([first], base),
					live: migrationsOf([first, merged], base),
					line: [migrationsOf([first], base)]
				})
			).toEqual([]);
		})
	);
});
