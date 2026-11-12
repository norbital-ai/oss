// Synthetic schemas use the compiler's SQL generation and replay proofs, then the host's migration executor.
import { Effect, FileSystem, Schema } from 'effect';
import { join } from 'node:path';
import {
	canonical,
	checksum_of,
	sha256_hex,
	APPLIED,
	AppliedRow,
	type Applied
} from '@norbital-ai/store';
import {
	apply_migrations,
	read_applied,
	MigrationBundleSchema,
	read_migrations,
	BoltError,
	type EngineManifest,
	type MigrationBundle,
	type TenantDbShape
} from '@norbital-ai/bolt/engine';
import { schema_slice, type SchemaSlice } from '@norbital-ai/bolt/tooling';
import { prepare_migrations } from '../compiler/migrations.ts';
import { CHECKPOINTS, inputs, keep } from './checkpoint.ts';

export type MigrationOptions = { readonly accept?: true | readonly string[] };
const decode = (text: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(MigrationBundleSchema))(text).pipe(
		Effect.mapError((cause) => BoltError.make('migration_changed', 'decode', cause.message, cause))
	);
const directory = join(CHECKPOINTS, 'migrations');
const ledgerKey = (files: readonly Applied[]) => sha256_hex(canonical(files));
export const rememberMigrations = (
	bundle: MigrationBundle,
	ledger: readonly Applied[] = bundle.files.map((file) => ({
		name: file.name,
		checksum: checksum_of(file)
	}))
) => keep(join(directory, `${ledgerKey(ledger)}.json`), JSON.stringify(bundle));
const read = (file: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return (yield* fs.exists(file))
			? yield* fs.readFileString(file).pipe(Effect.flatMap(decode))
			: undefined;
	});

/** Retained SQL histories are immutable and indexed by the exact ledger they produced. */
export const generatedMigrations = Effect.fn('TestDb.generatedMigrations')(function* (
	next: EngineManifest | SchemaSlice,
	previous?: MigrationBundle,
	options: MigrationOptions = {}
) {
	const slice = 'workspace' in next ? schema_slice(next) : next;
	const key = sha256_hex(
		canonical([yield* inputs.image, previous?.lock ?? null, slice, options.accept ?? []])
	);
	const file = join(directory, `generated-${key}.json`);
	const cached = yield* read(file);
	if (cached !== undefined) {
		yield* rememberMigrations(cached);
		return cached;
	}
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-test-migrations-' });
			const migrations = join(root, 'migrations');
			if (previous !== undefined) {
				yield* fs.makeDirectory(migrations);
				for (const file of previous.files)
					yield* fs.writeFileString(join(migrations, file.name), file.sql);
				for (const receipt of previous.lock.squashes ?? []) {
					const archive = join(migrations, 'archive', receipt.archive);
					yield* fs.makeDirectory(archive, { recursive: true });
					for (const saved of receipt.replaces) {
						const file = previous.files.find((file) => file.name === saved.name);
						if (file === undefined)
							return yield* BoltError.make(
								'migration_changed',
								'decode',
								'The retained migration archive is incomplete.'
							);
						yield* fs.writeFileString(join(archive, file.name), file.sql);
					}
					const squash = previous.squashes.find((file) => file.name === receipt.file);
					if (squash === undefined)
						return yield* BoltError.make(
							'migration_changed',
							'decode',
							'The retained squash source is missing.'
						);
					yield* fs.makeDirectory(join(migrations, 'squashes'), { recursive: true });
					yield* fs.writeFileString(join(migrations, 'squashes', squash.name), squash.sql);
				}
				yield* fs.writeFileString(join(migrations, 'snapshot.json'), previous.snapshotText);
				yield* fs.writeFileString(
					join(migrations, 'migrations.lock.json'),
					JSON.stringify(previous.lock)
				);
				yield* fs.writeFileString(
					join(migrations, 'physical.json'),
					JSON.stringify(previous.physical)
				);
			}
			yield* prepare_migrations(root, slice, 'generate', options);
			const bundle = yield* read_migrations(migrations);
			yield* rememberMigrations(bundle);
			yield* keep(file, JSON.stringify(bundle));
			return bundle;
		})
	);
});

/** Prepare a verified source history against the database's exact applied prefix. */
export const prepareTestMigrations = Effect.fn('TestDb.prepare_migrations')(function* (
	db: TenantDbShape,
	next: EngineManifest | SchemaSlice,
	options: MigrationOptions = {}
) {
	const previous = yield* read_applied(db);
	let source: MigrationBundle | undefined;
	if (previous !== null) {
		const tracked = yield* db.value(Schema.Boolean, {
			text: "SELECT to_regclass('store_migration') IS NOT NULL",
			params: []
		});
		if (!tracked)
			return yield* BoltError.make(
				'migration_changed',
				'admission',
				'The test database has no SQL migration history.'
			);
		const ledger = yield* db.rows(AppliedRow, { text: APPLIED, params: [] });
		source = yield* read(join(directory, `${ledgerKey(ledger)}.json`));
		if (source === undefined) {
			const baseline = yield* generatedMigrations(previous.schema, undefined, { accept: true });
			if (
				ledgerKey(
					baseline.files.map((file) => ({ name: file.name, checksum: checksum_of(file) }))
				) !== ledgerKey(ledger)
			)
				return yield* BoltError.make(
					'migration_changed',
					'admission',
					'The test database migration sources are missing.'
				);
			source = baseline;
		}
	}
	const bundle = yield* generatedMigrations(next, source, options);
	return bundle;
});

/** A test transition executes the same verified SQL files as a host. */
export const migrate = Effect.fn('TestDb.migrate')(function* (
	db: TenantDbShape,
	next: EngineManifest | SchemaSlice,
	options: MigrationOptions = {}
) {
	const bundle = yield* prepareTestMigrations(db, next, options);
	const impact = yield* apply_migrations(db, next, bundle);
	yield* rememberMigrations(bundle, yield* db.rows(AppliedRow, { text: APPLIED, params: [] }));
	return impact;
});
