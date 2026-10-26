import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { database, exec, script } from './support.ts';
import {
	INTROSPECT,
	IntrospectRow,
	archiveOf,
	checkFile,
	checkSquashSources,
	checksumOf,
	comparePhysical,
	generate,
	generateSquash,
	lockOf,
	migrationStatus,
	pending,
	physicalHash,
	physicalDefinitionsOf,
	readLock,
	readPhysicalDefinitions,
	schema,
	snapshotOf,
	table,
	verify,
	verifySquash,
	type Applied,
	type MigrationFile,
	type StoreError
} from '../src/index.ts';

const originals: readonly MigrationFile[] = [
	{ name: '0001_entry.sql', sql: 'create table entry (id uuid primary key, value text);' },
	{ name: '0002_label.sql', sql: 'alter table entry add column label text;' },
	{ name: '0003_label_index.sql', sql: 'create index entry_label on entry (label);' },
	{ name: '0004_count.sql', sql: 'alter table entry add column count int;' }
];
const first: MigrationFile = {
	name: '0002_squash_first.sql',
	sql: 'create table entry (id uuid primary key, value text, label text);'
};
const second: MigrationFile = {
	name: '0003_squash_second.sql',
	sql: `${first.sql}\ncreate index entry_label on entry (label);`
};
const prefix2 = [
	'column entry.id uuid not null',
	'column entry.value text',
	'column entry.label text'
];
const prefix3 = [...prefix2, 'index entry_label CREATE INDEX ON entry USING btree (label)'];
const prefix4 = [...prefix3, 'column entry.count integer'];
const applied = (files: readonly MigrationFile[]): Applied[] =>
	files.map((file) => ({ name: file.name, checksum: checksumOf(file) }));
const failure = <A>(effect: Effect.Effect<A, StoreError>) =>
	Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'ok'));
const fixture = Effect.fn('migrationHistoryFixture')(function* () {
	const oldReceipt = yield* verifySquash(
		originals.slice(0, 2),
		first,
		prefix2,
		[...prefix2].reverse()
	);
	const newReceipt = yield* verifySquash(originals.slice(0, 3), second, prefix3, prefix3);
	const lock = yield* readLock(
		lockOf('snapshot', originals, {
			squashes: [oldReceipt, newReceipt],
			physical: {
				'': physicalHash([]),
				[first.name]: oldReceipt.proof,
				[second.name]: newReceipt.proof,
				'0001_entry.sql': physicalHash(prefix2.slice(0, 2)),
				'0002_label.sql': physicalHash(prefix2),
				'0003_label_index.sql': physicalHash(prefix3),
				'0004_count.sql': physicalHash(prefix4)
			}
		})
	);
	return { lock, oldReceipt, newReceipt, squashes: [first, second] };
});

describe('immutable squash branches', () => {
	it.effect(
		'chooses the longest baseline only for a fresh database and records only actual SQL',
		() =>
			Effect.gen(function* () {
				const { lock, squashes } = yield* fixture();
				const remaining = yield* pending(originals, lock, [], 'snapshot', squashes);
				expect(remaining).toEqual([second, originals[3]]);
				const executed = applied(remaining);
				expect(executed.map((row) => row.name)).toEqual([second.name, '0004_count.sql']);
				expect(yield* pending(originals, lock, executed, 'snapshot', squashes)).toEqual([]);
			})
	);

	it.effect('finishes originals for every partially or fully applied original prefix', () =>
		Effect.gen(function* () {
			const { lock, squashes } = yield* fixture();
			for (let count = 1; count <= originals.length; count++)
				expect(
					yield* pending(originals, lock, applied(originals.slice(0, count)), 'snapshot', squashes)
				).toEqual(originals.slice(count));
		})
	);

	it.effect(
		'continues an older applied receipt with originals even after a longer squash is committed',
		() =>
			Effect.gen(function* () {
				const { lock, squashes } = yield* fixture();
				expect(yield* pending(originals, lock, applied([first]), 'snapshot', squashes)).toEqual(
					originals.slice(2)
				);
				expect(
					yield* pending(
						originals,
						lock,
						applied([first, ...originals.slice(2, 3)]),
						'snapshot',
						squashes
					)
				).toEqual(originals.slice(3));
				expect(
					yield* pending(
						originals,
						lock,
						applied([first, ...originals.slice(2)]),
						'snapshot',
						squashes
					)
				).toEqual([]);
			})
	);

	it.effect(
		'refuses mixed, duplicate, gapped, missing and changed history without rebasing it',
		() =>
			Effect.gen(function* () {
				const { lock, squashes, oldReceipt } = yield* fixture();
				const firstOriginal = originals.slice(0, 1);
				const mixed = applied([...firstOriginal, first]);
				expect(yield* failure(pending(originals, lock, mixed, 'snapshot', squashes))).toContain(
					'not a prefix'
				);
				expect(
					yield* failure(pending(originals, lock, applied([first, second]), 'snapshot', squashes))
				).toContain('multiple squash');
				expect(
					yield* failure(
						pending(
							originals,
							lock,
							applied([...firstOriginal, ...firstOriginal]),
							'snapshot',
							squashes
						)
					)
				).toContain('not a prefix');
				expect(
					yield* failure(
						pending(originals, lock, applied(originals.slice(1, 2)), 'snapshot', squashes)
					)
				).toContain('not a prefix');
				expect(yield* failure(pending(originals, lock, [], 'snapshot', [first]))).toContain(
					'is gone'
				);
				expect(
					yield* failure(pending(originals, lock, [], 'changed snapshot', squashes))
				).toContain('snapshot.json changed');
				expect(
					yield* failure(
						pending(
							originals,
							lock,
							[{ name: first.name, checksum: 'other' }],
							'snapshot',
							squashes
						)
					)
				).toContain('applied with other text');
				expect(
					yield* failure(
						pending(originals, lock, [], 'snapshot', [
							{ ...first, sql: `${first.sql}\n-- edited` },
							second
						])
					)
				).toContain('changed since its baseline');
				expect(
					yield* failure(
						pending(
							originals.map((file) =>
								file.name === '0001_entry.sql' ? { ...file, sql: `${file.sql}\n-- edited` } : file
							),
							lock,
							[],
							'snapshot',
							squashes
						)
					)
				).toContain('changed since it was last verified');
				expect(
					yield* failure(
						pending(
							originals,
							{ ...lock, squashes: [{ ...oldReceipt, replaces: oldReceipt.replaces.slice(1) }] },
							[],
							'snapshot',
							[first]
						)
					)
				).toContain('exact original prefix');
				expect(
					yield* failure(
						pending(
							originals,
							{ ...lock, squashes: [{ ...oldReceipt, archive: 'other' }] },
							[],
							'snapshot',
							[first]
						)
					)
				).toContain('exact original prefix');
			})
	);

	it.effect('retains the four-argument workflow when no squash is committed', () =>
		Effect.gen(function* () {
			const lock = yield* readLock(lockOf('snapshot', originals));
			expect(yield* pending(originals, lock, applied(originals.slice(0, 1)), 'snapshot')).toEqual(
				originals.slice(1)
			);
			expect(yield* failure(pending(originals.slice(1), lock, [], 'snapshot'))).toContain(
				'without gaps'
			);
		})
	);
});

describe('replay proofs and planning status', () => {
	it.effect(
		'rejects identity sequence definition drift while preserving the column identity marker',
		() =>
			Effect.gen(function* () {
				const declaration = schema({ counter: table({ key: 'identity', fields: {} }) });
				const column = 'column counter.id bigint not null identity a';
				const sequence =
					'sequence counter.id bigint start 1 increment 1 min 1 max 9223372036854775807 cache 1 cycle false';
				const changed = sequence.replace('increment 1', 'increment 7');
				const file = {
					name: '0001_counter.sql',
					sql: 'create table counter (id bigint generated always as identity primary key); alter sequence counter_id_seq increment by 7;'
				};
				expect(
					yield* failure(
						verify(
							[file],
							snapshotOf(declaration),
							declaration,
							[column, changed],
							[column, sequence]
						)
					)
				).toContain(`missing ${sequence}`);
				expect(INTROSPECT).toContain('s.seqincrement::text');
				expect(INTROSPECT).toContain('s.seqcache::text');
				expect(INTROSPECT).not.toContain('last_value');
			})
	);

	it.effect(
		'proves the exact archive and edited baseline, rejecting a missing column or changed trigger',
		() =>
			Effect.gen(function* () {
				expect(archiveOf(originals.slice(0, 2))).not.toBe(archiveOf(originals.slice(0, 1)));
				expect(
					yield* failure(verifySquash(originals.slice(0, 2), first, prefix2, prefix2.slice(0, 2)))
				).toContain('does not reproduce');
				expect(
					yield* failure(
						verifySquash(
							originals.slice(0, 2),
							first,
							[...prefix2, 'trigger entry.audit BEFORE UPDATE'],
							[...prefix2, 'trigger entry.audit AFTER UPDATE']
						)
					)
				).toContain('does not reproduce');
				expect(
					yield* failure(
						verifySquash(
							originals.slice(0, 2),
							{ ...first, name: '0001_squash_wrong.sql' },
							prefix2,
							prefix2
						)
					)
				).toContain('numbered at the end');
				expect(physicalHash(prefix2)).toBe(physicalHash([...prefix2].reverse()));
				const definitions = { '': [], [first.name]: prefix2, [second.name]: prefix3 };
				expect(yield* readPhysicalDefinitions(physicalDefinitionsOf(definitions))).toEqual(definitions);
				expect(yield* readPhysicalDefinitions(JSON.stringify(definitions))).toEqual(definitions);
				expect(
					yield* failure(
						readPhysicalDefinitions(JSON.stringify({ format: 1, lines: [], prefixes: { '': [0] } }))
					)
				).toContain('physical definition 0 is missing');
				expect(yield* failure(comparePhysical(prefix2.slice(1), physicalHash(prefix2)))).toContain(
					'live schema differs'
				);
				expect(INTROSPECT).toContain('not t.tgisinternal');
				expect(INTROSPECT).toContain('pg_get_triggerdef');
				expect(INTROSPECT).toContain("x.deptype = 'e'");
			})
	);

	it.effect(
		'reports fresh, partial, current and drifted physical state against the last actual ledger file',
		() =>
			Effect.gen(function* () {
				const { lock, squashes } = yield* fixture();
				const fresh = yield* migrationStatus(originals, lock, [], { squashes, physical: [] });
				expect(fresh).toMatchObject({
					source: 'verified',
					ledger: 'empty',
					covered: 0,
					strategy: 'squash',
					physical: 'prefix'
				});
				const partial = yield* migrationStatus(originals, lock, applied([first]), {
					squashes,
					physical: prefix2
				});
				expect(partial).toMatchObject({
					ledger: 'prefix',
					covered: 2,
					physical: 'prefix',
					expectedPhysical: physicalHash(prefix2)
				});
				const current = yield* migrationStatus(
					originals,
					lock,
					applied([first, ...originals.slice(2)]),
					{ squashes, physical: prefix4 }
				);
				expect(current).toMatchObject({
					ledger: 'current',
					covered: 4,
					physical: 'current',
					pending: []
				});
				expect(
					(yield* migrationStatus(originals, lock, [], { squashes, physical: prefix2 })).physical
				).toBe('drift');
				expect(
					(yield* migrationStatus(originals, lock, applied([first]), { squashes })).physical
				).toBe('unchecked');
				const unproved = yield* readLock(lockOf('snapshot', originals));
				expect(
					(yield* migrationStatus(originals, unproved, applied(originals.slice(0, 1)), {
						physical: prefix2.slice(0, 2)
					})).physical
				).toBe('unverified');
			})
	);
});

describe('safe baseline authoring', () => {
	it.effect('generates a distinct editable baseline without changing original checksums', () =>
		Effect.gen(function* () {
			const declaration = schema({
				entry: table({
					fields: { value: { kind: 'text' }, label: { kind: 'text', optional: true } }
				})
			});
			const checksums = applied(originals.slice(0, 2));
			const generated = yield* generateSquash(originals.slice(0, 2), declaration, {
				name: 'release'
			});
			expect(generated.file.name).toMatch(/^0002_squash_release_[a-f0-9]{12}\.sql$/);
			expect(generated.file.sql).toContain('create table');
			expect(generated.replaces).toEqual(checksums);
			expect(generated.archive).toBe(archiveOf(originals.slice(0, 2)));
			expect(applied(originals.slice(0, 2))).toEqual(checksums);
		})
	);

	it.effect(
		'refuses row transformations and arbitrary executed bodies even when schema lines happen to agree',
		() =>
			Effect.gen(function* () {
				for (const sql of [
					"insert into entry values ('a')",
					"update entry set value = 'changed'",
					'delete from entry',
					'truncate entry',
					'with changed as (delete from entry returning *) select * from changed',
					"do $$ begin execute 'delete from entry'; end $$",
					'select mutate_records()',
					'create table copy as select * from entry',
					'create table copy as values (1)',
					'create table copy as with source as (select 1) select * from source',
					'create table copy as table entry',
					'create table copy as execute seeded_rows',
					'create sequence entry_sequence start with 100',
					'alter sequence entry_sequence restart with 100',
					'alter table entry alter column id restart with 100',
					'create table entry (id bigint generated always as identity (start with 100))',
					'-- step transform (data)\n-- unresolved row transformation'
				]) {
					const data = [{ name: '0001_data.sql', sql }];
					expect(yield* failure(checkSquashSources(data))).not.toBe('ok');
				}
				const changed = {
					...first,
					sql: `${first.sql}\ninsert into entry (value) values ('seed')`
				};
				expect(
					yield* failure(verifySquash(originals.slice(0, 2), changed, prefix2, prefix2))
				).toContain('data-affecting');
			})
	);

	it.effect(
		'understands generated validation and stored trigger definitions without treating them as writes',
		() =>
			Effect.gen(function* () {
				const before = schema({
					entry: table({ audit: true, fields: { value: { kind: 'text' } } })
				});
				const after = schema({
					entry: table({ audit: true, fields: { value: { kind: 'text', unique: true } } })
				});
				const initial = yield* generate(null, before, { number: 1, name: 'initial' });
				const unique = yield* generate(before, after, { number: 2, name: 'unique' });
				expect(yield* checkSquashSources([initial.file, unique.file])).toEqual([
					initial.file,
					unique.file
				]);
			})
	);

	it.effect('admits only the supported extension DDL emitted by Store', () =>
		Effect.gen(function* () {
			for (const extension of ['vector', 'btree_gist']) {
				const file = {
					name: '0001_extension.sql',
					sql: `create extension if not exists ${extension};`
				};
				expect(yield* checkSquashSources([file])).toEqual([file]);
			}
			for (const sql of [
				'create extension custom',
				"create extension if not exists vector version '1'",
				'create extension if not exists vector schema other'
			])
				expect(
					(yield* Effect.flip(checkSquashSources([{ name: '0001_extension.sql', sql }]))).code
				).toBe('migrationInvalid');
		})
	);

	it.effect(
		'keeps authored SQL inside the host transaction and preserves its server deadlines',
		() =>
			Effect.gen(function* () {
				for (const sql of [
					'begin',
					'start transaction',
					'commit',
					'end',
					'rollback',
					'abort',
					'savepoint authored',
					'release savepoint authored',
					"prepare transaction 'authored'",
					"set lock_timeout = '0'",
					"set local lock_timeout to '0'",
					"set session lock_timeout = '0'",
					'set "lock_timeout" = 0',
					'reset lock_timeout',
					'set statement_timeout = 0',
					'reset statement_timeout',
					'set local idle_in_transaction_session_timeout = 0',
					'reset idle_in_transaction_session_timeout',
					'set transaction_timeout = 0',
					'reset transaction_timeout',
					"select set_config('lock_timeout', '0', true)",
					"select pg_catalog.set_config('statement_timeout', '0', true)",
					"select set_config('idle_in_transaction_session_timeout', '0', true)",
					"select set_config('transaction_timeout', '0', true)",
					'do $$begin set local statement_timeout = 0; end$$',
					"do $$begin perform set_config('lock_timeout','0',true); end$$",
					"do $$begin execute 'reset idle_in_transaction_session_timeout'; end$$",
					'reset all'
				]) {
					const error = yield* Effect.flip(checkFile({ name: '0001_escape.sql', sql }));
					expect(error).toMatchObject({ code: 'migrationInvalid', phase: 'admission' });
					expect(error.message).toContain(
						sql.includes('timeout') || sql === 'reset all'
							? 'belong to the host'
							: 'transaction control cannot run'
					);
				}
				const safe = {
					name: '0001_body.sql',
					sql: "-- commit; reset lock_timeout\ncreate function retained() returns text language sql as $$ select 'commit; set lock_timeout = 0' $$;"
				};
				expect(yield* checkFile(safe)).toEqual(safe);
			})
	);

	it.effect(
		'refuses concurrent index commands in atomic files while ignoring descriptions, identifiers and literals',
		() =>
			Effect.gen(function* () {
				for (const sql of [
					'create index concurrently entry_value on entry(value)',
					'drop index concurrently entry_value',
					'reindex table concurrently entry'
				])
					expect(yield* failure(checkFile({ name: '0001_index.sql', sql }))).toContain(
						'CONCURRENTLY cannot run'
					);
				const safe = {
					name: '0001_literal.sql',
					sql: '-- create index concurrently is unsupported\ncreate table "concurrently" (note text default \'create index concurrently\'); /* drop index concurrently */'
				};
				expect(yield* checkFile(safe)).toEqual(safe);
			})
	);

	it.live('introspects empty tables, view definitions and identity sequence configuration', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const pg = yield* database;
				const inspect = () =>
					exec(pg)({ text: INTROSPECT, params: [] }).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(IntrospectRow))),
						Effect.map((rows) => rows.map((row) => row.line))
					);
				const empty = yield* inspect();
				yield* script(
					pg,
					'create table orphan (); create view orphan_view as select 1 as n; create table counter (id bigint generated always as identity primary key)'
				);
				const before = yield* inspect();
				expect(before.some((line) => line.startsWith('table orphan r '))).toBe(true);
				expect(
					before.some(
						(line) => line.startsWith('table orphan_view v ') && line.includes('definition')
					)
				).toBe(true);
				expect(yield* failure(comparePhysical(before, physicalHash(empty)))).toContain('differs');
				yield* script(pg, 'alter sequence counter_id_seq increment by 7');
				const after = yield* inspect();
				expect(after.filter((line) => line.startsWith('column counter.id '))).toEqual(
					before.filter((line) => line.startsWith('column counter.id '))
				);
				expect(after.find((line) => line.startsWith('sequence counter.id '))).toContain(
					'increment 7'
				);
				expect(yield* failure(comparePhysical(after, physicalHash(before)))).toContain('differs');
			})
		)
	);

	it.effect(
		'renders widening and index work as operational exposure rather than promising unchanged storage',
		() =>
			Effect.gen(function* () {
				const before = schema({ entry: table({ fields: { count: { kind: 'int' } } }) });
				const after = schema({
					entry: table({
						fields: { count: { kind: 'int', storage: 'int64' } },
						indexes: [{ on: ['count'] }]
					})
				});
				const generated = yield* generate(before, after, { number: 1, name: 'widen' });
				expect(generated.file.sql).not.toContain('nothing existing changes');
				expect(generated.file.sql).toContain('access-exclusive-lock');
				expect(generated.file.sql).toContain('table-rewrite');
				expect(generated.file.sql).toContain('may rewrite');
				expect(generated.file.sql).toContain('table-scan');
			})
	);
});
