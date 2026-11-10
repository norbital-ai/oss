import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import {
	APPLIED,
	AppliedRow,
	checksumOf,
	generate,
	executable,
	INTROSPECT,
	IntrospectRow,
	lockOf,
	MIGRATIONS_TABLE,
	physicalDefinitionsOf,
	physicalHash,
	recordApplied
} from '@norbital-ai/store';
import { Decimal } from '@norbital-ai/std/decimal';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { prepareMigrations } from '../src/compiler/migrations.ts';
import {
	applyMigrations,
	migrationLines,
	readMigrations,
	migrationSchema
} from '../../bolt/src/engine/schema/migrations.ts';
import { sourceObjects } from '../../bolt/src/engine/schema/engine.ts';
import { auditTriggers } from '../../bolt/src/engine/schema/audit.ts';
import { PgliteDb } from '../../bolt/src/node/db/pglite.ts';
import { TestDb } from '../src/test/database.ts';
import type { TenantDbShape } from '../../bolt/src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { manifest } from '../../bolt/tests/engine-fixture.ts';
import { readHistory } from '../../bolt/src/engine/query/history.ts';
import { HistorySnapshotSchema } from '../../bolt/src/protocol/record-contracts.ts';

const initial: EngineManifest = {
	...manifest,
	models: { entry: { description: 'An entry', label: 'name', fields: { name: { kind: 'text' } } } },
	relationships: {},
	exposures: { entry: { outputs: { default: { entry: { fields: 'all' } } } } },
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
const root = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* scratchPath(`migrations-${randomUUID()}`);
	yield* fs.makeDirectory(directory, { recursive: true });
	return yield* Effect.acquireRelease(Effect.succeed(directory), (directory) =>
		fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie)
	);
});
const ID = '11111111-1111-1111-1111-111111111111';
const Rows = Schema.Struct({ name: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });
const receipts = (db: TenantDbShape) =>
	db.rows(Count, { text: 'select count(*)::int as n from store_migration', params: [] });

// Squash history, `was` renames, drift, snapshot and checksum refusals are Store's (store/tests/migration-history,
// migrate); this file owns Bolt's edge: generated editable source and its application to a live database.
/** The audit source a Bolt release before history schemas wrote. */
const legacyAudit: Parameters<typeof generate>[3] = (schema) => [
	...sourceObjects()
		.filter(
			(object) =>
				!['engine:bolt_history_register', 'engine:bolt_history_schemas'].includes(object.id)
		)
		.map((object) => ({
			...object,
			create: object.create.map((sql) =>
				sql
					.replace(/\t\tif to_regclass\('bolt_history_current'\)[\s\S]*?\t\tend if;\n/, '')
					.replace(/\t\tif operation='update' and schema_version[\s\S]*?\t\tend if;\n/, '')
			)
		})),
	...auditTriggers(schema.tables)
];

describe('committed workspace migrations', () => {
	it.live('upgrades the legacy audit body before schema backfills write history', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const db = PgliteDb.make(yield* TestDb.open());
				const directory = yield* root;
				const source = join(directory, 'migrations');
				const legacy = yield* generate(
					null,
					migrationSchema(initial),
					{ number: 1, name: 'initial' },
					legacyAudit
				);
				yield* fs.makeDirectory(source, { recursive: true });
				yield* fs.writeFileString(join(source, legacy.file.name), legacy.file.sql);
				yield* fs.writeFileString(join(source, 'snapshot.json'), legacy.snapshot);
				yield* db.transaction({
					statements: [
						{ text: MIGRATIONS_TABLE, params: [] },
						{ text: executable(legacy.file), params: [] },
						recordApplied(legacy.file)
					]
				});
				yield* db.write({ text: "insert into entry(id,name) values($1,'Before')", params: [ID] });
				yield* prepareMigrations(directory, extended, 'generate');
				const next = (yield* readMigrations(source)).files[1];
				if (next === undefined) return yield* Effect.die('schema migration missing');
				yield* fs.writeFileString(
					join(source, next.name),
					`${next.sql}\nupdate entry set name='Backfilled';\n`
				);
				yield* prepareMigrations(directory, extended, 'generate');
				yield* applyMigrations(db, extended, yield* readMigrations(source));
				expect(
					yield* db.rows(Schema.Struct({ version: Schema.String, full: Schema.Boolean }), {
						text: "select meta->>'schema' as version,(meta->>'full')::boolean as full from bolt_history where collection='entry' and revision=2",
						params: []
					})
				).toEqual([{ version: expect.any(String), full: true }]);
				expect(yield* fs.readFileString(join(source, legacy.file.name))).toBe(legacy.file.sql);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('verify refuses a proof older than the runtime functions; build then generates them', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* root;
				const source = join(directory, 'migrations');
				const legacy = yield* generate(
					null,
					migrationSchema(initial),
					{ number: 1, name: 'initial' },
					legacyAudit
				);
				// the proof an earlier Bolt committed: the legacy prefix replayed as it stands
				const db = PgliteDb.make(yield* TestDb.open()),
					inspect = { text: INTROSPECT, params: [] },
					empty = migrationLines(yield* db.rows(IntrospectRow, inspect), true, true);
				yield* db.write({ text: executable(legacy.file), params: [] });
				const lines = migrationLines(yield* db.rows(IntrospectRow, inspect), true, true),
					definitions = { '': empty, [legacy.file.name]: lines };
				yield* fs.makeDirectory(source, { recursive: true });
				yield* fs.writeFileString(join(source, legacy.file.name), legacy.file.sql);
				yield* fs.writeFileString(join(source, 'snapshot.json'), legacy.snapshot);
				yield* fs.writeFileString(join(source, 'physical.json'), physicalDefinitionsOf(definitions));
				yield* fs.writeFileString(
					join(source, 'migrations.lock.json'),
					lockOf(legacy.snapshot, [legacy.file], {
						physical: { '': physicalHash(empty), [legacy.file.name]: physicalHash(lines) }
					})
				);
				const names = Effect.map(readMigrations(source), ({ files }) => files.map((f) => f.name));
				const refused = yield* prepareMigrations(directory, initial, 'verify').pipe(Effect.flip);
				expect(refused.message).toContain('run bolt build');
				yield* prepareMigrations(directory, initial, 'generate');
				expect(yield* names).toEqual([legacy.file.name, '0002_runtime_functions.sql']);
				yield* prepareMigrations(directory, initial, 'verify');
			})
		).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'appends schema versions in sequential SQL without changing applied migration files',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const db = PgliteDb.make(yield* TestDb.open());
					const directory = yield* root;
					const source = join(directory, 'migrations');
					yield* prepareMigrations(directory, initial, 'generate');
					const original = (yield* readMigrations(source)).files[0];
					if (original === undefined) return yield* Effect.die('initial migration missing');
					yield* applyMigrations(db, initial, yield* readMigrations(source));
					yield* db.write({
						text: 'insert into entry(id,name) values($1,$2)',
						params: [ID, 'Before migration']
					});
					const next: EngineManifest = {
						...initial,
						models: {
							entry: {
								description: 'Entry',
								label: 'title',
								fields: { title: { kind: 'text', was: 'name', label: 'Renamed title' } }
							}
						},
						exposures: { entry: { outputs: { default: { entry: { fields: 'all' } } } } }
					};
					yield* prepareMigrations(directory, next, 'generate');
					expect(yield* fs.readFileString(join(source, original.name))).toBe(original.sql);
					const bundle = yield* readMigrations(source);
					expect(bundle.files.map((file) => file.name)).toEqual([
						'0001_initial.sql',
						'0002_schema.sql'
					]);
					yield* applyMigrations(db, next, bundle);
					const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
						yield* readHistory(
							db,
							next,
							{
								kind: 'history',
								model: 'entry',
								id: ID,
								at: { _tag: 'Revision', revision: 1 },
								view: true
							},
							{ as: 'workspace' },
							{ now: '2026-11-03T00:00:00.000Z', today: '2026-11-03', tz: 'UTC' }
						)
					);
					expect(snapshot.values.name).toBe('Before migration');
					expect(snapshot.compatible.title).toBe('Before migration');
					expect(snapshot.legacy).toBe(false);
					yield* prepareMigrations(directory, next, 'verify');
				})
			).pipe(Effect.provide(NodeServices.layer))
	);
	it.live('a live-data check rolls back a split and backfill; corrected data retries once', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const db = PgliteDb.make(yield* TestDb.open());
				const directory = yield* root;
				const source = join(directory, 'migrations');
				const old: EngineManifest = {
					...initial,
					models: {
						entry: {
							description: 'An entry',
							label: 'name',
							fields: { name: { kind: 'text' }, minor: { kind: 'int' } }
						}
					}
				};
				const next: EngineManifest = {
					...old,
					models: {
						entry: {
							description: 'An entry',
							label: 'name',
							fields: {
								name: { kind: 'text' },
								minor: { kind: 'int' },
								given: { kind: 'text', optional: true },
								family: { kind: 'text', optional: true },
								amount: { kind: 'decimal', scale: 2, optional: true }
							}
						}
					}
				};
				yield* prepareMigrations(directory, old, 'generate');
				yield* applyMigrations(db, old, yield* readMigrations(source));
				yield* db.write({
					text: 'insert into entry (id, name, minor) values ($1, $2, 12345), ($3, $4, 6789)',
					params: [ID, 'Ada Lovelace', '22222222-2222-2222-2222-222222222222', 'Prince']
				});
				yield* prepareMigrations(directory, next, 'generate');
				const file = (yield* readMigrations(source)).files[1];
				if (file === undefined) return yield* Effect.die('second migration missing');
				yield* fs.writeFileString(
					join(source, file.name),
					`${file.sql}
update entry set given = split_part(name, ' ', 1), family = split_part(name, ' ', 2), amount = minor::numeric / 100;
-- check: names_have_two_parts
select id from entry where given is null or given = '' or family is null or family = '';
`
				);
				// Empty replay passes; only the populated database reveals the ambiguous source row.
				yield* prepareMigrations(directory, next, 'generate');
				const bundle = yield* readMigrations(source);
				expect(yield* Effect.flip(applyMigrations(db, next, bundle))).toMatchObject({
					_tag: 'DbError',
					sqlstate: 'BM005'
				});
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
				expect(
					yield* db.rows(Rows, { text: 'select name from entry order by id', params: [] })
				).toEqual([{ name: 'Ada Lovelace' }, { name: 'Prince' }]);
				expect(
					yield* db.rows(Count, {
						text: "select count(*)::int as n from information_schema.columns where table_name='entry' and column_name in ('given','family','amount')",
						params: []
					})
				).toEqual([{ n: 0 }]);
				yield* db.write({
					text: "update entry set name='Grace Hopper' where name='Prince'",
					params: []
				});
				yield* applyMigrations(db, next, bundle);
				const converted = Schema.Struct({
					id: Schema.String,
					given: Schema.String,
					family: Schema.String,
					amount: Schema.String
				});
				const rows = yield* db.rows(converted, {
					text: 'select id, given, family, amount::text from entry order by id',
					params: []
				});
				expect(
					rows.map(({ amount, ...row }) => ({
						...row,
						amount: Decimal.of(amount).eq(row.id === ID ? '123.45' : '67.89')
					}))
				).toEqual([
					{ id: ID, given: 'Ada', family: 'Lovelace', amount: true },
					{
						id: '22222222-2222-2222-2222-222222222222',
						given: 'Grace',
						family: 'Hopper',
						amount: true
					}
				]);
				// Re-applying a receipt must not overwrite edits made after the backfill.
				yield* db.write({ text: "update entry set given='Edited' where id=$1", params: [ID] });
				yield* applyMigrations(db, next, bundle);
				expect(yield* receipts(db)).toEqual([{ n: 2 }]);
				expect(
					yield* db.rows(Schema.Struct({ given: Schema.String }), {
						text: 'select given from entry where id=$1',
						params: [ID]
					})
				).toEqual([{ given: 'Edited' }]);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);

	it.live('generate keeps an edited file; a history applies once; a refused file rolls back', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				// the kit's database first: the worker's PGlite warm-up is not this file's work
				const db = PgliteDb.make(yield* TestDb.open());
				const directory = yield* root;
				const source = join(directory, 'migrations');
				yield* prepareMigrations(directory, initial, 'generate');
				const bundle = yield* readMigrations(source);
				yield* applyMigrations(db, initial, bundle);
				// applied once: a second apply is a no-op
				yield* applyMigrations(db, initial, bundle);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
				expect(
					(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).map((row) => row.checksum)
				).toEqual(bundle.files.map(checksumOf));

				yield* prepareMigrations(directory, extended, 'generate');
				yield* db.write({
					text: 'insert into entry (id, name) values ($1, $2)',
					params: [ID, 'Kept']
				});
				const file = (yield* readMigrations(source)).files[1];
				if (file === undefined) return yield* Effect.die('second migration missing');
				// Scratch replay has no entries; this collision occurs only against the live database's existing row.
				const edited = `${file.sql}\nupdate entry set name = 'Changed';\ninsert into entry (id, name) select id, 'Duplicate' from entry;\n`;
				const lock = join(source, 'migrations.lock.json'),
					physical = join(source, 'physical.json'),
					stale = [yield* fs.readFileString(lock), yield* fs.readFileString(physical)] as const;
				yield* fs.writeFileString(join(source, file.name), edited);
				yield* prepareMigrations(directory, extended, 'generate');
				expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
				// a build whose proof went elsewhere leaves the same inputs here: the lock still gets its proof
				const proved = yield* fs.readFileString(lock);
				yield* fs.writeFileString(lock, stale[0]);
				yield* fs.writeFileString(physical, stale[1]);
				yield* prepareMigrations(directory, extended, 'generate');
				expect(yield* fs.readFileString(lock)).toBe(proved);
				expect(
					yield* Effect.flip(applyMigrations(db, extended, yield* readMigrations(source)))
				).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Kept' }
				]);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);

	// data is the edit's to change; the schema is the model's, so a hand edit may not leave the two apart
	const DRIFT = [
		`alter table entry add column extra text`,
		`alter table entry alter column note set not null`,
		`alter table entry alter column name set default 'x'`,
		`alter table entry alter column note type text collate "C"`,
		`alter table entry add constraint positive check (length(name) > 0)`,
		`create index extra on entry (name)`,
		`create table extra (id int)`,
		`create view extra as select 1 as one`,
		`create sequence extra`,
		`create function extra() returns int language sql as 'select 1'`,
		`create aggregate extra(int) (sfunc = int4pl, stype = int)`,
		`create type extra as enum ('a')`,
		`create domain extra as text`,
		`create schema extra`,
		`create rule extra as on insert to entry do instead nothing`,
		`create policy extra on entry using (true)`,
		`alter table entry disable trigger all`,
		`alter table entry set (fillfactor = 50)`
	];
	it.effect(
		'proves a data edit and refuses every edit that leaves the declared schema',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const directory = yield* root;
					const source = join(directory, 'migrations');
					yield* prepareMigrations(directory, initial, 'generate');
					yield* prepareMigrations(directory, extended, 'generate');
					const file = (yield* readMigrations(source)).files[1];
					if (file === undefined) return yield* Effect.die('second migration missing');
					const passed: string[] = [];
					for (const statement of DRIFT) {
						yield* fs.writeFileString(join(source, file.name), `${file.sql}\n${statement};\n`);
						const proof = yield* Effect.result(prepareMigrations(directory, extended, 'generate'));
						if (proof._tag === 'Success') passed.push(statement);
					}
					expect(passed).toEqual([]);
					yield* fs.writeFileString(
						join(source, file.name),
						`${file.sql}\nupdate entry set note = name where note is null;\n`
					);
					yield* prepareMigrations(directory, extended, 'generate');
				})
			).pipe(Effect.provide(NodeServices.layer)),
		60_000
	);
});
