import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import {
	INTROSPECT,
	IntrospectRow,
	MIGRATIONS_TABLE,
	build,
	checkFile,
	checksumOf,
	destructiveSteps,
	destroyNamespace,
	executable,
	generate,
	lockOf,
	migrationGuard,
	pending,
	plan,
	readLock,
	schema,
	shapeViolation,
	snapshotOf,
	table,
	unaccepted,
	verify,
	type FieldSpec,
	type MigrationFile,
	type StoreError
} from '../src/index.ts';
import { database, script } from './support.ts';

const before = schema({
	company: table({ fields: { title: { kind: 'text', default: '"company"' } } }),
	person: table({ fields: { name: { kind: 'text' } } }),
	note: table({ fields: { owner: { kind: 'ref', to: ['company', 'person'], optional: true } } })
});
const renamed = schema({
	organization: table({
		was: 'company',
		fields: { name: { kind: 'text', was: 'title', default: '"organization"' } }
	}),
	person: before.tables.person,
	note: table({
		fields: { about: { kind: 'ref', to: ['organization', 'person'], was: 'owner', optional: true } }
	})
});
const failure = <A>(effect: Effect.Effect<A, StoreError>) =>
	Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'ok'));
const introspect = (pg: Effect.Success<typeof database>) =>
	Effect.promise(() => pg.query<{ line: string }>(INTROSPECT)).pipe(
		Effect.flatMap((result) =>
			Schema.decodeUnknownEffect(Schema.Array(IntrospectRow))(result.rows)
		),
		Effect.map((rows) => rows.map((row) => row.line))
	);

describe('editable migration files', () => {
	it.live('factory reset clears the whole owned namespace and leaves other namespaces usable', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* database;
				yield* script(
					pg,
					`create schema owned; create schema retained;
				create table owned.stale (id int); insert into owned.stale values (1);
				create function owned.stale_fn() returns int language sql as 'select 1';
				create table retained.entry (id int); insert into retained.entry values (2);`
				);
				for (const sql of destroyNamespace('owned')) yield* script(pg, sql.text);
				expect(yield* Effect.promise(() => pg.query('select * from retained.entry'))).toMatchObject(
					{ rows: [{ id: 2 }] }
				);
				expect(
					yield* Effect.promise(() =>
						pg.query(
							`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='owned'`
						)
					)
				).toMatchObject({ rows: [{ n: 0 }] });
				yield* script(pg, 'create table owned.stale (id int); insert into owned.stale values (3);');
				expect(yield* Effect.promise(() => pg.query('select * from owned.stale'))).toMatchObject({
					rows: [{ id: 3 }]
				});
			})
		)
	);
	it.live(
		'migration guards compare the exact ledger and both directions of native definitions',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const pg = yield* database;
					yield* script(pg, `${MIGRATIONS_TABLE}; create table guard_probe (id text primary key);`);
					const definitions = yield* introspect(pg);
					const runGuard = (stage: 'before' | 'after', lines = definitions) =>
						Effect.tryPromise({
							try: () => pg.exec(migrationGuard([], lines, stage).text),
							catch: (cause) => cause
						});
					yield* runGuard('before');
					yield* script(
						pg,
						"insert into store_migration(name,checksum) values ('0001_initial.sql','changed');"
					);
					expect(yield* Effect.flip(runGuard('before'))).toMatchObject({ code: 'BM001' });
					expect(yield* Effect.flip(runGuard('after'))).toMatchObject({ code: 'BM004' });
					yield* script(
						pg,
						'delete from store_migration; alter table guard_probe add column extra text;'
					);
					expect(yield* Effect.flip(runGuard('before'))).toMatchObject({ code: 'BM002' });
					expect(yield* Effect.flip(runGuard('after'))).toMatchObject({ code: 'BM003' });
					const expanded = yield* introspect(pg);
					yield* script(pg, 'alter table guard_probe drop column extra;');
					expect(yield* Effect.flip(runGuard('before', expanded))).toMatchObject({ code: 'BM002' });
					yield* runGuard('after');
				})
			)
	);

	it.live(
		'counts duplicate rows without collisions with block variables or SQL literal delimiters',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const old = schema({
						entry: table({
							fields: {
								n: { kind: 'int' },
								store_violations: { kind: 'int' },
								store_violations_1: { kind: 'int' },
								STORE_VIOLATIONS: { kind: 'text' }
							}
						})
					});
					const next = schema({
						entry: table({
							...old.tables.entry,
							unique: [
								{ fields: ['n', 'store_violations', 'store_violations_1', 'STORE_VIOLATIONS'] }
							],
							check: {
								text: {
									where: { STORE_VIOLATIONS: { eq: "O'Reilly $store$" } },
									message: 'text matches'
								}
							}
						})
					});
					const pg = yield* database;
					yield* script(pg, (yield* generate(null, old, { number: 1, name: 'initial' })).file.sql);
					yield* script(
						pg,
						`insert into entry (id, n, store_violations, store_violations_1, "STORE_VIOLATIONS") values
				('11111111-1111-1111-1111-111111111111', 1, 2, 3, 'O''Reilly $store$'),
				('22222222-2222-2222-2222-222222222222', 1, 2, 3, 'O''Reilly $store$')`
					);
					const migration = yield* generate(old, next, { number: 2, name: 'unique' });
					const refused = yield* Effect.promise(() =>
						pg.exec(migration.file.sql).then(
							() => 'ok',
							(error: unknown) => (error instanceof Error ? error.message : String(error))
						)
					);
					expect(refused).toContain('refuses 1 existing row(s)');
					yield* script(pg, "delete from entry where id = '22222222-2222-2222-2222-222222222222'");
					yield* script(pg, migration.file.sql);
					expect(
						(yield* Effect.promise(() => pg.query<{ n: number }>('select n from entry'))).rows
					).toEqual([{ n: 1 }]);
				})
			)
	);

	it.live('replays table, field and polymorphic target renames without losing rows', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* database;
				const fresh = yield* database;
				const initial = yield* generate(null, before, { number: 1, name: 'initial' });
				const rename = yield* generate(before, renamed, { number: 2, name: 'rename owners' });
				expect(unaccepted(rename.plan)).toEqual([]);
				expect(yield* destructiveSteps(before, renamed)).toEqual([]);
				expect(rename.file.sql).toContain(
					'rename column "owner__company" to "about__organization"'
				);
				yield* script(pg, initial.file.sql);
				yield* script(
					pg,
					`insert into company (id, title) values ('11111111-1111-1111-1111-111111111111', 'Acme');
				insert into note (id, owner__company) values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111')`
				);
				yield* script(pg, rename.file.sql);
				const result = yield* Effect.promise(() =>
					pg.query<{ name: string; about__organization: string }>(
						'select o.name, n.about__organization from organization o join note n on n.about__organization = o.id'
					)
				);
				expect(result.rows).toEqual([
					{ name: 'Acme', about__organization: '11111111-1111-1111-1111-111111111111' }
				]);
				const defaulted = yield* Effect.promise(() =>
					pg.query<{ name: string }>(
						`insert into organization (id) values ('33333333-3333-3333-3333-333333333333') returning name`
					)
				);
				expect(defaulted.rows[0]?.name).toBe('"organization"');
				yield* script(fresh, `${(yield* build(renamed)).join(';\n')};`);
				const lock = yield* verify(
					[rename.file, initial.file],
					rename.snapshot,
					renamed,
					yield* introspect(pg),
					yield* introspect(fresh)
				);
				expect(Object.keys((yield* readLock(lock)).files)).toEqual([
					initial.file.name,
					rename.file.name
				]);
				expect((yield* plan(renamed, renamed)).steps).toEqual([]);
			})
		)
	);

	it.live(
		'leaves an editable data step and refuses incompatible existing inline rows with their count',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const old = schema({
						entry: table({
							fields: { address: { kind: 'object', fields: { city: { kind: 'text' } } } }
						})
					});
					const next = schema({
						entry: table({
							fields: {
								address: {
									kind: 'object',
									fields: { city: { kind: 'text' }, zip: { kind: 'text' } }
								}
							}
						})
					});
					const pg = yield* database;
					const initial = yield* generate(null, old, { number: 1, name: 'initial' });
					const migration = yield* generate(old, next, { number: 2, name: 'zip' });
					yield* script(pg, initial.file.sql);
					yield* script(
						pg,
						`insert into entry (id, address) values ('11111111-1111-1111-1111-111111111111', '{"city":"George Town"}')`
					);
					const refused = yield* Effect.promise(() =>
						pg.exec(migration.file.sql).then(
							() => 'ok',
							(error: unknown) => (error instanceof Error ? error.message : String(error))
						)
					);
					expect(refused).toContain('the shape of entry.address refuses 1 existing row(s)');
					const edited = migration.file.sql.replace(
						'-- step check:entry.address',
						`update entry set address = jsonb_set(address, '{zip}', '"10000"'::jsonb);\n-- step check:entry.address`
					);
					yield* script(pg, edited);
					const result = yield* Effect.promise(() =>
						pg.query<{ zip: string }>("select address ->> 'zip' as zip from entry")
					);
					expect(result.rows).toEqual([{ zip: '10000' }]);
				})
			)
	);

	it.live(
		'rebuilds a changed table and its unchanged columns and incoming foreign keys in dependency order',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const old = schema({
						parent: table({ fields: { name: { kind: 'text' } } }),
						child: table({ fields: { parent: { kind: 'ref', to: 'parent', optional: true } } })
					});
					const next = schema({
						parent: table({ ...old.tables.parent, audit: true }),
						child: old.tables.child
					});
					const pg = yield* database;
					const fresh = yield* database;
					const initial = yield* generate(null, old, { number: 1, name: 'initial' });
					const change = yield* plan(old, next);
					const migration = yield* generate(old, next, {
						number: 2,
						name: 'audit',
						accept: unaccepted(change).map((step) => step.id)
					});
					yield* script(pg, initial.file.sql);
					yield* script(pg, migration.file.sql);
					yield* script(fresh, `${(yield* build(next)).join(';\n')};`);
					expect(yield* introspect(pg)).toEqual(yield* introspect(fresh));
				})
			)
	);

	it.live(
		'a check block fails the file when its query returns rows, and passes when none remain',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const pg = yield* database;
					const file: MigrationFile = {
						name: '0001_nationality.sql',
						sql: [
							'create table person (id int primary key, nationality text, n int);',
							"insert into person values (1, 'SG', 1), (2, 'singapore', 2);",
							'-- check: nationality_is_iso2',
							"select id, n from person where nationality !~ '^[A-Z]{2}$' -- ';' in a comment",
							';',
							'create index person_n on person (n);'
						].join('\n')
					};
					expect(yield* checkFile(file)).toEqual(file);
					const failed = yield* Effect.exit(
						Effect.tryPromise(() => pg.transaction((tx) => tx.exec(executable(file))))
					);
					expect(String(failed)).toContain('check nationality_is_iso2 failed: 1 row(s) returned');
					expect(
						(yield* Effect.promise(() => pg.query("select to_regclass('person') as t"))).rows
					).toEqual([{ t: null }]);
					const fixed = { ...file, sql: file.sql.replace("'singapore'", "'MY'") };
					yield* script(pg, executable(fixed));
					expect(
						(yield* Effect.promise(() => pg.query("select to_regclass('person_n') as t"))).rows
					).toEqual([{ t: 'person_n' }]);
					expect(
						yield* failure(checkFile({ ...file, sql: '-- check: writes\ndelete from person;' }))
					).toContain('check writes needs one SELECT');
				})
			)
	);

	it.effect('refuses destructive files until each destructive block has its accept line', () =>
		Effect.gen(function* () {
			const next = schema({ person: before.tables.person });
			const generated = yield* generate(before, next, { number: 1, name: 'remove' });
			expect(yield* failure(checkFile(generated.file))).toContain(
				'destructive steps need an accept line'
			);
			const accepted = yield* generate(before, next, {
				number: 1,
				name: 'remove',
				accept: unaccepted(generated.plan).map((step) => step.id)
			});
			expect(yield* checkFile(accepted.file)).toEqual(accepted.file);
		})
	);

	it.effect('rejects ambiguous and missing rename sources', () =>
		Effect.gen(function* () {
			const missing = schema({ organization: table({ was: 'missing', fields: {} }) });
			expect(yield* failure(plan(before, missing))).toContain('which the database does not hold');
			const duplicate = schema({
				first: table({ was: 'company', fields: {} }),
				second: table({ was: 'company', fields: {} })
			});
			expect(yield* failure(plan(before, duplicate))).toContain('another table still uses');
			const field = schema({
				person: table({
					fields: { name: { kind: 'text' }, display: { kind: 'text', was: 'name' } }
				})
			});
			expect(yield* failure(plan(before, field))).toContain('another field still uses');
		})
	);

	it.effect(
		'keeps destructive acceptance enforceable for quoted identifiers containing whitespace',
		() =>
			Effect.gen(function* () {
				const old = schema({ 'old table': table({ fields: { 'old field': { kind: 'text' } } }) });
				const generated = yield* generate(old, schema({}), { number: 1, name: 'remove' });
				expect(yield* failure(checkFile(generated.file))).toContain(
					'destructive steps need an accept line'
				);
				const accepted = yield* generate(old, schema({}), {
					number: 1,
					name: 'remove',
					accept: unaccepted(generated.plan).map((step) => step.id)
				});
				expect(yield* checkFile(accepted.file)).toEqual(accepted.file);
			})
	);

	it.effect('checks a contiguous history, verified file checksums and the locked snapshot', () =>
		Effect.gen(function* () {
			const first: MigrationFile = { name: '0001_initial.sql', sql: 'select 1;' };
			const second: MigrationFile = { name: '0002_more.sql', sql: 'select 2;' };
			const files = [second, first];
			const snapshot = snapshotOf(before);
			const lock = yield* readLock(lockOf(snapshot, files));
			expect(
				yield* pending(files, lock, [{ name: first.name, checksum: checksumOf(first) }], snapshot)
			).toEqual([second]);
			expect(
				yield* failure(pending(files, lock, [{ name: second.name, checksum: checksumOf(second) }]))
			).toContain('not a prefix');
			expect(
				yield* failure(
					pending(files, lock, [
						{ name: first.name, checksum: checksumOf(first) },
						{ name: first.name, checksum: checksumOf(first) }
					])
				)
			).toContain('not a prefix');
			expect(yield* failure(pending([{ ...first, sql: 'select 3;' }, second], lock, []))).toContain(
				'changed since it was last verified'
			);
			expect(
				yield* failure(pending(files, lock, [{ name: first.name, checksum: 'old' }]))
			).toContain('applied with other text');
			expect(yield* failure(pending(files, lock, [], `${snapshot}\n`))).toContain(
				'snapshot.json changed'
			);
			expect(yield* failure(pending([second], lock, []))).toContain('without gaps');
		})
	);

	it.effect('verify checks numbering, snapshot and replay differences before issuing a lock', () =>
		Effect.gen(function* () {
			const snapshot = snapshotOf(before);
			const file: MigrationFile = { name: '0002_gap.sql', sql: 'select 1;' };
			expect(yield* failure(verify([file], snapshot, before, [], []))).toContain('without gaps');
			expect(yield* failure(verify([], snapshot, renamed, [], []))).toContain('schema changed');
			expect(yield* failure(verify([], snapshot, before, ['extra'], ['missing']))).toContain(
				'missing missing'
			);
			expect(yield* failure(generate(null, before, { number: 0, name: 'bad' }))).toContain(
				'from 1 to 9999'
			);
			expect(yield* failure(generate(null, before, { number: 1, name: '!!' }))).toContain(
				'needs a name'
			);
		})
	);

	it.live('counts wrong inline JSON shapes without casting or expanding the wrong type', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* database;
				const shapes: readonly { shape: FieldSpec; valid: unknown; invalid: unknown }[] = [
					{
						shape: { kind: 'list', of: { kind: 'int' } },
						valid: [1, 2],
						invalid: { not: 'a list' }
					},
					{ shape: { kind: 'record', of: { kind: 'int' } }, valid: { yes: 1 }, invalid: [1] },
					{ shape: { kind: 'int' }, valid: 1, invalid: 'not a number' },
					{ shape: { kind: 'enum', values: ['yes'], many: true }, valid: ['yes'], invalid: ['no'] },
					{
						shape: { kind: 'decimal', scale: 2 },
						valid: { $dec: '1.20' },
						invalid: { $dec: 'bad' }
					},
					{
						shape: { kind: 'object', fields: { required: { kind: 'text' } } },
						valid: { required: 'yes' },
						invalid: {}
					},
					{ shape: { kind: 'date' }, valid: '2024-02-29', invalid: '2023-02-29' },
					{
						shape: { kind: 'union', by: 'kind', arms: { yes: { n: { kind: 'int' } } } },
						valid: { kind: 'yes', n: 1 },
						invalid: { kind: 'no', n: 1 }
					}
				];
				for (const { shape, valid, invalid } of shapes) {
					const sql = `select ${shapeViolation('$1::jsonb', shape)} as invalid`;
					const good = yield* Effect.promise(() =>
						pg.query<{ invalid: boolean }>(sql, [JSON.stringify(valid)])
					);
					const bad = yield* Effect.promise(() =>
						pg.query<{ invalid: boolean }>(sql, [JSON.stringify(invalid)])
					);
					expect(good.rows[0]?.invalid).toBe(false);
					expect(bad.rows[0]?.invalid).toBe(true);
				}
			})
		)
	);

	it.live('stores finite numbers and int64 columns and enforces a typed expression index', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const declared = schema({
					metric: table({
						fields: {
							name: { kind: 'text' },
							ratio: { kind: 'number' },
							bytes: { kind: 'int', storage: 'int64' }
						},
						indexes: [{ on: [{ expr: { lower: { field: 'name' } } }], unique: true }]
					})
				});
				const pg = yield* database;
				yield* script(pg, `${(yield* build(declared)).join(';\n')};`);
				yield* script(
					pg,
					`insert into metric (id, name, ratio, bytes) values ('11111111-1111-1111-1111-111111111111', 'Acme', 0.125, 3000000000)`
				);
				const result = yield* Effect.promise(() =>
					pg.query<{ ratio: number; bytes: string; ratio_type: string; bytes_type: string }>(
						'select ratio, bytes::text, pg_typeof(ratio)::text as ratio_type, pg_typeof(bytes)::text as bytes_type from metric'
					)
				);
				expect(result.rows).toEqual([
					{
						ratio: 0.125,
						bytes: '3000000000',
						ratio_type: 'double precision',
						bytes_type: 'bigint'
					}
				]);
				const refused = yield* Effect.promise(() =>
					pg
						.exec(
							`insert into metric (id, name, ratio, bytes) values ('22222222-2222-2222-2222-222222222222', 'ACME', 1, 1)`
						)
						.then(
							() => 'ok',
							(error: unknown) => (error instanceof Error ? error.message : String(error))
						)
				);
				expect(refused).toContain('duplicate key value');
			})
		)
	);
});
