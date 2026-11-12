import { it, expect } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import {
	APPLIED,
	AppliedRow,
	IntrospectRow,
	MIGRATIONS_TABLE,
	StoreError,
	checksum_of,
	log_ddl,
	log_introspect,
	read_physical_definitions
} from '@norbital-ai/store';
import {
	apply_audit_migrations,
	audit_migration_proof,
	read_audit_migrations
} from '../src/node/audit-migrations.ts';

it.live('proves the native audit history against its declaration', () =>
	Effect.gen(function* () {
		const migrations = yield* read_audit_migrations(true);
		const proof = yield* audit_migration_proof(
			migrations.spec,
			migrations.files,
			migrations.snapshot
		);
		expect(proof.lock).toBe(migrations.lock);
		expect(proof.physical).toBe(migrations.physical);
	})
);

it.live('rejects an audit migration that grants public access', () =>
	Effect.gen(function* () {
		const migrations = yield* read_audit_migrations(true);
		const edited = migrations.files.map((file, index) =>
			index !== migrations.files.length - 1
				? file
				: { ...file, sql: `${file.sql}\nGRANT USAGE ON SCHEMA bolt_audit TO PUBLIC;\n` }
		);
		const refused = yield* Effect.flip(
			audit_migration_proof(migrations.spec, edited, migrations.snapshot)
		);
		expect(refused).toBeInstanceOf(StoreError);
		if (refused instanceof StoreError) expect(refused.code).toBe('migration_changed');
	})
);

it.live('applies a fresh audit chain and reopens its verified current ledger without changes', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const pristine = yield* yield* Pristine;
			for (const scoped of [false, true]) {
				const migrations = yield* read_audit_migrations(scoped);
				const LedgerRow = Schema.Struct({
					name: Schema.String,
					checksum: Schema.String,
					applied_at: Schema.String
				});
				const ledger = {
					text: 'SELECT name,checksum,applied_at::text AS applied_at FROM store_migration ORDER BY name',
					params: []
				};
				const inspect = { text: log_introspect(migrations.spec), params: [] };
				const held = yield* Effect.scoped(
					Effect.gen(function* () {
						const pg = yield* Effect.acquireRelease(
							Effect.promise(() =>
								PGlite.create({ loadDataDir: pristine, extensions: { pg_trgm } })
							),
							(pg) => Effect.promise(() => pg.close())
						);
						const db = PgliteDb.make(pg);
						yield* apply_audit_migrations(db, migrations);
						const receipts = yield* db.rows(AppliedRow, { text: APPLIED, params: [] });
						expect(receipts).toEqual(
							migrations.files.map((file) => ({ name: file.name, checksum: checksum_of(file) }))
						);
						const current = migrations.files.at(-1);
						if (current === undefined) return yield* Effect.die('The audit chain is empty.');
						const physical = yield* read_physical_definitions(migrations.physical);
						const native = yield* db.rows(IntrospectRow, inspect);
						expect(native.map(({ line }) => line)).toEqual(physical[current.name]);
						yield* db.write({ text: 'CHECKPOINT', params: [] });
						return {
							native,
							ledger: yield* db.rows(LedgerRow, ledger),
							dump: yield* Effect.promise(() => pg.dumpDataDir('none'))
						};
					})
				);
				yield* Effect.scoped(
					Effect.gen(function* () {
						const pg = yield* Effect.acquireRelease(
							Effect.promise(() =>
								PGlite.create({ loadDataDir: held.dump, extensions: { pg_trgm } })
							),
							(pg) => Effect.promise(() => pg.close())
						);
						const db = PgliteDb.make(pg);
						yield* apply_audit_migrations(db, migrations);
						expect(yield* db.rows(LedgerRow, ledger)).toEqual(held.ledger);
						expect(yield* db.rows(IntrospectRow, inspect)).toEqual(held.native);
					})
				);
			}
		})
	).pipe(Effect.provide(Pristine.layer))
);

it.live('refuses an exact unreceipted audit layout without adopting or changing its rows', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const pristine = yield* yield* Pristine;
			for (const scoped of [false, true]) {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const pg = yield* Effect.acquireRelease(
							Effect.promise(() =>
								PGlite.create({ loadDataDir: pristine, extensions: { pg_trgm } })
							),
							(pg) => Effect.promise(() => pg.close())
						);
						const db = PgliteDb.make(pg);
						const migrations = yield* read_audit_migrations(scoped);
						const initial = migrations.files[0];
						if (initial === undefined) return yield* Effect.die('The audit chain is empty.');
						for (const text of (yield* log_ddl(migrations.spec)).slice(0, 2))
							yield* db.write({ text, params: [] });
						yield* db.write({ text: initial.sql, params: [] });
						yield* db.write({ text: MIGRATIONS_TABLE, params: [] });
						const original = {
							id: 'unreceipted',
							operationId: 'original-operation',
							at: '2001-01-01T00:00:00.000Z',
							category: 'write',
							action: 'entries.update',
							status: 'pending_approval',
							actor: { kind: 'api_key', id: 'original-key' },
							subject: null,
							invocation: null,
							transaction: null,
							run: null,
							approval: null,
							payload: { text: 'pending_approval api_key', preserved: { amount: 42 } }
						};
						yield* db.write(
							scoped
								? {
										text: 'SELECT bolt_audit.append($1,$2,$3,$4::jsonb)',
										params: ['platform', 'tenant', 'live', [original]]
									}
								: { text: 'SELECT bolt_audit.append($1::jsonb)', params: [[original]] }
						);
						const events = () =>
							db.rows(Schema.Struct({ row: Schema.Json }), {
								text: 'SELECT to_jsonb(e) AS row FROM bolt_audit.event e ORDER BY id',
								params: []
							});
						const definitions = () =>
							db.rows(IntrospectRow, {
								text: log_introspect(migrations.spec),
								params: []
							});
						const receipts = () => db.rows(AppliedRow, { text: APPLIED, params: [] });
						const before = yield* events();
						const native = yield* definitions();
						const ledger = yield* receipts();
						const physical = yield* read_physical_definitions(migrations.physical);
						expect(before).toHaveLength(1);
						expect(before[0]?.row).toMatchObject({ event: original });
						expect(native.map(({ line }) => line)).toEqual(physical[initial.name]);
						expect(ledger).toEqual([]);
						const refused = yield* Effect.flip(apply_audit_migrations(db, migrations));
						expect(refused).toBeInstanceOf(StoreError);
						if (refused instanceof StoreError) {
							expect(refused.code).toBe('migration_changed');
							expect(refused.message).toContain('resolve unreceipted layouts externally');
						}
						expect(yield* events()).toEqual(before);
						expect(yield* definitions()).toEqual(native);
						expect(yield* receipts()).toEqual(ledger);
					})
				);
			}
		})
	).pipe(Effect.provide(Pristine.layer))
);
