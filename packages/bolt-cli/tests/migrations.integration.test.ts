import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect, it } from '@effect/vitest';
import { Effect, FileSystem, Schema } from 'effect';
import {
	APPLIED,
	AppliedRow,
	checksum_of,
	generate,
	executable,
	INTROSPECT,
	IntrospectRow,
	lock_of,
	MIGRATIONS_TABLE,
	physical_definitions_of,
	physical_hash,
	record_applied
} from '@norbital-ai/store';
import { Decimal } from '@norbital-ai/store/decimal';
import { scratchPath } from '../../../scripts/lib/scratch.ts';
import { prepare_migrations } from '../src/compiler/migrations.ts';
import {
	apply_migrations,
	migration_lines,
	read_migrations,
	migration_schema
} from '../../bolt/src/engine/schema/migrations.ts';
import { source_objects } from '../../bolt/src/engine/schema/engine.ts';
import { audit_triggers } from '../../bolt/src/engine/schema/audit.ts';
import { history_schema_objects } from '../../bolt/src/engine/schema/history.ts';
import { PgliteDb } from '../../bolt/src/node/db/pglite.ts';
import { TestDb } from '../src/test/database.ts';
import type { TenantDbShape } from '../../bolt/src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { manifest } from '../../bolt/tests/engine-fixture.ts';
import { read_history } from '../../bolt/src/engine/query/history.ts';
import { HistorySnapshotSchema } from '../../bolt/src/protocol/record-contracts.ts';

const initial: EngineManifest = {
	...manifest,
	models: {
		entry: {
			description: 'An entry',
			record_label: 'record.name',
			fields: { name: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: { entry: { outputs: { default: { entry: { fields: 'all' } } } } },
	policies: {}
};
const extended: EngineManifest = {
	...initial,
	models: {
		entry: {
			description: 'An entry',
			record_label: 'record.name',
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
/** Synthetic versioned predecessor lacking only the full-image-on-version-change branch. */
const prior_versioned_audit: Parameters<typeof generate>[3] = (schema) =>
	Effect.map(history_schema_objects(schema.tables, schema.currency), (history) => [
		...source_objects()
			.map((object) => object.id !== 'engine:bolt_audit' ? object : {
				...object,
				create: object.create.map((sql) => sql.replace(
					/\t\tif operation='update' and not exists\([\s\S]*?\t\tend if;\n/, ''
				))
			}),
		...history,
		...audit_triggers(schema.tables)
	]);

describe('committed workspace migrations', () => {
	it.live('test checkpoints retain committed backfills through transitions and resets', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* root;
				const source = join(directory, 'migrations');
				yield* prepare_migrations(directory, initial, 'generate');
				const baseline = yield* read_migrations(source);
				const file = baseline.files[0];
				if (file === undefined) return yield* Effect.die('initial migration missing');
				yield* fs.writeFileString(
					join(source, file.name),
					`${file.sql}\ninsert into entry(id,name) values('${ID}','Committed backfill');\n`
				);
				yield* prepare_migrations(directory, initial, 'generate');
				const bundle = yield* read_migrations(source);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const db = PgliteDb.make(yield* TestDb.open(initial, bundle));
						expect(
							yield* db.value(Schema.String, {
								text: 'select name from entry where id=$1',
								params: [ID]
							})
						).toBe('Committed backfill');
						yield* TestDb.migrate(db, extended);
						expect(
							yield* db.rows(
								Schema.Struct({ name: Schema.String, note: Schema.NullOr(Schema.String) }),
								{
									text: 'select name,note from entry where id=$1',
									params: [ID]
								}
							)
						).toEqual([{ name: 'Committed backfill', note: null }]);
						const ledger = yield* db.rows(AppliedRow, { text: APPLIED, params: [] });
						expect(ledger).toHaveLength(2);
						expect(ledger[0]).toEqual({
							name: file.name,
							checksum: checksum_of(bundle.files[0] ?? file)
						});
						yield* db.write({
							text: "update entry set name='Changed in the test' where id=$1",
							params: [ID]
						});
					})
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const db = PgliteDb.make(yield* TestDb.open(initial, bundle));
						expect(
							yield* db.value(Schema.String, {
								text: 'select name from entry where id=$1',
								params: [ID]
							})
						).toBe('Committed backfill');
						expect(yield* receipts(db)).toEqual([{ n: 1 }]);
					})
				);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);

	it.live('upgrades an earlier versioned audit body before schema backfills write history', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const db = PgliteDb.make(yield* TestDb.open());
				const directory = yield* root;
				const source = join(directory, 'migrations');
				const previous = yield* generate(
					null,
					migration_schema(initial),
					{ number: 1, name: 'initial' },
					prior_versioned_audit
				);
				yield* fs.makeDirectory(source, { recursive: true });
				yield* fs.writeFileString(join(source, previous.file.name), previous.file.sql);
				yield* fs.writeFileString(join(source, 'snapshot.json'), previous.snapshot);
				yield* db.transaction({
					statements: [
						{ text: MIGRATIONS_TABLE, params: [] },
						{ text: executable(previous.file), params: [] },
						record_applied(previous.file)
					]
				});
				yield* db.write({ text: "insert into entry(id,name) values($1,'Before')", params: [ID] });
				yield* prepare_migrations(directory, extended, 'generate');
				const next = (yield* read_migrations(source)).files[1];
				if (next === undefined) return yield* Effect.die('schema migration missing');
				yield* fs.writeFileString(
					join(source, next.name),
					`${next.sql}\nupdate entry set name='Backfilled';\n`
				);
				yield* prepare_migrations(directory, extended, 'generate');
				yield* apply_migrations(db, extended, yield* read_migrations(source));
				expect(
					yield* db.rows(Schema.Struct({ version: Schema.String, full: Schema.Boolean }), {
						text: "select meta->>'schema' as version,(meta->>'full')::boolean as full from bolt_history where collection='entry' and revision=2",
						params: []
					})
				).toEqual([{ version: expect.any(String), full: true }]);
				expect(yield* fs.readFileString(join(source, previous.file.name))).toBe(previous.file.sql);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'verify refuses a proof older than the runtime functions; build then generates them',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem;
					const directory = yield* root;
					const source = join(directory, 'migrations');
					const current: EngineManifest = {
						...initial,
						models: {
							entry: {
								description: 'An entry',
								record_label: 'record.name',
								fields: { name: { kind: 'text' } },
								unique: [{ fields: ['name'], where: { name: { eq: 'selected' } } }]
							}
						}
					};
					const previous = yield* generate(
						null,
						migration_schema(current),
						{ number: 1, name: 'initial' },
						prior_versioned_audit
					);
					// The synthetic versioned predecessor is retained byte-for-byte with its original physical proof.
					const db = PgliteDb.make(yield* TestDb.open()),
						inspect = { text: INTROSPECT, params: [] },
						empty = migration_lines(yield* db.rows(IntrospectRow, inspect), true, true);
					yield* db.write({ text: executable(previous.file), params: [] });
					const lines = migration_lines(yield* db.rows(IntrospectRow, inspect), true, true),
						definitions = { '': empty, [previous.file.name]: lines };
					yield* fs.makeDirectory(source, { recursive: true });
					yield* fs.writeFileString(join(source, previous.file.name), previous.file.sql);
					yield* fs.writeFileString(join(source, 'snapshot.json'), previous.snapshot);
					yield* fs.writeFileString(
						join(source, 'physical.json'),
						physical_definitions_of(definitions)
					);
					yield* fs.writeFileString(
						join(source, 'migrations.lock.json'),
						lock_of(previous.snapshot, [previous.file], {
							physical: { '': physical_hash(empty), [previous.file.name]: physical_hash(lines) }
						})
					);
					const names = Effect.map(read_migrations(source), ({ files }) => files.map((f) => f.name));
					const refused = yield* prepare_migrations(directory, current, 'verify').pipe(Effect.flip);
					expect(refused.message).toContain('run bolt build');
					yield* prepare_migrations(directory, current, 'generate');
					expect(yield* names).toEqual([previous.file.name, '0002_runtime_functions.sql']);
					const runtime = (yield* read_migrations(source)).files[1];
					if (runtime === undefined) return yield* Effect.die('runtime migration missing');
					yield* db.write({ text: executable(runtime), params: [] });
					expect(
						yield* db.value(Schema.JsonObject, {
							text: "select s.definition from bolt_history_current c join bolt_history_schema s on s.id=c.schema where c.model='entry'",
							params: []
						})
					).toMatchObject({
						fields: { name: { kind: 'text' } },
						unique: [{ fields: ['name'], where: { name: { eq: 'selected' } } }]
					});
					expect(yield* fs.readFileString(join(source, previous.file.name))).toBe(previous.file.sql);
					expect(yield* fs.readFileString(join(source, 'snapshot.json'))).toBe(previous.snapshot);
					yield* prepare_migrations(directory, current, 'verify');
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
					yield* prepare_migrations(directory, initial, 'generate');
					const original = (yield* read_migrations(source)).files[0];
					if (original === undefined) return yield* Effect.die('initial migration missing');
					yield* apply_migrations(db, initial, yield* read_migrations(source));
					yield* db.write({
						text: 'insert into entry(id,name) values($1,$2)',
						params: [ID, 'Before migration']
					});
					const next: EngineManifest = {
						...initial,
						models: {
							entry: {
								description: 'Entry',
								record_label: 'record.title',
								fields: { title: { kind: 'text', was: 'name' } }
							}
						},
						exposures: { entry: { outputs: { default: { entry: { fields: 'all' } } } } }
					};
					yield* prepare_migrations(directory, next, 'generate');
					expect(yield* fs.readFileString(join(source, original.name))).toBe(original.sql);
					const bundle = yield* read_migrations(source);
					expect(bundle.files.map((file) => file.name)).toEqual([
						'0001_initial.sql',
						'0002_schema.sql'
					]);
					yield* apply_migrations(db, next, bundle);
					const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(
						yield* read_history(
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
					expect(snapshot.schema_version).toBe(yield* db.value(Schema.String, {
						text: "select meta->>'schema' from bolt_history where collection='entry' and record=$1 and revision=1",
						params: [ID]
					}));
					yield* prepare_migrations(directory, next, 'verify');
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
							record_label: 'record.name',
							fields: { name: { kind: 'text' }, minor: { kind: 'int' } }
						}
					}
				};
				const next: EngineManifest = {
					...old,
					models: {
						entry: {
							description: 'An entry',
							record_label: 'record.name',
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
				yield* prepare_migrations(directory, old, 'generate');
				yield* apply_migrations(db, old, yield* read_migrations(source));
				yield* db.write({
					text: 'insert into entry (id, name, minor) values ($1, $2, 12345), ($3, $4, 6789)',
					params: [ID, 'Ada Lovelace', '22222222-2222-2222-2222-222222222222', 'Prince']
				});
				yield* prepare_migrations(directory, next, 'generate');
				const file = (yield* read_migrations(source)).files[1];
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
				yield* prepare_migrations(directory, next, 'generate');
				const bundle = yield* read_migrations(source);
				expect(yield* Effect.flip(apply_migrations(db, next, bundle))).toMatchObject({
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
				yield* apply_migrations(db, next, bundle);
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
				yield* apply_migrations(db, next, bundle);
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
				yield* prepare_migrations(directory, initial, 'generate');
				const bundle = yield* read_migrations(source);
				yield* apply_migrations(db, initial, bundle);
				// applied once: a second apply is a no-op
				yield* apply_migrations(db, initial, bundle);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
				expect(
					(yield* db.rows(AppliedRow, { text: APPLIED, params: [] })).map((row) => row.checksum)
				).toEqual(bundle.files.map(checksum_of));

				yield* prepare_migrations(directory, extended, 'generate');
				yield* db.write({
					text: 'insert into entry (id, name) values ($1, $2)',
					params: [ID, 'Kept']
				});
				const file = (yield* read_migrations(source)).files[1];
				if (file === undefined) return yield* Effect.die('second migration missing');
				// Scratch replay has no entries; this collision occurs only against the live database's existing row.
				const edited = `${file.sql}\nupdate entry set name = 'Changed';\ninsert into entry (id, name) select id, 'Duplicate' from entry;\n`;
				const lock = join(source, 'migrations.lock.json'),
					physical = join(source, 'physical.json'),
					stale = [yield* fs.readFileString(lock), yield* fs.readFileString(physical)] as const;
				yield* fs.writeFileString(join(source, file.name), edited);
				yield* prepare_migrations(directory, extended, 'generate');
				expect(yield* fs.readFileString(join(source, file.name))).toBe(edited);
				// a build whose proof went elsewhere leaves the same inputs here: the lock still gets its proof
				const proved = yield* fs.readFileString(lock);
				yield* fs.writeFileString(lock, stale[0]);
				yield* fs.writeFileString(physical, stale[1]);
				yield* prepare_migrations(directory, extended, 'generate');
				expect(yield* fs.readFileString(lock)).toBe(proved);
				expect(
					yield* Effect.flip(apply_migrations(db, extended, yield* read_migrations(source)))
				).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				expect(yield* db.rows(Rows, { text: 'select name from entry', params: [] })).toEqual([
					{ name: 'Kept' }
				]);
				expect(yield* receipts(db)).toEqual([{ n: 1 }]);
			})
		).pipe(Effect.provide(NodeServices.layer))
	);

	it.live('an unaccepted destructive step writes nothing; accepting it then generates', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const directory = yield* root;
				const source = join(directory, 'migrations');
				yield* prepare_migrations(directory, initial, 'generate');
				yield* prepare_migrations(directory, extended, 'generate');
				const before = yield* Effect.forEach(yield* fs.readDirectory(source), (name) =>
					Effect.map(fs.readFileString(join(source, name)), (text) => [name, text] as const)
				);
				// dropping `note` is destructive
				expect(
					(yield* Effect.flip(prepare_migrations(directory, initial, 'generate'))).message
				).toContain('accept');
				const after = yield* Effect.forEach(yield* fs.readDirectory(source), (name) =>
					Effect.map(fs.readFileString(join(source, name)), (text) => [name, text] as const)
				);
				expect(after.sort()).toEqual(before.sort());
				yield* prepare_migrations(directory, initial, 'generate', { accept: true });
				expect((yield* read_migrations(source)).files).toHaveLength(3);
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
					yield* prepare_migrations(directory, initial, 'generate');
					yield* prepare_migrations(directory, extended, 'generate');
					const file = (yield* read_migrations(source)).files[1];
					if (file === undefined) return yield* Effect.die('second migration missing');
					const passed: string[] = [];
					for (const statement of DRIFT) {
						yield* fs.writeFileString(join(source, file.name), `${file.sql}\n${statement};\n`);
						const proof = yield* Effect.result(prepare_migrations(directory, extended, 'generate'));
						if (proof._tag === 'Success') passed.push(statement);
					}
					expect(passed).toEqual([]);
					yield* fs.writeFileString(
						join(source, file.name),
						`${file.sql}\nupdate entry set note = name where note is null;\n`
					);
					yield* prepare_migrations(directory, extended, 'generate');
				})
			).pipe(Effect.provide(NodeServices.layer)),
		60_000
	);
});
