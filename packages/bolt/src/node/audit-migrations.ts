import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Effect, Schema } from 'effect';
import { equal_json } from '@norbital-ai/std/json';
import {
	APPLIED,
	AppliedRow,
	IntrospectRow,
	MIGRATIONS_TABLE,
	MIGRATION_GUARD_CODES,
	StoreError,
	checksum_of,
	log_current,
	log_ddl,
	log_introspect,
	log_migration_guard,
	migration_status,
	pending,
	physical_hash,
	physical_definitions_of,
	read_lock,
	read_physical_definitions,
	record_applied,
	verify_log,
	type AppendOnlyLogSpec,
	type MigrationFile
} from '@norbital-ai/store';
import { SqlReadCapture, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { AuditMutation } from '../engine/audit-context.ts';
import type { DbError } from '../engine/errors.ts';
import { PgliteDb, Pristine } from './db/pglite.ts';
import { audit_log_spec } from './audit-schema.ts';

type AuditMigrations = {
	readonly spec: AppendOnlyLogSpec;
	readonly files: readonly MigrationFile[];
	readonly snapshot: string;
	readonly lock: string;
	readonly physical: string;
};
const invalid = (message: string) =>
	StoreError.of('migration_changed', 'admission', `audit log: ${message}`);

/** Packaged immutable source, with one directory per supported storage scope. */
export const read_audit_migrations = (scoped: boolean) =>
	Effect.gen(function* () {
		const directory = new URL(`./audit/${scoped ? 'scoped' : 'standalone'}/`, import.meta.url);
		const files = (yield* Effect.tryPromise({
			try: () => readdir(directory),
			catch: (cause) => invalid(`read migration directory: ${String(cause)}`)
		}))
			.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
			.sort();
		const read = (name: string) =>
			Effect.tryPromise({
				try: () => readFile(new URL(name, directory), 'utf8'),
				catch: (cause) => invalid(`read ${name}: ${String(cause)}`)
			});
		return {
			spec: audit_log_spec(scoped),
			files: yield* Effect.forEach(files, (name) =>
				Effect.map(read(name), (sql) => ({ name, sql }))
			),
			snapshot: yield* read('snapshot.json'),
			lock: yield* read('migrations.lock.json'),
			physical: yield* read('physical.json')
		} satisfies AuditMigrations;
	});

/** Two independent databases prove immutable history versus fresh declaration, including privileges and every prefix. */
export const audit_migration_proof = (
	spec: AppendOnlyLogSpec,
	files: readonly MigrationFile[],
	snapshot: string
) =>
	Effect.scoped(
		Effect.gen(function* () {
			// from the machine's initdb dump (~13× cheaper than initdb), with the log's own extension
			const pristine = yield* (yield* Pristine).pipe(Effect.mapError((e) => invalid(e.message)));
			const open = Effect.acquireRelease(
				Effect.tryPromise({
					try: () => PGlite.create({ loadDataDir: pristine, extensions: { pg_trgm } }),
					catch: (cause) => invalid(String(cause))
				}),
				(pg) => Effect.promise(() => pg.close())
			).pipe(Effect.map(PgliteDb.make));
			const replay = yield* open,
				declared = yield* open;
			const ddl = yield* log_ddl(spec),
				inspect = { text: log_introspect(spec), params: [] };
			// A preinstalled extension is a declared retained prerequisite, not evidence of an existing log schema.
			for (const text of ddl.slice(0, 2)) {
				yield* replay.write({ text, params: [] });
				yield* declared.write({ text, params: [] });
			}
			const physical: Record<string, readonly string[]> = {};
			const capture = (name: string) =>
				Effect.map(replay.rows(IntrospectRow, inspect), (rows) => {
					const lines = rows.map(({ line }) => line);
					physical[name] = lines;
					return lines;
				});
			let actual = yield* capture('');
			for (const file of files) {
				yield* replay.write({ text: file.sql, params: [] });
				actual = yield* capture(file.name);
			}
			for (const text of ddl.slice(2)) yield* declared.write({ text, params: [] });
			const expected = (yield* declared.rows(IntrospectRow, inspect)).map(({ line }) => line);
			return {
				lock: yield* verify_log(files, snapshot, spec, actual, expected, physical),
				physical: physical_definitions_of(physical)
			};
		})
	).pipe(Effect.provide(Pristine.layer));

/** The same native adapter bounds each file and records its verified immutable prefix. */
export const apply_audit_migrations = (db: TenantDbShape, migrations: AuditMigrations) =>
	Effect.gen(function* () {
		yield* log_current(migrations.snapshot, migrations.spec);
		const lock = yield* read_lock(migrations.lock);
		yield* pending(migrations.files, lock, [], migrations.snapshot);
		const physical = yield* read_physical_definitions(migrations.physical);
		const names = ['', ...migrations.files.map(({ name }) => name)].sort();
		if (
			!equal_json(Object.keys(physical).sort(), names) ||
			!equal_json(Object.keys(lock.physical ?? {}).sort(), names)
		)
			return yield* invalid('proofs must cover every immutable prefix');
		for (const [name, lines] of Object.entries(physical))
			if (physical_hash(lines) !== lock.physical?.[name])
				return yield* invalid(`${name}: native definitions or privileges differ from their lock`);
		const advisory = { advisory: [`${migrations.spec.namespace}_migration`] };
		for (const text of (yield* log_ddl(migrations.spec)).slice(0, 2))
			yield* db.write({ text, params: [] }, advisory);
		yield* db.write({ text: MIGRATIONS_TABLE, params: [] }, advisory);
		const inspect = { text: log_introspect(migrations.spec), params: [] };
		while (true) {
			const rows = yield* db.transaction({
				statements: [{ text: APPLIED, params: [] }, inspect],
				lock: advisory
			});
			const applied = yield* Schema.decodeUnknownEffect(Schema.Array(AppliedRow))(
				rows[0]?.rows ?? []
			).pipe(Effect.mapError((cause) => invalid(cause.message)));
			const lines = (yield* Schema.decodeUnknownEffect(Schema.Array(IntrospectRow))(
				rows[1]?.rows ?? []
			).pipe(Effect.mapError((cause) => invalid(cause.message)))).map(({ line }) => line);
			const status = yield* migration_status(migrations.files, lock, applied, {
				snapshot: migrations.snapshot,
				physical: lines
			});
			if (status.physical !== 'current' && status.physical !== 'prefix')
				return yield* invalid(
					'live schema or privileges differ from their verified prefix; resolve unreceipted layouts externally before opening'
				);
			const file = status.pending[0];
			const statements = [log_migration_guard(migrations.spec, applied, lines, 'before')];
			if (file !== undefined) {
				const after = physical[file.name];
				if (after === undefined) return yield* invalid(`${file.name}: missing physical prefix`);
				statements.push({ text: file.sql, params: [] });
				statements.push(
					record_applied(file),
					log_migration_guard(
						migrations.spec,
						[...applied, { name: file.name, checksum: checksum_of(file) }],
						after,
						'after'
					)
				);
			}
			const settled = yield* db.transaction({ statements, lock: advisory }).pipe(
				Effect.as(true),
				Effect.catchTag('DbError', (error): Effect.Effect<boolean, StoreError | DbError> =>
					error.sqlstate === MIGRATION_GUARD_CODES.beforeLedger ||
					error.sqlstate === MIGRATION_GUARD_CODES.beforePhysical
						? Effect.succeed(false)
						: error.sqlstate === MIGRATION_GUARD_CODES.afterLedger ||
							  error.sqlstate === MIGRATION_GUARD_CODES.afterPhysical
							? Effect.fail(
									invalid(
										'migration did not reach its verified native endstate; SQL and receipt rolled back'
									)
								)
							: Effect.fail(error)
				)
			);
			if (settled && file === undefined) return;
		}
	}).pipe(
		Effect.provideService(AuditMutation, undefined),
		Effect.provideService(SqlReadCapture, undefined)
	);
