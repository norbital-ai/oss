import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { Effect, FileSystem, Schema } from 'effect';
import { APPLIED, AppliedRow, checksumOf, type MigrationFile } from '@norbital-ai/store';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import * as engineSchema from '../src/engine/schema/engine.ts';
import {
	applyMigrations,
	readMigrations,
	type MigrationBundle
} from '../src/engine/schema/migrations.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { PostgresDb, type PgClient } from '../src/node/db/postgres.ts';
import type { TenantDbShape } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { SYSTEM } from '../src/system/index.ts';
import { impactLines } from '../src/protocol/migration-impact.ts';
import { manifest } from './engine-fixture.ts';

const initial: EngineManifest = {
	...manifest,
	models: { entry: { description: 'An entry', label: 'name', fields: { name: { kind: 'text' } } } },
	relationships: {},
	exposures: { entry: { read: { entry: { fields: 'all' } } } },
	policies: {}
};
const extended: EngineManifest = {
	...initial,
	models: {
		entry: {
			description: 'An entry',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				note: { kind: 'text', optional: true }
			}
		}
	}
};
const ranked: EngineManifest = {
	...extended,
	models: {
		entry: {
			description: 'An entry',
			label: 'name',
			fields: {
				name: { kind: 'text' },
				note: { kind: 'text', optional: true },
				rank: { kind: 'int', optional: true }
			}
		}
	}
};
const blank: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};
const root = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* scratchPath(`migrations-${randomUUID()}`);
	yield* fs.makeDirectory(directory, { recursive: true });
	return yield* Effect.acquireRelease(Effect.succeed(directory), (directory) =>
		fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)
	);
});
// Generated once per file: each test copies the exact tree `prepareMigrations` would have written in its own folder.
let fixtureRoot: string | undefined;
afterAll(() => {
	if (fixtureRoot !== undefined) rmSync(fixtureRoot, { recursive: true, force: true });
});
const fixtures = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* scratchPath(`migrations-fixture-${randomUUID()}`);
			fixtureRoot = root;
			const at = { root, initial: join(root, 'initial'), extended: join(root, 'extended') };
			yield* fs.makeDirectory(at.initial, { recursive: true });
			yield* prepareMigrations(at.initial, initial, 'generate');
			yield* fs.copy(at.initial, at.extended);
			yield* prepareMigrations(at.extended, extended, 'generate');
			// The database a fresh PGlite reaches by applying the initial history.
			const applied = yield* Effect.scoped(
				Effect.gen(function* () {
					const pg = yield* PgliteDb.open();
					yield* applyMigrations(
						PgliteDb.make(pg),
						initial,
						yield* readMigrations(join(at.initial, 'migrations'))
					);
					return yield* Effect.promise(() => pg.dumpDataDir('none'));
				})
			);
			return { ...at, applied };
		})
	)
);
// Built outside any one test's time budget.
beforeAll(() =>
	Effect.runPromise(
		fixtures.pipe(Effect.asVoid, Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	)
);
/** `extended` squashed (`first_release`), extended by `ranked`, squashed again and verified; each stage's bundle. */
const twiceSquashed = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const at = yield* fixtures;
			const directory = join(at.root, 'squashed');
			const source = join(directory, 'migrations');
			yield* fs.copy(at.extended, directory);
			const first = yield* readMigrations(join(at.initial, 'migrations'));
			const originals = yield* readMigrations(source);
			yield* prepareMigrations(directory, extended, 'generate', { squash: 'first_release' });
			const squashed = yield* readMigrations(source);
			yield* prepareMigrations(directory, ranked, 'generate');
			const withSuffix = yield* readMigrations(source);
			yield* prepareMigrations(directory, ranked, 'generate', { squash: 'second_release' });
			yield* prepareMigrations(directory, ranked, 'verify');
			return {
				source,
				first,
				originals,
				squashed,
				withSuffix,
				final: yield* readMigrations(source)
			};
		})
	)
);
/** A scope-owned folder holding the generated `initial` or `initial`+`extended` history. */
const generated = Effect.fn('test.generatedMigrations')(function* (from: 'initial' | 'extended') {
	const directory = yield* root;
	yield* (yield* FileSystem.FileSystem).copy((yield* fixtures)[from], directory, {
		overwrite: true
	});
	return directory;
});
/** A scope-owned database with the initial history applied. */
const appliedDb = Effect.gen(function* () {
	return PgliteDb.make(yield* PgliteDb.open((yield* fixtures).applied));
});
const sourceTree = Effect.fn('test.migrationSourceTree')(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem;
	const names = (yield* fs.readDirectory(directory, { recursive: true })).sort();
	return yield* Effect.forEach(names, (name) =>
		Effect.gen(function* () {
			const at = join(directory, name);
			const type = (yield* fs.stat(at)).type;
			return { name, type, text: type === 'File' ? yield* fs.readFileString(at) : null };
		})
	);
});
const ID = '11111111-1111-1111-1111-111111111111';
const Rows = Schema.Struct({ name: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });

describe('committed workspace migrations', () => {
	it.live(
		'squashes a schema prefix and preserves a procedural data suffix for fresh and existing databases',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('extended');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const existing = yield* appliedDb;
					yield* existing.write({
						text: 'insert into entry (id,name) values ($1,$2)',
						params: [ID, 'Kept']
					});
					const tail = '0003_import.sql';
					const sql =
						"do $$ begin insert into entry(id,name) values ('22222222-2222-2222-2222-222222222222','Imported'); end $$;\n";
					yield* fs.writeFileString(join(source, tail), sql);
					yield* prepareMigrations(directory, extended, 'generate');
					yield* prepareMigrations(directory, extended, 'generate', { squash: 'prefix' });
					const bundle = yield* readMigrations(source);
					expect(bundle.lock.squashes?.[0]?.replaces.map((file) => file.name)).toEqual([
						'0001_initial.sql',
						'0002_schema.sql'
					]);
					expect(yield* fs.readFileString(join(source, tail))).toBe(sql);
					yield* prepareMigrations(directory, extended, 'verify');
					const fresh = PgliteDb.make(yield* PgliteDb.open());
					yield* applyMigrations(fresh, extended, bundle);
					yield* applyMigrations(existing, extended, bundle);
					expect(
						yield* fresh.rows(Rows, { text: 'select name from entry order by name', params: [] })
					).toEqual([{ name: 'Imported' }]);
					expect(
						yield* existing.rows(Rows, { text: 'select name from entry order by name', params: [] })
					).toEqual([{ name: 'Imported' }, { name: 'Kept' }]);
					expect(
						(yield* fresh.rows(AppliedRow, { text: APPLIED, params: [] })).map((row) => row.name)
					).toEqual([bundle.squashes[0]?.name, tail]);
					expect(
						(yield* existing.rows(AppliedRow, { text: APPLIED, params: [] })).map((row) => row.name)
					).toEqual(bundle.files.map((file) => file.name));
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);
	it.live('answers each step’s rows and the migrate’s duration', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('extended');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const db = yield* appliedDb;
				for (const params of [
					[ID, 'Kept'],
					['22222222-2222-2222-2222-222222222222', 'Other']
				])
					yield* db.write({ text: 'insert into entry (id,name) values ($1,$2)', params });
				yield* fs.writeFileString(
					join(source, '0003_refill.sql'),
					[
						'-- step fill:entry.note (backfill)',
						"update entry set note = 'kept' where name = 'Kept';",
						'-- step drop:column:entry.note (destructive)',
						'-- accept: drop:column:entry.note',
						'alter table "entry" drop column "note";',
						'alter table "entry" add column "note" text;',
						''
					].join('\n')
				);
				yield* prepareMigrations(directory, extended, 'generate');
				const impact = yield* applyMigrations(db, extended, yield* readMigrations(source));
				expect(impact.durationMs).toBeGreaterThanOrEqual(0);
				expect(impact.steps.filter((step) => step.hazard !== 'additive')).toEqual([
					{ id: 'fill:entry.note', hazard: 'backfill', rows: 1, summary: 'Fills note on 1 entry' },
					{
						id: 'drop:column:entry.note',
						hazard: 'destructive',
						rows: 1,
						summary: 'Drops column entry.note — 1 row with a value'
					}
				]);
				expect(impactLines(impact).at(-1)).toBe(
					'Expected downtime about 1 s (measured on the preview)'
				);
				expect((yield* applyMigrations(db, extended, yield* readMigrations(source))).steps).toEqual(
					[]
				);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);
	it.live(
		'replays and applies the complete blank engine schema, including builtin unique indexes',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* root;
					yield* prepareMigrations(directory, blank, 'generate');
					const bundle = yield* readMigrations(join(directory, 'migrations'));
					expect(Object.keys(bundle.snapshot.tables).sort()).toEqual(
						Object.keys(SYSTEM.models).sort()
					);
					const db = PgliteDb.make(yield* PgliteDb.open());
					yield* applyMigrations(db, blank, bundle);
					yield* applyMigrations(db, blank, bundle);
					expect(
						yield* db.rows(Schema.Struct({ name: Schema.String, checksum: Schema.String }), {
							text: 'select name,checksum from store_migration order by name',
							params: []
						})
					).toEqual(bundle.files.map((file) => ({ name: file.name, checksum: checksumOf(file) })));
					expect(
						yield* db.rows(
							Schema.Struct({ unique_index: Schema.Boolean, expression: Schema.String }),
							{
								text: "select indisunique as unique_index,pg_get_expr(indexprs,indrelid) as expression from pg_index where indrelid='sys_user'::regclass and indexprs is not null",
								params: []
							}
						)
					).toEqual([{ unique_index: true, expression: 'lower(email)' }]);
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('both native adapters execute complete SQL scripts and roll back a failing script', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* PgliteDb.open();
				const named: string[] = [];
				const client: PgClient = {
					async query(query) {
						if (query.name !== undefined) named.push(query.name);
						const results = await pg.exec(query.text);
						return results.map((result) => ({
							rows: [
								...Schema.decodeUnknownSync(
									Schema.Array(Schema.Record(Schema.String, Schema.Json))
								)(result.rows)
							],
							rowCount: result.affectedRows ?? result.rows.length
						}));
					},
					release() {}
				};
				const adapters = [PgliteDb.make(pg), PostgresDb.make({ connect: async () => client })];
				for (const [index, db] of adapters.entries()) {
					const name = `script_${index}`;
					const result = yield* db.transaction({
						statements: [
							{
								text: `create table ${name} (n int primary key); insert into ${name} values (1); select n from ${name}`,
								params: []
							}
						]
					});
					expect(result[0]?.rows).toEqual([{ n: 1 }]);
					const failure = yield* Effect.flip(
						db.transaction({
							statements: [{ text: `insert into ${name} values (2); select 1/0`, params: [] }]
						})
					);
					expect(failure).toMatchObject({ sqlstate: '22012' });
					expect(
						yield* db.rows(Count, { text: `select count(*)::int as n from ${name}`, params: [] })
					).toEqual([{ n: 1 }]);
				}
				expect(named).toEqual([]);
			})
		).pipe(Effect.provide(Pristine.layer))
	);

	it.live('generates editable source, verifies its lock, and applies a file exactly once', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('initial');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const bundled = yield* readMigrations(source);
				expect(bundled.files.map((file) => file.name)).toEqual(['0001_initial.sql']);
				const file = bundled.files[0];
				if (file === undefined) return yield* Effect.die('initial migration missing');
				expect(file.sql).toContain('-- hazard:');
				const edited = `${file.sql}\ninsert into entry (id, name) values ('${ID}', 'Authored');\n`;
				yield* fs.writeFileString(join(source, file.name), edited);
				const stale = yield* Effect.flip(prepareMigrations(directory, initial, 'verify'));
				expect(stale).toMatchObject({ code: 'migrationChanged' });
				yield* prepareMigrations(directory, initial, 'generate');
				expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
				yield* prepareMigrations(directory, initial, 'verify');
				const bundle = yield* readMigrations(source);
				const db = PgliteDb.make(yield* PgliteDb.open());
				yield* applyMigrations(db, initial, bundle);
				yield* applyMigrations(db, initial, bundle);
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Authored' }
				]);
				expect(
					yield* db.rows(Count, {
						text: 'select count(*)::int as n from store_migration',
						params: []
					})
				).toEqual([{ n: 1 }]);
				const unsafeSquash = yield* Effect.flip(
					prepareMigrations(directory, initial, 'generate', { squash: 'unsafe_data' })
				);
				expect(unsafeSquash).toMatchObject({ code: 'migrationInvalid' });
				expect((yield* readMigrations(source)).files).toEqual(bundle.files);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'requires verified physical definitions and derives missing metadata without changing history',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('initial');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const before = yield* readMigrations(source);
					const lock = yield* fs.readFileString(join(source, 'migrations.lock.json'));
					const physical = yield* fs.readFileString(join(source, 'physical.json'));
					yield* fs.remove(join(source, 'physical.json'));
					expect(yield* Effect.flip(readMigrations(source))).toMatchObject({
						code: 'migrationChanged'
					});
					expect(yield* Effect.flip(prepareMigrations(directory, initial, 'verify'))).toMatchObject(
						{ code: 'migrationChanged' }
					);
					yield* prepareMigrations(directory, initial, 'generate');
					expect(yield* fs.readFileString(join(source, 'physical.json'))).toBe(physical);
					expect(yield* fs.readFileString(join(source, 'migrations.lock.json'))).toBe(lock);
					expect((yield* readMigrations(source)).files).toEqual(before.files);
					yield* fs.writeFileString(
						join(source, 'physical.json'),
						JSON.stringify({ ...before.physical, '': ['table forged r p rls false force false'] })
					);
					expect(yield* Effect.flip(readMigrations(source))).toMatchObject({
						code: 'migrationChanged'
					});
					expect(yield* Effect.flip(prepareMigrations(directory, initial, 'verify'))).toMatchObject(
						{ code: 'migrationChanged' }
					);
					yield* prepareMigrations(directory, initial, 'generate');
					expect(yield* fs.readFileString(join(source, 'physical.json'))).toBe(physical);
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('rechecks physical drift under the SQL batch lock before pending DDL', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('extended');
				const source = join(directory, 'migrations');
				const db = yield* appliedDb;
				let raced = false;
				const concurrent: TenantDbShape = {
					...db,
					transaction: (batch) =>
						Effect.gen(function* () {
							if (!raced) {
								raced = true;
								yield* db.write({
									text: 'alter table entry add column unexpected text',
									params: []
								});
							}
							return yield* db.transaction(batch);
						})
				};
				expect(
					yield* Effect.flip(applyMigrations(concurrent, extended, yield* readMigrations(source)))
				).toMatchObject({ code: 'migrationChanged' });
				expect(raced).toBe(true);
				expect(
					yield* db.value(Schema.Boolean, {
						text: "select exists(select 1 from information_schema.columns where table_name='entry' and column_name='note')",
						params: []
					})
				).toBe(false);
				expect(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).toEqual([
					{
						name: '0001_initial.sql',
						checksum: checksumOf((yield* readMigrations(source)).files[0]!)
					}
				]);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('rolls back live-data-dependent schema drift and its ledger receipt', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('extended');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const db = yield* appliedDb;
				yield* db.write({ text: 'insert into entry(id,name) values($1,$2)', params: [ID, 'Live'] });
				const pending = (yield* readMigrations(source)).files[1];
				if (pending === undefined) return yield* Effect.die('second migration missing');
				yield* fs.writeFileString(
					join(source, pending.name),
					`${pending.sql}\ndo $$ begin if exists(select 1 from entry where name='Live') then alter table entry drop column note; update entry set name='Changed'; end if; end $$;\n`
				);
				// Scratch replay has no live rows: the host must independently compare the actual post-file schema.
				yield* prepareMigrations(directory, extended, 'generate');
				expect(
					yield* Effect.flip(applyMigrations(db, extended, yield* readMigrations(source)))
				).toMatchObject({ code: 'migrationInvalid', phase: 'commit' });
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Live' }
				]);
				expect(
					yield* db.value(Schema.Boolean, {
						text: "select exists(select 1 from information_schema.columns where table_name='entry' and column_name='note')",
						params: []
					})
				).toBe(false);
				expect(
					yield* db.rows(Count, {
						text: 'select count(*)::int as n from store_migration',
						params: []
					})
				).toEqual([{ n: 1 }]);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('refuses changed applied text even after its source has been replay verified again', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('initial');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const bundle = yield* readMigrations(source);
				const db = yield* appliedDb;
				const file = bundle.files[0];
				if (file === undefined) return yield* Effect.die('initial migration missing');
				yield* fs.writeFileString(join(source, file.name), `${file.sql}\n-- edited after apply\n`);
				yield* prepareMigrations(directory, initial, 'generate');
				const failure = yield* Effect.flip(
					applyMigrations(db, initial, yield* readMigrations(source))
				);
				expect(failure).toMatchObject({ code: 'migrationChanged' });
				expect(failure.message).toContain('applied with other text');
				expect(
					yield* db.rows(Count, {
						text: 'select count(*)::int as n from store_migration',
						params: []
					})
				).toEqual([{ n: 1 }]);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'rejects changed native source, edited definitions and omitted columns without refreshing their proof',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('extended');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const bundle = yield* readMigrations(source);
					const file = bundle.files[1];
					if (file === undefined) return yield* Effect.die('second migration missing');
					const lockPath = join(source, 'migrations.lock.json');
					const verified = yield* fs.readFileString(lockPath);
					yield* prepareMigrations(directory, extended, 'verify');
					const cachePath = join(directory, '.norbital', 'cache', 'migrations.sha256');
					const cached = yield* fs.readFileString(cachePath);
					const before = yield* sourceTree(source);
					const native = engineSchema.sourceObjects();
					const audit = native.find((object) => object.id === 'engine:bolt_audit');
					if (
						audit === undefined ||
						!audit.create.some((sql) => /^create or replace function bolt_audit\(\)/i.test(sql))
					)
						return yield* Effect.die('native audit function source missing');
					const changed = vi.spyOn(engineSchema, 'sourceObjects').mockReturnValue(
						native.map((object) =>
							object.id === audit.id
								? {
										...object,
										create: object.create.map((sql) =>
											/^create or replace function bolt_audit\(\)/i.test(sql)
												? 'create or replace function bolt_audit() returns trigger language plpgsql as $$ begin return null; end $$;'
												: sql
										)
									}
								: object
						)
					);
					yield* Effect.gen(function* () {
						const failure = yield* Effect.flip(prepareMigrations(directory, extended, 'verify'));
						expect(failure).toMatchObject({ code: 'migrationInvalid' });
						expect(failure.message).toContain('function bolt_audit');
						expect(yield* fs.readFileString(cachePath)).toBe(cached);
						expect(yield* sourceTree(source)).toEqual(before);
					}).pipe(Effect.ensuring(Effect.sync(() => changed.mockRestore())));
					yield* prepareMigrations(directory, extended, 'verify');
					for (const [sql, definition] of [
						[
							'create or replace function bolt_audit() returns trigger language plpgsql as $$ begin return null; end $$;',
							'function bolt_audit'
						],
						['drop trigger bolt_audit on entry;', 'trigger entry.bolt_audit'],
						[
							'alter table bolt_history alter column actor type varchar(10);',
							'column bolt_history.actor'
						]
					] satisfies readonly (readonly [string, string])[]) {
						const edited = `${file.sql}\n${sql}\n`;
						yield* fs.writeFileString(join(source, file.name), edited);
						const failure = yield* Effect.flip(prepareMigrations(directory, extended, 'generate'));
						expect(failure).toMatchObject({ code: 'migrationInvalid' });
						expect(failure.message).toContain(definition);
						expect(yield* fs.readFileString(lockPath)).toBe(verified);
						expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
					}
					const omitted = 'alter table "entry" add column "note" text;';
					expect(file.sql).toContain(omitted);
					const edited = file.sql.replace(omitted, '');
					yield* fs.writeFileString(join(source, file.name), edited);
					const failure = yield* Effect.flip(prepareMigrations(directory, extended, 'generate'));
					expect(failure).toMatchObject({ code: 'migrationInvalid' });
					expect(failure.message).toContain('missing column entry.note text');
					expect(yield* fs.readFileString(lockPath)).toBe(verified);
					expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
					expect(yield* Effect.flip(readMigrations(source))).toMatchObject({
						code: 'migrationChanged'
					});
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'a runtime function body changed by a Bolt release becomes the next migration, and its history verifies',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('extended');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const body =
						'create or replace function bolt_audit() returns trigger language plpgsql as $$ begin return null; end $$;';
					const native = engineSchema.sourceObjects();
					const changed = vi.spyOn(engineSchema, 'sourceObjects').mockReturnValue(
						native.map((object) =>
							object.id === 'engine:bolt_audit'
								? {
										...object,
										create: object.create.map((sql) =>
											/^create or replace function bolt_audit\(\)/i.test(sql) ? body : sql
										)
									}
								: object
						)
					);
					yield* Effect.gen(function* () {
						yield* prepareMigrations(directory, extended, 'generate');
						const sql = yield* fs.readFileString(join(source, '0003_runtime_functions.sql'));
						expect(sql).toContain(body.slice(0, -1));
						expect(sql).not.toContain('bolt_audit_mark');
						yield* prepareMigrations(directory, extended, 'verify');
						// nothing left to re-create
						yield* prepareMigrations(directory, extended, 'generate');
						expect((yield* readMigrations(source)).files.map((file) => file.name)).toHaveLength(3);
					}).pipe(Effect.ensuring(Effect.sync(() => changed.mockRestore())));
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);
	it.live('rejects a changed physical proof without rewriting the edited lock', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('initial');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const bundle = yield* readMigrations(source);
				const file = bundle.files[0];
				if (file === undefined) return yield* Effect.die('initial migration missing');
				const lockPath = join(source, 'migrations.lock.json');
				const edited = JSON.stringify({
					...bundle.lock,
					physical: { ...bundle.lock.physical, [file.name]: '0'.repeat(64) }
				});
				yield* fs.writeFileString(lockPath, edited);
				expect(yield* Effect.flip(prepareMigrations(directory, initial, 'verify'))).toMatchObject({
					code: 'migrationChanged'
				});
				expect(yield* fs.readFileString(lockPath)).toBe(edited);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'rejects edited identity-sequence configuration even when the column stays an identity',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('initial');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const bundle = yield* readMigrations(source);
					const file = bundle.files[0];
					if (file === undefined) return yield* Effect.die('initial migration missing');
					const db = yield* appliedDb;
					const sequence = yield* db.value(Schema.String, {
						text: "select pg_get_serial_sequence('sys_message', 'seq')",
						params: []
					});
					const lockPath = join(source, 'migrations.lock.json');
					const verified = yield* fs.readFileString(lockPath);
					const edited = `${file.sql}\nalter sequence ${sequence} increment by 7;\n`;
					yield* fs.writeFileString(join(source, file.name), edited);
					expect(yield* Effect.flip(prepareMigrations(directory, initial, 'verify'))).toMatchObject(
						{ code: 'migrationChanged' }
					);
					const refused = yield* Effect.flip(prepareMigrations(directory, initial, 'generate'));
					expect(refused).toMatchObject({ code: 'migrationInvalid' });
					expect(refused.message).toContain('sequence sys_message.seq');
					expect(yield* fs.readFileString(lockPath)).toBe(verified);
					expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('refuses verify mode squashing without changing source or its cached proof', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('initial');
				const fs = yield* FileSystem.FileSystem;
				yield* prepareMigrations(directory, initial, 'verify');
				for (const cached of [true, false]) {
					if (!cached) yield* fs.remove(join(directory, '.norbital', 'cache', 'migrations.sha256'));
					const before = yield* sourceTree(directory);
					expect(
						yield* Effect.flip(
							prepareMigrations(directory, initial, 'verify', { squash: 'forbidden' })
						)
					).toMatchObject({ code: 'migrationInvalid' });
					expect(yield* sourceTree(directory)).toEqual(before);
				}
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('refuses live physical drift even when the migration checksums still match', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* root;
				yield* prepareMigrations(directory, extended, 'generate');
				const bundle = yield* readMigrations(join(directory, 'migrations'));
				const db = PgliteDb.make(yield* PgliteDb.open());
				yield* applyMigrations(db, extended, bundle);
				yield* db.write({
					text: 'insert into entry (id, name) values ($1, $2)',
					params: [ID, 'Kept']
				});
				const history = yield* db.rows(AppliedRow, { text: APPLIED, params: [] });
				yield* db.write({ text: 'alter table entry drop column note', params: [] });
				const drift = yield* Effect.flip(applyMigrations(db, extended, bundle));
				expect(drift).toMatchObject({ code: 'migrationChanged' });
				expect(drift.message).toContain('differs from its verified migration prefix');
				expect(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).toEqual(history);
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Kept' }
				]);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('keeps table-local trigger names and extra function overloads visible as drift', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const bundle = yield* readMigrations(join(yield* generated('initial'), 'migrations'));
				const mutations = [
					'create trigger bolt_notice_push after insert on entry referencing new table as fresh for each statement execute function bolt_notice_push()',
					"create function bolt_assert(foo text) returns text language sql immutable as 'select foo'"
				];
				for (const sql of mutations)
					yield* Effect.scoped(
						Effect.gen(function* () {
							const db = yield* appliedDb;
							yield* db.write({
								text: 'insert into entry (id, name) values ($1, $2)',
								params: [ID, 'Kept']
							});
							const history = yield* db.rows(AppliedRow, { text: APPLIED, params: [] });
							yield* db.write({ text: sql, params: [] });
							const drift = yield* Effect.flip(applyMigrations(db, initial, bundle));
							expect(drift).toMatchObject({ code: 'migrationChanged' });
							expect(drift.message).toContain('differs from its verified migration prefix');
							expect(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).toEqual(history);
							expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
								{ name: 'Kept' }
							]);
						})
					);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'squashes a released history twice, keeping every original file and archive byte-for-byte',
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const { source, originals, squashed, withSuffix, final } = yield* twiceSquashed;
				expect(squashed.squashes).toHaveLength(1);
				expect(squashed.files).toEqual(originals.files);
				expect(Object.keys(squashed.lock.files).sort()).toEqual(
					originals.files.map((file) => file.name)
				);
				expect(withSuffix.files.at(-1)?.name).toBe('0003_schema.sql');
				expect(final.squashes).toHaveLength(2);
				expect(final.files).toEqual(withSuffix.files);
				for (const receipt of final.lock.squashes ?? [])
					for (const original of final.files.slice(0, receipt.replaces.length))
						expect(
							yield* fs.readFileString(join(source, 'archive', receipt.archive, original.name))
						).toBe(original.sql);
			}).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	for (const name of ['Fresh', 'Partial originals', 'Older baseline'] as const)
		it.live(`after two squashes, the ${name.toLowerCase()} history finishes its exact suffix`, () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { first, squashed, withSuffix, final } = yield* twiceSquashed;
					const baseline = squashed.squashes[0];
					const suffix = withSuffix.files.at(-1);
					const newest = final.squashes.find((file) => file.name !== baseline?.name);
					if (baseline === undefined || suffix === undefined || newest === undefined)
						return yield* Effect.die('squashed history missing');
					const scenario: {
						start: { manifest: EngineManifest; bundle: MigrationBundle; note: boolean } | null;
						history: readonly MigrationFile[];
					} =
						name === 'Fresh'
							? { start: null, history: [newest] }
							: name === 'Partial originals'
								? {
										start: { manifest: initial, bundle: first, note: false },
										history: final.files
									}
								: {
										start: { manifest: extended, bundle: squashed, note: true },
										history: [baseline, suffix]
									};
					const Entry = Schema.Struct({
						name: Schema.String,
						note: Schema.NullOr(Schema.String),
						rank: Schema.NullOr(Schema.Number)
					});
					const db = PgliteDb.make(yield* PgliteDb.open());
					const note = scenario.start?.note === true ? 'Kept note' : null;
					if (scenario.start !== null) {
						yield* applyMigrations(db, scenario.start.manifest, scenario.start.bundle);
						yield* db.write(
							note === null
								? {
										text: 'insert into entry (id, name) values ($1, $2)',
										params: [ID, name]
									}
								: {
										text: 'insert into entry (id, name, note) values ($1, $2, $3)',
										params: [ID, name, note]
									}
						);
					}
					yield* applyMigrations(db, ranked, final);
					if (scenario.start === null)
						yield* db.write({
							text: 'insert into entry (id, name) values ($1, $2)',
							params: [ID, name]
						});
					const expected = scenario.history.map((file) => ({
						name: file.name,
						checksum: checksumOf(file)
					}));
					expect(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).toEqual(expected);
					expect(
						yield* db.rows(Entry, { text: 'select name,note,rank from entry', params: [] })
					).toEqual([{ name, note, rank: null }]);
					yield* applyMigrations(db, ranked, final);
					expect(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).toEqual(expected);
					expect(
						yield* db.rows(Entry, { text: 'select name,note,rank from entry', params: [] })
					).toEqual([{ name, note, rank: null }]);
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
		);

	it.live(
		'rolls back a file, its data changes and its checksum record when live rows refuse it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* generated('extended');
					const fs = yield* FileSystem.FileSystem;
					const source = join(directory, 'migrations');
					const db = yield* appliedDb;
					yield* db.write({
						text: 'insert into entry (id, name) values ($1, $2)',
						params: [ID, 'Kept']
					});
					const bundle = yield* readMigrations(source);
					const file = bundle.files[1];
					if (file === undefined) return yield* Effect.die('second migration missing');
					// Scratch replay has no entries; this collision occurs only against the live database's existing row.
					const edited = `${file.sql}\nupdate entry set name = 'Changed';\ninsert into entry (id, name) select id, 'Duplicate' from entry;\n`;
					yield* fs.writeFileString(join(source, file.name), edited);
					yield* prepareMigrations(directory, extended, 'generate');
					const failure = yield* Effect.flip(
						applyMigrations(db, extended, yield* readMigrations(source))
					);
					expect(failure).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
					expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
						{ name: 'Kept' }
					]);
					expect(
						yield* db.rows(Count, {
							text: 'select count(*)::int as n from store_migration',
							params: []
						})
					).toEqual([{ n: 1 }]);
					expect(
						yield* db.rows(Count, {
							text: "select count(*)::int as n from information_schema.columns where table_schema = 'public' and table_name = 'entry' and column_name = 'note'",
							params: []
						})
					).toEqual([{ n: 0 }]);
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live('a check block rolls back the file and its receipt while its query returns rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* generated('extended');
				const fs = yield* FileSystem.FileSystem;
				const source = join(directory, 'migrations');
				const db = yield* appliedDb;
				yield* db.write({
					text: `insert into entry (id, name) values ('${ID}', 'bad')`,
					params: []
				});
				const second = join(source, '0002_schema.sql');
				yield* fs.writeFileString(
					second,
					`${yield* fs.readFileString(second)}\n-- check: no_bad_names\nselect id from entry where name = 'bad';\n`
				);
				yield* prepareMigrations(directory, extended, 'generate');
				const bundle = yield* readMigrations(source);
				const refused = yield* Effect.flip(applyMigrations(db, extended, bundle));
				expect(String(refused.message)).toContain('check no_bad_names failed: 1 row(s)');
				expect(
					yield* db.rows(Count, {
						text: 'select count(*)::int as n from store_migration',
						params: []
					})
				).toEqual([{ n: 1 }]);
				yield* db.write({ text: "update entry set name = 'good'", params: [] });
				yield* applyMigrations(db, extended, bundle);
				expect(
					yield* db.rows(Count, {
						text: 'select count(*)::int as n from store_migration',
						params: []
					})
				).toEqual([{ n: 2 }]);
			})
		).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);

	it.live(
		'rejects a missing folder, changed snapshot and schema changes without a source migration',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const directory = yield* root;
					const source = join(directory, 'migrations');
					const missing = yield* Effect.flip(readMigrations(source));
					expect(missing).toMatchObject({ code: 'migrationInvalid' });
					yield* prepareMigrations(directory, initial, 'generate');
					const db = PgliteDb.make(yield* PgliteDb.open());
					const bundle = yield* readMigrations(source);
					const moved = yield* Effect.flip(applyMigrations(db, extended, bundle));
					expect(moved).toMatchObject({ code: 'schemaMoved' });
					const fs = yield* FileSystem.FileSystem;
					const file = join(source, 'snapshot.json');
					yield* fs.writeFileString(file, `${yield* fs.readFileString(file)}\n`);
					const changed = yield* Effect.flip(readMigrations(source));
					expect(changed).toMatchObject({ code: 'migrationChanged' });
				})
			).pipe(Effect.provide(NodeServices.layer), Effect.provide(Pristine.layer))
	);
});
