// Hosts execute committed SQL. Store owns immutable histories, alternatives and their physical replay proofs.
import { Effect, FileSystem, Path, Schema } from 'effect';
import {
	APPLIED,
	AppliedRow,
	INTROSPECT,
	IntrospectRow,
	MIGRATIONS_TABLE,
	MIGRATION_GUARD_CODES,
	checksumOf,
	current,
	migrationGuard,
	migrationStatus,
	pending,
	readLock,
	readPhysicalDefinitions,
	readSnapshot,
	recordApplied,
	sha256Hex,
	physicalHash,
	type Applied,
	type MigrationFile,
	type MigrationLock,
	type SchemaSpec
} from '@norbital-ai/store';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { DbError } from '../errors.ts';
import { BoltError, fromStore } from '../../protocol/errors.ts';
import { engineOwned, engineOwns } from './engine.ts';
import { engineBeside, fingerprint, schemaSlice } from './plan.ts';

export type MigrationBundle = {
	readonly files: readonly MigrationFile[];
	readonly squashes: readonly MigrationFile[];
	readonly snapshotText: string;
	readonly snapshot: SchemaSpec;
	readonly lock: MigrationLock;
	readonly physical: Readonly<Record<string, readonly string[]>>;
};
export const migrationSchema = (manifest: EngineManifest): SchemaSpec => {
	const { tables, tz, currency } = schemaSlice(manifest);
	return { tables, tz, currency };
};

/** Exact engine registry exclusions; an unexpected user object is never hidden by a name prefix. */
export const migrationLines = (
	rows: readonly (typeof IntrospectRow.Type)[],
	includeMinor = false,
	sourceNative = false
): readonly string[] =>
	rows
		.filter(
			(row) =>
				row.kind === undefined ||
				row.owner === undefined ||
				(includeMinor && row.kind === 'function' && row.owner === 'bolt_minor_units(c text)') ||
				!engineOwns(row.kind, row.owner, sourceNative)
		)
		.map((row) => row.line);

/** Reassemble the original chain without changing the bytes retained by any verified archive. */
export const readMigrationSources = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.readMigrationSources')(function* (directory: string, lock?: MigrationLock) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const originals = new Map<string, MigrationFile>();
		const add = Effect.fn('Bolt.readMigrationSource')(function* (file: MigrationFile) {
			const existing = originals.get(file.name);
			if (existing !== undefined && existing.sql !== file.sql)
				return yield* BoltError.make(
					'migrationChanged',
					'admission',
					`${file.name} differs from its retained archive; archived SQL never changes`
				);
			originals.set(file.name, file);
		});
		if (yield* fs.exists(directory))
			for (const name of (yield* fs.readDirectory(directory)).sort())
				if (name.endsWith('.sql'))
					yield* add({ name, sql: yield* fs.readFileString(path.join(directory, name)) });
		const squashes: MigrationFile[] = [];
		for (const receipt of lock?.squashes ?? []) {
			if (!/^[a-f0-9]{64}$/.test(receipt.archive) || !/^\d{4}_[a-z0-9_]+\.sql$/.test(receipt.file))
				return yield* BoltError.make(
					'migrationInvalid',
					'admission',
					'a squash receipt has an invalid archive or filename'
				);
			const archive = path.join(directory, 'archive', receipt.archive);
			const names = (yield* fs.readDirectory(archive))
				.filter((name) => name.endsWith('.sql'))
				.sort();
			if (
				names.join('\n') !==
				receipt.replaces
					.map((file) => file.name)
					.sort()
					.join('\n')
			)
				return yield* BoltError.make(
					'migrationChanged',
					'admission',
					`${receipt.file}: the retained archive is incomplete or contains unknown SQL`
				);
			for (const saved of receipt.replaces) {
				if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(saved.name))
					return yield* BoltError.make(
						'migrationInvalid',
						'admission',
						'an archive receipt has an invalid filename'
					);
				const file = {
					name: saved.name,
					sql: yield* fs.readFileString(path.join(archive, saved.name))
				};
				if (checksumOf(file) !== saved.checksum)
					return yield* BoltError.make(
						'migrationChanged',
						'admission',
						`${saved.name}: archived SQL changed`
					);
				yield* add(file);
			}
			squashes.push({
				name: receipt.file,
				sql: yield* fs.readFileString(path.join(directory, 'squashes', receipt.file))
			});
		}
		return {
			files: [...originals.values()].sort((a, b) => a.name.localeCompare(b.name)),
			squashes
		};
	}))();

export const readMigrations = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.readMigrations')(function* (directory: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!(yield* fs.exists(directory)))
			return yield* BoltError.make(
				'migrationInvalid',
				'admission',
				'migrations/ is missing; run bolt build and commit it'
			);
		const snapshotText = yield* fs.readFileString(path.join(directory, 'snapshot.json'));
		const snapshot = yield* readSnapshot(snapshotText).pipe(Effect.mapError(fromStore));
		const lock = yield* readLock(
			yield* fs.readFileString(path.join(directory, 'migrations.lock.json'))
		).pipe(Effect.mapError(fromStore));
		const { files, squashes } = yield* readMigrationSources(directory, lock);
		if (files.length === 0)
			return yield* BoltError.make(
				'migrationInvalid',
				'admission',
				'migrations/ holds no SQL history; run bolt build'
			);
		if (lock.snapshot !== sha256Hex(snapshotText))
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				'migrations/snapshot.json changed since verification; run bolt build'
			);
		yield* pending(files, lock, [], snapshotText, squashes).pipe(Effect.mapError(fromStore));
		const physicalFile = path.join(directory, 'physical.json');
		if (!(yield* fs.exists(physicalFile)))
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				'migrations/physical.json is missing; run bolt build to derive verified definitions'
			);
		const physical = yield* readPhysicalDefinitions(yield* fs.readFileString(physicalFile)).pipe(
			Effect.mapError(fromStore)
		);
		if (
			Object.keys(physical).sort().join('\n') !==
			Object.keys(lock.physical ?? {})
				.sort()
				.join('\n')
		)
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				'physical.json does not cover exactly the verified migration prefixes'
			);
		for (const [name, lines] of Object.entries(physical))
			if (physicalHash(lines) !== lock.physical?.[name])
				return yield* BoltError.make(
					'migrationChanged',
					'admission',
					`${name || 'empty history'}: physical definitions differ from the verified lock`
				);
		return { files, squashes, snapshotText, snapshot, lock, physical } satisfies MigrationBundle;
	}))();

const AppliedRows = /*#__PURE__*/ (() => Schema.Array(AppliedRow))();
const Inspected = /*#__PURE__*/ (() => Schema.Array(IntrospectRow))();
const readState = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.readMigrationState')(function* (db: TenantDbShape) {
		const tracked =
			(yield* db.read([
				{ text: "select to_regclass('store_migration') is not null as tracked", params: [] }
			]))[0]?.rows[0]?.tracked === true;
		const statements: Sql[] = tracked
			? [
					{ text: APPLIED, params: [] },
					{ text: INTROSPECT, params: [] }
				]
			: [{ text: INTROSPECT, params: [] }];
		const results = yield* db.read(statements);
		const applied = yield* Schema.decodeUnknownEffect(AppliedRows)(
			tracked ? (results[0]?.rows ?? []) : []
		).pipe(
			Effect.mapError((cause) => BoltError.make('migrationInvalid', 'decode', cause.message, cause))
		);
		const inspected = yield* Schema.decodeUnknownEffect(Inspected)(
			results[tracked ? 1 : 0]?.rows ?? []
		).pipe(
			Effect.mapError((cause) => BoltError.make('migrationInvalid', 'decode', cause.message, cause))
		);
		return { applied, inspected };
	}))();
const liveStatus = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.liveMigrationStatus')(function* (db: TenantDbShape, bundle: MigrationBundle) {
		const { applied, inspected } = yield* readState(db);
		const expected = yield* migrationStatus(bundle.files, bundle.lock, applied, {
			snapshot: bundle.snapshotText,
			squashes: bundle.squashes
		}).pipe(Effect.mapError(fromStore));
		const last =
			[...expected.applied].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.name ?? '';
		const definitions = bundle.physical[last] ?? [];
		const sourceMinor = definitions.some((line) => line.startsWith('function bolt_minor_units '));
		const sourceNative = definitions.some((line) => line.startsWith('function bolt_audit '));
		const physical = migrationLines(inspected, sourceMinor, sourceNative);
		const status = yield* migrationStatus(bundle.files, bundle.lock, applied, {
			snapshot: bundle.snapshotText,
			squashes: bundle.squashes,
			physical
		}).pipe(Effect.mapError(fromStore));
		return { status, inspected };
	}))();
/** Read-only source/ledger/physical status. Application rechecks every observation with SQL guards under its lock. */
export const statusMigrations = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.statusMigrations')(function* (
		db: TenantDbShape,
		manifest: EngineManifest,
		bundle: MigrationBundle
	) {
		yield* current(bundle.snapshot, migrationSchema(manifest)).pipe(Effect.mapError(fromStore));
		return (yield* liveStatus(db, bundle)).status;
	}))();
const requirePhysical = (status: { readonly physical: string }) =>
	status.physical === 'current' || status.physical === 'prefix'
		? Effect.void
		: Effect.fail(
				BoltError.make(
					'migrationChanged',
					'admission',
					status.physical === 'unverified'
						? 'this history has no physical prefix proof; rebuild and commit migrations.lock.json'
						: 'the database differs from its verified migration prefix; inspect migration status and restore the declared schema before retrying (an untracked database requires an explicit data-preserving migration into a verified database)'
				)
			);
/** No JavaScript or external work runs under the lock: this guard compares exact definition sets in both directions. */
function guard(
	bundle: MigrationBundle,
	applied: readonly Applied[],
	stage: 'before' | 'after'
): Effect.Effect<Sql, BoltError> {
	const last = [...applied].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.name ?? '';
	const definitions = bundle.physical[last];
	if (definitions === undefined || physicalHash(definitions) !== bundle.lock.physical?.[last])
		return Effect.fail(
			BoltError.make(
				'migrationChanged',
				'admission',
				`${last || 'empty history'} has no verified physical definitions; rebuild migrations`
			)
		);
	const sourceMinor = definitions.some((line) => line.startsWith('function bolt_minor_units '));
	// Native source files own the audit functions and support definitions recorded in this exact prefix's proof.
	const sourceNative = definitions.some((line) => line.startsWith('function bolt_audit '));
	const owned = engineOwned(sourceNative);
	const excluded = owned.filter(
		([kind, owner]) => !(sourceMinor && kind === 'function' && owner === 'bolt_minor_units(c text)')
	);
	return Effect.succeed(migrationGuard(applied, definitions, stage, excluded));
}
/** Each file and its receipt use one immutable SQL batch, guarded under the same advisory lock before and after DDL. */
export const applyMigrations = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.applyMigrations')(function* (
		db: TenantDbShape,
		manifest: EngineManifest,
		bundle: MigrationBundle
	) {
		yield* current(bundle.snapshot, migrationSchema(manifest)).pipe(Effect.mapError(fromStore));
		yield* pending(bundle.files, bundle.lock, [], bundle.snapshotText, bundle.squashes).pipe(
			Effect.mapError(fromStore)
		);
		while (true) {
			const { status } = yield* liveStatus(db, bundle);
			yield* requirePhysical(status);
			const file = status.pending[0];
			const before = yield* guard(bundle, status.applied, 'before');
			const statements: Sql[] = [{ text: MIGRATIONS_TABLE, params: [] }, before];
			if (file !== undefined) {
				statements.push({ text: file.sql, params: [] }, recordApplied(file));
				statements.push(
					yield* guard(
						bundle,
						[...status.applied, { name: file.name, checksum: checksumOf(file) }],
						'after'
					)
				);
			} else {
				const slice = schemaSlice(manifest);
				for (const object of engineBeside(slice))
					for (const text of object.create) statements.push({ text, params: [] });
				statements.push({
					text: 'insert into bolt_schema (one, fingerprint, slice) values (true, $1, $2::jsonb) on conflict (one) do update set fingerprint = excluded.fingerprint, slice = excluded.slice, applied_at = now()',
					params: [fingerprint(slice), JSON.stringify(slice)]
				});
				// Reasserting host objects must not silently replace a definition owned by the verified source prefix.
				statements.push(yield* guard(bundle, status.applied, 'after'));
			}
			const applied = yield* db
				.transaction({ statements, lock: { advisory: ['bolt:schema'] } })
				.pipe(
					Effect.as(true),
					Effect.catchTag(
						'DbError',
						Effect.fn(function* (error: DbError): Effect.fn.Return<boolean, DbError | BoltError> {
							if (
								error.sqlstate === MIGRATION_GUARD_CODES.beforeLedger ||
								error.sqlstate === MIGRATION_GUARD_CODES.beforePhysical
							)
								return false;
							if (
								error.sqlstate === MIGRATION_GUARD_CODES.afterPhysical ||
								error.sqlstate === MIGRATION_GUARD_CODES.afterLedger
							)
								return yield* Effect.fail(
									BoltError.make(
										'migrationInvalid',
										'commit',
										'the migration did not reach its verified physical prefix; its SQL and ledger record were rolled back',
										error
									)
								);
							return yield* Effect.fail(error);
						})
					)
				);
			if (applied && file === undefined) return;
		}
	}))();
