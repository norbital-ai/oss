import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { Effect, Schema } from 'effect';
import {
	APPLIED,
	AppliedRow,
	IntrospectRow,
	MIGRATIONS_TABLE,
	MIGRATION_GUARD_CODES,
	StoreError,
	checksumOf,
	logCurrent,
	logDdl,
	logIntrospect,
	logMigrationGuard,
	migrationStatus,
	pending,
	physicalHash,
	physicalDefinitionsOf,
	readLock,
	readPhysicalDefinitions,
	recordApplied,
	verifyLog,
	type AppendOnlyLogSpec,
	type MigrationFile
} from '@norbital-ai/store';
import { SqlReadCapture, SqlSessionDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { AuditMutation } from '../engine/audit-context.ts';
import type { DbError } from '../engine/errors.ts';
import { PgliteDb, Pristine } from './db/pglite.ts';
import { auditLogSpec } from './audit-schema.ts';

export type AuditMigrations = {
	readonly spec: AppendOnlyLogSpec;
	readonly files: readonly MigrationFile[];
	readonly snapshot: string;
	readonly lock: string;
	readonly physical: string;
};
const invalid = (message: string) =>
	StoreError.of('migrationChanged', 'admission', `audit log: ${message}`);

/** Packaged immutable source, with one directory per supported storage scope. */
export const readAuditMigrations = (scoped: boolean) =>
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
			spec: auditLogSpec(scoped),
			files: yield* Effect.forEach(files, (name) =>
				Effect.map(read(name), (sql) => ({ name, sql }))
			),
			snapshot: yield* read('snapshot.json'),
			lock: yield* read('migrations.lock.json'),
			physical: yield* read('physical.json')
		} satisfies AuditMigrations;
	});

/** Two independent databases prove immutable history versus fresh declaration, including privileges and every prefix. */
export const auditMigrationProof = (
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
			const ddl = yield* logDdl(spec),
				inspect = { text: logIntrospect(spec), params: [] };
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
				lock: yield* verifyLog(files, snapshot, spec, actual, expected, physical),
				physical: physicalDefinitionsOf(physical)
			};
		})
	).pipe(Effect.provide(Pristine.layer));

/** The same native adapter bounds each file; exact legacy adoption records only a receipt and preserves payloads. */
export const applyAuditMigrations = (db: TenantDbShape, migrations: AuditMigrations) =>
	Effect.gen(function* () {
		yield* logCurrent(migrations.snapshot, migrations.spec);
		const lock = yield* readLock(migrations.lock);
		yield* pending(migrations.files, lock, [], migrations.snapshot);
		const physical = yield* readPhysicalDefinitions(migrations.physical);
		const names = ['', ...migrations.files.map(({ name }) => name)].sort();
		if (
			JSON.stringify(Object.keys(physical).sort()) !== JSON.stringify(names) ||
			JSON.stringify(Object.keys(lock.physical ?? {}).sort()) !== JSON.stringify(names)
		)
			return yield* invalid('proofs must cover every immutable prefix');
		for (const [name, lines] of Object.entries(physical))
			if (physicalHash(lines) !== lock.physical?.[name])
				return yield* invalid(`${name}: native definitions or privileges differ from their lock`);
		const advisory = { advisory: [`${migrations.spec.namespace}_migration`] };
		for (const text of (yield* logDdl(migrations.spec)).slice(0, 2))
			yield* db.write({ text, params: [] }, advisory);
		yield* db.write({ text: MIGRATIONS_TABLE, params: [] }, advisory);
		const inspect = { text: logIntrospect(migrations.spec), params: [] };
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
			const initial = migrations.files[0];
			// Only the exact, independently replayed former layout can be adopted without replaying CREATE TABLE.
			const adopt =
				applied.length === 0 &&
				initial !== undefined &&
				physicalHash(lines) === lock.physical?.[initial.name];
			const status = adopt
				? undefined
				: yield* migrationStatus(migrations.files, lock, applied, {
						snapshot: migrations.snapshot,
						physical: lines
					});
			if (!adopt && status?.physical !== 'current' && status?.physical !== 'prefix')
				return yield* invalid('live schema or privileges differ from their verified prefix');
			const file = adopt ? initial : status?.pending[0];
			const statements = [logMigrationGuard(migrations.spec, applied, lines, 'before')];
			if (file !== undefined) {
				const after = physical[file.name];
				if (after === undefined) return yield* invalid(`${file.name}: missing physical prefix`);
				if (!adopt) statements.push({ text: file.sql, params: [] });
				statements.push(
					recordApplied(file),
					logMigrationGuard(
						migrations.spec,
						[...applied, { name: file.name, checksum: checksumOf(file) }],
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
		Effect.provideService(SqlSessionDb, undefined),
		Effect.provideService(SqlReadCapture, undefined)
	);
