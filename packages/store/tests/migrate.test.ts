import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { INTROSPECT, IntrospectRow, MIGRATIONS_TABLE, MIGRATION_ROLE, MIGRATION_ROLE_ENTER, MIGRATION_ROLE_EXIT, MIGRATION_ROLE_PREPARE, build, check_file, checksum_of, destructive_steps, destroy_namespace, executable, generate, is_extension_statement, lock_of, migration_guard, pending, plan, read_lock, read_snapshot, schema, schema_snapshot, snapshot_of, table, verify, type FieldSpec, type MigrationFile, type StoreError } from '../src/index.ts';
import { database, script } from './support.ts';
import { unaccepted } from '../src/schema/plan.ts';

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
	it.live('new tables inline columns and constraints while existing rows still validate', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const first = schema({
					entry: table({
						key: 'text',
						unique: [{ fields: ['name'] }],
						fields: {
							name: { kind: 'text', default: 'initial' },
							parent: { kind: 'ref', to: 'entry', optional: true },
							score: { kind: 'int', default: 2 }
						},
						computed: { twice: { kind: 'int', expr: { times: [{ field: 'score' }, 2] } } },
						search: { text: ['name'] }
					})
				});
				const initial = yield* generate(null, first, { number: 1, name: 'initial' });
				expect(initial.file.sql).not.toContain('add column');
				expect(initial.file.sql).not.toContain('set not null');
				expect(initial.file.sql).not.toContain('set default');
				expect(initial.file.sql).not.toContain('declare n bigint');
				expect(initial.file.sql).toContain('add constraint'); // Foreign keys follow all tables.
				const pg = yield* database;
				const fresh = yield* database;
				yield* script(pg, initial.file.sql);
				yield* script(fresh, `${(yield* build(first)).join(';\n')};`);
				expect(yield* introspect(pg)).toEqual(yield* introspect(fresh));
				yield* script(pg, "insert into entry (id) values ('kept')");
				expect(
					(yield* Effect.promise(() => pg.query('select name, score, twice from entry'))).rows
				).toEqual([{ name: 'initial', score: 2, twice: 4 }]);
				const next = schema({
					entry: table({
						...first.tables.entry,
						fields: {
							...first.tables.entry.fields,
							extra: { kind: 'text', default: 'new' },
							required: { kind: 'text' }
						}
					}),
					another: table({ fields: { title: { kind: 'text' } } })
				});
				const update = yield* generate(yield* read_snapshot(initial.snapshot), next, {
					number: 2,
					name: 'extend'
				});
				expect(update.file.sql).toContain('add column "extra"');
				expect(update.file.sql).not.toContain('alter column "extra" set default');
				expect(update.file.sql).not.toContain('alter table "another" add column');
				expect(update.file.sql).toContain('declare n bigint');
				const refused = yield* Effect.promise(() =>
					pg.exec(update.file.sql).then(
						() => 'ok',
						(error: unknown) => (error instanceof Error ? error.message : String(error))
					)
				);
				expect(refused).toContain('refuses 1 existing row(s)');
			})
		)
	);

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
				for (const sql of destroy_namespace('owned')) yield* script(pg, sql.text);
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
							try: () => pg.exec(migration_guard([], lines, stage).text),
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
					const initial = yield* generate(null, old, { number: 1, name: 'initial' });
					yield* script(pg, initial.file.sql);
					yield* script(
						pg,
						`insert into entry (id, n, store_violations, store_violations_1, "STORE_VIOLATIONS") values
				('11111111-1111-1111-1111-111111111111', 1, 2, 3, 'O''Reilly $store$'),
				('22222222-2222-2222-2222-222222222222', 1, 2, 3, 'O''Reilly $store$')`
					);
					const migration = yield* generate(yield* read_snapshot(initial.snapshot), next, {
						number: 2,
						name: 'unique'
					});
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
				const rename = yield* generate(yield* read_snapshot(initial.snapshot), renamed, {
					number: 2,
					name: 'rename owners'
				});
				expect(unaccepted(rename.plan)).toEqual([]);
				expect(yield* destructive_steps(before, renamed)).toEqual([]);
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
				expect(Object.keys((yield* read_lock(lock)).files)).toEqual([
					initial.file.name,
					rename.file.name
				]);
				expect((yield* plan(renamed, renamed)).steps).toEqual([]);
			})
		)
	);

	it.live('replays chained table, column and ref renames (A -> B -> C) preserving data and verifying every prefix', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const stageA = schema({
					account: table({
						fields: {
							label: { kind: 'text', default: 'untitled' },
							code: { kind: 'text' }
						}
					}),
					ledger: table({
						fields: {
							acct: { kind: 'ref', to: 'account', optional: true }
						}
					})
				});
				const stageB = schema({
					client: table({
						was: 'account',
						fields: {
							title: { kind: 'text', was: 'label', default: 'untitled' },
							code: { kind: 'text' }
						}
					}),
					ledger: table({
						fields: {
							party: { kind: 'ref', to: 'client', was: 'acct', optional: true }
						}
					})
				});
				const stageC = schema({
					customer: table({
						was: 'client',
						fields: {
							display_name: { kind: 'text', was: 'title', default: 'unnamed' },
							code: { kind: 'text' }
						}
					}),
					ledger: table({
						fields: {
							subject: { kind: 'ref', to: 'customer', was: 'party', optional: true }
						}
					})
				});

				const m1 = yield* generate(null, stageA, { number: 1, name: 'initial' });
				const m2 = yield* generate(yield* read_snapshot(m1.snapshot), stageB, {
					number: 2,
					name: 'rename_a_to_b'
				});
				const m3 = yield* generate(yield* read_snapshot(m2.snapshot), stageC, {
					number: 3,
					name: 'rename_b_to_c'
				});
				expect(unaccepted(m2.plan)).toEqual([]);
				expect(unaccepted(m3.plan)).toEqual([]);
				expect(yield* destructive_steps(stageA, stageB)).toEqual([]);
				expect(yield* destructive_steps(stageB, stageC)).toEqual([]);

				const pg = yield* database;
				const freshA = yield* database;
				const freshB = yield* database;
				const freshC = yield* database;

				// Prefix 1: stage A
				yield* script(pg, m1.file.sql);
				yield* script(freshA, `${(yield* build(stageA)).join(';\n')};`);
				yield* script(
					pg,
					`insert into account (id, label, code) values ('11111111-1111-1111-1111-111111111111', 'Acme', 'A1');
					insert into ledger (id, acct) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111');`
				);
				yield* verify([m1.file], m1.snapshot, stageA, yield* introspect(pg), yield* introspect(freshA));

				// Prefix 2: stage A -> B
				yield* script(pg, m2.file.sql);
				yield* script(freshB, `${(yield* build(stageB)).join(';\n')};`);
				expect(
					(
						yield* Effect.promise(() =>
							pg.query<{ title: string; code: string; party: string }>(
								'select c.title, c.code, l.party from client c join ledger l on l.party = c.id order by c.code'
							)
						)
					).rows
				).toEqual([{ title: 'Acme', code: 'A1', party: '11111111-1111-1111-1111-111111111111' }]);
				yield* script(
					pg,
					`insert into client (id, title, code) values ('22222222-2222-2222-2222-222222222222', 'Beta', 'B1');
					insert into ledger (id, party) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222');`
				);
				yield* verify(
					[m1.file, m2.file],
					m2.snapshot,
					stageB,
					yield* introspect(pg),
					yield* introspect(freshB)
				);

				// Prefix 3: stage B -> C
				yield* script(pg, m3.file.sql);
				yield* script(freshC, `${(yield* build(stageC)).join(';\n')};`);
				expect(
					(
						yield* Effect.promise(() =>
							pg.query<{ display_name: string; code: string; subject: string }>(
								'select c.display_name, c.code, l.subject from customer c join ledger l on l.subject = c.id order by c.code'
							)
						)
					).rows
				).toEqual([
					{ display_name: 'Acme', code: 'A1', subject: '11111111-1111-1111-1111-111111111111' },
					{ display_name: 'Beta', code: 'B1', subject: '22222222-2222-2222-2222-222222222222' }
				]);
				const defaulted = yield* Effect.promise(() =>
					pg.query<{ display_name: string }>(
						`insert into customer (id, code) values ('33333333-3333-3333-3333-333333333333', 'C1') returning display_name`
					)
				);
				expect(defaulted.rows[0]?.display_name).toBe('unnamed');

				const files = [m1.file, m2.file, m3.file];
				const lockText = yield* verify(
					files,
					m3.snapshot,
					stageC,
					yield* introspect(pg),
					yield* introspect(freshC)
				);
				const lock = yield* read_lock(lockText);
				expect(Object.keys(lock.files)).toEqual([m1.file.name, m2.file.name, m3.file.name]);
				expect(
					yield* pending(files, lock, [{ name: m1.file.name, checksum: checksum_of(m1.file) }], m3.snapshot)
				).toEqual([m2.file, m3.file]);
				expect(
					yield* pending(
						files,
						lock,
						[
							{ name: m1.file.name, checksum: checksum_of(m1.file) },
							{ name: m2.file.name, checksum: checksum_of(m2.file) }
						],
						m3.snapshot
					)
				).toEqual([m3.file]);
				expect((yield* plan(stageC, stageC)).steps).toEqual([]);
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
					const migration = yield* generate(yield* read_snapshot(initial.snapshot), next, {
						number: 2,
						name: 'zip'
					});
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
					const migration = yield* generate(yield* read_snapshot(initial.snapshot), next, {
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
					expect(yield* check_file(file)).toEqual(file);
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
						yield* failure(check_file({ ...file, sql: '-- check: writes\ndelete from person;' }))
					).toContain('check writes needs one SELECT');
				})
			)
	);

	it.effect('refuses destructive files until each destructive block has its accept line', () =>
		Effect.gen(function* () {
			const next = schema({ person: before.tables.person });
			const snapshot = yield* schema_snapshot(before);
			const generated = yield* generate(snapshot, next, { number: 1, name: 'remove' });
			expect(yield* failure(check_file(generated.file))).toContain(
				'destructive steps need an accept line'
			);
			const accepted = yield* generate(snapshot, next, {
				number: 1,
				name: 'remove',
				accept: unaccepted(generated.plan).map((step) => step.id)
			});
			expect(yield* check_file(accepted.file)).toEqual(accepted.file);
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
				const snapshot = yield* schema_snapshot(old);
				const generated = yield* generate(snapshot, schema({}), { number: 1, name: 'remove' });
				expect(yield* failure(check_file(generated.file))).toContain(
					'destructive steps need an accept line'
				);
				const accepted = yield* generate(snapshot, schema({}), {
					number: 1,
					name: 'remove',
					accept: unaccepted(generated.plan).map((step) => step.id)
				});
				expect(yield* check_file(accepted.file)).toEqual(accepted.file);
			})
	);

	it.effect('checks a contiguous history, verified file checksums and the locked snapshot', () =>
		Effect.gen(function* () {
			const first: MigrationFile = { name: '0001_initial.sql', sql: 'select 1;' };
			const second: MigrationFile = { name: '0002_more.sql', sql: 'select 2;' };
			const files = [second, first];
			const snapshot = snapshot_of(before);
			const lock = yield* read_lock(lock_of(snapshot, files));
			expect(
				yield* pending(files, lock, [{ name: first.name, checksum: checksum_of(first) }], snapshot)
			).toEqual([second]);
			expect(
				yield* failure(pending(files, lock, [{ name: second.name, checksum: checksum_of(second) }]))
			).toContain('not a prefix');
			expect(
				yield* failure(
					pending(files, lock, [
						{ name: first.name, checksum: checksum_of(first) },
						{ name: first.name, checksum: checksum_of(first) }
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
			const snapshot = snapshot_of(before);
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

	it.effect('rejects hostile SQL migration constructs (set_config concat, EXECUTE, COPY PROGRAM, SECURITY DEFINER, unallowlisted extensions, protected ledger DML)', () =>
		Effect.gen(function* () {
			const cases: [string, RegExp][] = [
				["DO $$ BEGIN PERFORM set_config('statement' || '_timeout', '0', true); END $$;", /bounded migration/],
				["DO $$ BEGIN EXECUTE 'SET statement_timeout = 0'; END $$;", /bounded migration/],
				["COPY notes FROM PROGRAM 'id';", /COPY PROGRAM/],
				['CREATE FUNCTION pwn() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;', /SECURITY DEFINER/],
				['CREATE EXTENSION IF NOT EXISTS plpython3u;', /migration allowlist/],
				['DELETE FROM bolt_history;', /protected system ledger/],
				['TRUNCATE TABLE bolt_audit_receipt;', /protected system ledger/],
				['UPDATE bolt_approvals SET state = \'approved\';', /protected system ledger/]
			];
			for (const [sql, pattern] of cases) {
				const err = yield* failure(check_file({ name: '0002_hostile.sql', sql }));
				expect(err).toMatch(pattern);
			}
			// Allowlisted extensions remain permitted
			const ok = yield* check_file({ name: '0002_ext.sql', sql: 'CREATE EXTENSION IF NOT EXISTS pg_trgm;' });
			expect(ok.name).toBe('0002_ext.sql');
			expect(is_extension_statement('CREATE EXTENSION IF NOT EXISTS vector;')).toBe(true);
			expect(is_extension_statement('CREATE EXTENSION IF NOT EXISTS plpython3u;')).toBe(false);
		})
	);

	it.live('runs workspace migration SQL under non-superuser bolt_migrator role while blocking ledger tampering and superuser ops at the Postgres layer', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* database;
				yield* script(
					pg,
					[
						MIGRATIONS_TABLE,
						'create table bolt_history (id text primary key, body text not null)',
						"insert into bolt_history (id, body) values ('h1', 'immutable')",
						'create table user_item (id text primary key, title text not null)',
						"insert into user_item (id, title) values ('u1', 'alpha')"
					].join(';\n')
				);
				yield* script(pg, MIGRATION_ROLE_PREPARE);
				// User DDL & DML succeed inside bolt_migrator transaction
				yield* Effect.promise(() =>
					pg.exec(`
						begin;
						${MIGRATION_ROLE_ENTER};
						alter table user_item add column code text not null default 'v1';
						update user_item set code = 'v2' where id = 'u1';
						create table user_extra (id text primary key);
						${MIGRATION_ROLE_EXIT};
						commit;
					`)
				);
				const updated = yield* Effect.promise(() =>
					pg.query<{ code: string; who: string }>('select code, current_user as who from user_item')
				);
				expect(updated.rows[0]?.code).toBe('v2');
				// Protected ledger DML and superuser operations are denied by Postgres itself under bolt_migrator
				const tryAsMigrator = (sql: string) =>
					Effect.promise(() =>
						pg
							.exec(`begin; ${MIGRATION_ROLE_ENTER}; ${sql}; commit;`)
							.then(
								() => 'ok',
								async (error: unknown) => {
									await pg.exec('rollback').catch(() => undefined);
									return error instanceof Error ? error.message : String(error);
								}
							)
					);
				expect(yield* tryAsMigrator(`select current_user`)).toBe('ok');
				const roleCheck = yield* Effect.promise(async () => {
					await pg.exec(`begin; ${MIGRATION_ROLE_ENTER};`);
					const res = await pg.query<{ role: string; superuser: string }>(
						"select current_user as role, current_setting('is_superuser') as superuser"
					);
					await pg.exec('rollback');
					return res.rows[0];
				});
				expect(roleCheck).toEqual({ role: MIGRATION_ROLE, superuser: 'off' });
				expect(yield* tryAsMigrator('delete from store_migration')).toMatch(/permission denied/i);
				expect(yield* tryAsMigrator('delete from bolt_history')).toMatch(/permission denied/i);
				expect(yield* tryAsMigrator("select pg_read_file('/etc/passwd')")).toMatch(/permission denied|must be superuser/i);
				expect(yield* tryAsMigrator("copy user_item from program 'id'")).toMatch(/permission denied|must be superuser/i);
			})
		)
	);
});
