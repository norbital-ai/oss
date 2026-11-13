// Hosts execute committed SQL. Store owns immutable histories, alternatives and their physical replay proofs.
import { Clock, Effect, FileSystem, Path, Schema } from 'effect';
import { literal } from '@norbital-ai/store';
import {
	APPLIED,
	AppliedRow,
	INTROSPECT,
	IntrospectRow,
	MIGRATIONS_TABLE,
	MIGRATION_GUARD_CODES,
	checksum_of,
	canonical,
	current,
	impact_count,
	migration_guard,
	migration_statements,
	migration_status,
	pending,
	read_lock,
	read_physical_definitions,
	read_snapshot,
	record_applied,
	sha256_hex,
	physical_hash,
	type Applied,
	type MigrationFile,
	MigrationLock,
	type SchemaObject,
	SchemaSpec
} from '@norbital-ai/store';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Rows, Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { DbError } from '../errors.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { audit_triggers } from './audit.ts';
import { engineOwned, engineOwns, source_objects } from './engine.ts';
import { history_schema_objects } from './history.ts';
import { engineBeside, fingerprint, readAppliedRecord, schema_slice, type AppliedSchemaRecord, type SchemaSlice } from './plan.ts';
import { impact_text, type MigrationImpact } from '../../protocol/migration-impact.ts';

const MigrationFileSchema = Schema.Struct({ name: Schema.String, sql: Schema.String });
export const MigrationBundleSchema = Schema.Struct({
	files: Schema.Array(MigrationFileSchema),
	squashes: Schema.Array(MigrationFileSchema),
	snapshotText: Schema.String,
	snapshot: SchemaSpec,
	lock: MigrationLock,
	physical: Schema.Record(Schema.String, Schema.Array(Schema.String))
});
export type MigrationBundle = typeof MigrationBundleSchema.Type;
const invalidMigration = (message: string) => BoltError.make('migration_invalid', 'admission', message);
const changedMigration = (message: string) => BoltError.make('migration_changed', 'admission', message);
/** The verified native record must still be the record this transaction is adopting. */
function appliedGuard(held: AppliedSchemaRecord | null): Sql {
	const expected = held === null ? [] : [{ fingerprint: held.fingerprint, slice: held.original }];
	const body = `declare actual jsonb := '[]'::jsonb; begin
		if to_regclass('bolt_schema') is not null then
			select coalesce(jsonb_agg(jsonb_build_object('fingerprint', fingerprint, 'slice', slice)), '[]'::jsonb)
			into actual from bolt_schema;
		end if;
		if actual is distinct from ${literal(JSON.stringify(expected))}::jsonb then
			raise exception using errcode = '${MIGRATION_GUARD_CODES.beforePhysical}', message = 'the preserved applied schema moved';
		end if;
	end`;
	return { text: `do ${literal(body)}`, params: [] };
}
export const migration_schema = (next: EngineManifest | SchemaSlice): SchemaSpec => {
	const { tables, tz, currency } = 'workspace' in next ? schema_slice(next) : next;
	return { tables, tz, currency };
};

/** What a generated migration keeps beside a schema's tables: these exact native triggers are source definitions. */
export const migration_objects = (schema: SchemaSpec): Effect.Effect<readonly SchemaObject[], BoltError> =>
	Object.values(schema.tables).some(
		(table) => table.audit === true || table.fields['revision']?.kind === 'int'
	)
		? Effect.map(history_schema_objects(schema.tables, schema.currency), (history) => [
				...source_objects(),
				...history,
				...audit_triggers(schema.tables)
			])
		: Effect.succeed([]);

/** Exact engine registry exclusions; an unexpected user object is never hidden by a name prefix. */
export const migration_lines = (
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
export const read_migration_sources = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.readMigrationSources')(function* (directory: string, lock?: MigrationLock) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const originals = new Map<string, MigrationFile>();
		const add = Effect.fn('Bolt.readMigrationSource')(function* (file: MigrationFile) {
			const existing = originals.get(file.name);
			if (existing !== undefined && existing.sql !== file.sql)
				return yield* changedMigration(`${file.name} differs from its retained archive; archived SQL never changes`);
			originals.set(file.name, file);
		});
		if (yield* fs.exists(directory))
			for (const name of (yield* fs.readDirectory(directory)).sort())
				if (name.endsWith('.sql'))
					yield* add({ name, sql: yield* fs.readFileString(path.join(directory, name)) });
		const squashes: MigrationFile[] = [];
		for (const receipt of lock?.squashes ?? []) {
			if (!/^[a-f0-9]{64}$/.test(receipt.archive) || !/^\d{4}_[a-z0-9_]+\.sql$/.test(receipt.file))
				return yield* invalidMigration('a squash receipt has an invalid archive or filename');
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
				return yield* changedMigration(`${receipt.file}: the retained archive is incomplete or contains unknown SQL`);
			for (const saved of receipt.replaces) {
				if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(saved.name))
					return yield* invalidMigration('an archive receipt has an invalid filename');
				const file = {
					name: saved.name,
					sql: yield* fs.readFileString(path.join(archive, saved.name))
				};
				if (checksum_of(file) !== saved.checksum)
					return yield* changedMigration(`${saved.name}: archived SQL changed`);
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

export const read_migrations = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.read_migrations')(function* (directory: string) {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		if (!(yield* fs.exists(directory)))
			return yield* invalidMigration('migrations/ is missing; run bolt build and commit it');
		const snapshotText = yield* fs.readFileString(path.join(directory, 'snapshot.json'));
		const lock = yield* read_lock(
			yield* fs.readFileString(path.join(directory, 'migrations.lock.json'))
		).pipe(Effect.mapError(from_store));
		const { files, squashes } = yield* read_migration_sources(directory, lock);
		if (files.length === 0)
			return yield* invalidMigration('migrations/ holds no SQL history; run bolt build');
		if (lock.snapshot !== sha256_hex(snapshotText))
			return yield* changedMigration('migrations/snapshot.json changed since verification; run bolt build');
		const snapshot = (yield* read_snapshot(snapshotText).pipe(Effect.mapError(from_store))).schema;
		yield* pending(files, lock, [], snapshotText, squashes).pipe(Effect.mapError(from_store));
		const physicalFile = path.join(directory, 'physical.json');
		if (!(yield* fs.exists(physicalFile)))
			return yield* changedMigration('migrations/physical.json is missing; run bolt build to derive verified definitions');
		const physical = yield* read_physical_definitions(yield* fs.readFileString(physicalFile)).pipe(
			Effect.mapError(from_store)
		);
		if (
			Object.keys(physical).sort().join('\n') !==
			Object.keys(lock.physical ?? {})
				.sort()
				.join('\n')
		)
			return yield* changedMigration('physical.json does not cover exactly the verified migration prefixes');
		for (const [name, lines] of Object.entries(physical))
			if (physical_hash(lines) !== lock.physical?.[name])
				return yield* changedMigration(`${name || 'empty history'}: physical definitions differ from the verified lock`);
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
			Effect.mapError((cause) => BoltError.make('migration_invalid', 'decode', cause.message, cause))
		);
		const inspected = yield* Schema.decodeUnknownEffect(Inspected)(
			results[tracked ? 1 : 0]?.rows ?? []
		).pipe(
			Effect.mapError((cause) => BoltError.make('migration_invalid', 'decode', cause.message, cause))
		);
		return { applied, inspected };
	}))();
const liveStatus = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.liveMigrationStatus')(function* (db: TenantDbShape, bundle: MigrationBundle) {
		const { applied, inspected } = yield* readState(db);
		const expected = yield* migration_status(bundle.files, bundle.lock, applied, {
			snapshot: bundle.snapshotText,
			squashes: bundle.squashes
		}).pipe(Effect.mapError(from_store));
		const last =
			[...expected.applied].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.name ?? '';
		const definitions = bundle.physical[last] ?? [];
		const sourceMinor = definitions.some((line) => line.startsWith('function bolt_minor_units '));
		const sourceNative = definitions.some((line) => line.startsWith('function bolt_audit '));
		const physical = migration_lines(inspected, sourceMinor, sourceNative);
		const status = yield* migration_status(bundle.files, bundle.lock, applied, {
			snapshot: bundle.snapshotText,
			squashes: bundle.squashes,
			physical
		}).pipe(Effect.mapError(from_store));
		return { status, inspected };
	}))();
const requirePhysical = (status: { readonly physical: string }) =>
	status.physical === 'current' || status.physical === 'prefix'
		? Effect.void
		: Effect.fail(
				changedMigration(
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
	if (definitions === undefined || physical_hash(definitions) !== bundle.lock.physical?.[last])
		return Effect.fail(
			changedMigration(`${last || 'empty history'} has no verified physical definitions; rebuild migrations`)
		);
	const sourceMinor = definitions.some((line) => line.startsWith('function bolt_minor_units '));
	// Native source files own the audit functions and support definitions recorded in this exact prefix's proof.
	const sourceNative = definitions.some((line) => line.startsWith('function bolt_audit '));
	const owned = engineOwned(sourceNative);
	const excluded = owned.filter(
		([kind, owner]) => !(sourceMinor && kind === 'function' && owner === 'bolt_minor_units(c text)')
	);
	return Effect.succeed(migration_guard(applied, definitions, stage, excluded));
}
/** The rows a step's count answers: what a destructive drop discards, or every row a backfill fills or a check reads. */
const countedBy = (id: string, hazard: string): readonly [string, string?] | undefined => {
	const object = id.slice(id.lastIndexOf(':') + 1),
		dot = object.indexOf('.'),
		table = dot < 0 ? object : object.slice(0, dot);
	if (hazard === 'destructive' && id.includes(':column:') && dot > 0)
		return [table, object.slice(dot + 1)];
	if (hazard === 'destructive' || hazard === 'backfill' || hazard === 'validating') return [table];
	return undefined;
};
type Measured = {
	readonly id: string;
	readonly hazard: string;
	count?: number;
	written?: number;
};
/**
 * Each file and its receipt use one immutable SQL batch, guarded under the same advisory lock before and after DDL.
 * Answers what it did: each step's rows (counted before the step, in the same transaction) and the whole duration.
 */
export const apply_migrations = /*#__PURE__*/ (() =>
	Effect.fn('Bolt.apply_migrations')(function* (
		db: TenantDbShape,
		next: EngineManifest | SchemaSlice,
		bundle: MigrationBundle
	) {
		yield* current(bundle.snapshot, migration_schema(next)).pipe(Effect.mapError(from_store));
		yield* pending(bundle.files, bundle.lock, [], bundle.snapshotText, bundle.squashes).pipe(
			Effect.mapError(from_store)
		);
		const started = yield* Clock.currentTimeMillis;
		const report: MigrationImpact['steps'][number][] = [];
		while (true) {
			const { status } = yield* liveStatus(db, bundle);
			yield* requirePhysical(status);
			const file = status.pending[0];
			const before = yield* guard(bundle, status.applied, 'before');
			const statements: Sql[] = [{ text: MIGRATIONS_TABLE, params: [] }, before];
			const steps = new Map<string, Measured>();
			const reads: { readonly at: number; readonly step: Measured; readonly count: boolean }[] = [];
			if (file !== undefined) {
				for (const statement of migration_statements(file)) {
					let step = steps.get(statement.step);
					if (step === undefined) {
						step = { id: statement.step, hazard: statement.hazard };
						steps.set(statement.step, step);
						const counted = countedBy(statement.step, statement.hazard);
						if (counted !== undefined) {
							for (const text of impact_count(...counted)) statements.push({ text, params: [] });
							reads.push({ at: statements.length - 1, step, count: true });
						}
					}
					statements.push({ text: statement.text, params: [] });
					if (statement.writes) reads.push({ at: statements.length - 1, step, count: false });
				}
				statements.push(record_applied(file));
				statements.push(
					yield* guard(
						bundle,
						[...status.applied, { name: file.name, checksum: checksum_of(file) }],
						'after'
					)
				);
			} else {
				const held = yield* readAppliedRecord(db);
				const slice = 'workspace' in next ? schema_slice(next) : next;
				const encoded = canonical(slice);
				const target = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(encoded).pipe(
					Effect.mapError((error) => BoltError.make('schema', 'decode', error.message, error))
				);
				for (const object of yield* engineBeside(slice))
					for (const text of object.create) statements.push({ text, params: [] });
				statements.push(appliedGuard(held));
				statements.push({
					text: `insert into bolt_schema (one, fingerprint, slice) values (true, $1, $2::jsonb) on conflict (one) ${held === null
						? 'do nothing'
						: 'do update set fingerprint = excluded.fingerprint, slice = excluded.slice, applied_at = now() where bolt_schema.fingerprint = $3 and bolt_schema.slice = $4::jsonb'}`,
					params: held === null
						? [fingerprint(slice), encoded]
						: [fingerprint(slice), encoded, held.fingerprint, JSON.stringify(held.original)]
				});
				statements.push(appliedGuard({ fingerprint: fingerprint(slice), original: target }));
				// Reasserting host objects must not silently replace a definition owned by the verified source prefix.
				statements.push(yield* guard(bundle, status.applied, 'after'));
			}
			const results = yield* db
				.transaction({ statements, lock: { advisory: ['bolt:schema'] } })
				.pipe(
					Effect.map((rows): readonly Rows[] | null => rows),
					Effect.catchTag(
						'DbError',
						Effect.fn(function* (
							error: DbError
						): Effect.fn.Return<readonly Rows[] | null, DbError | BoltError> {
							if (
								error.sqlstate === MIGRATION_GUARD_CODES.beforeLedger ||
								error.sqlstate === MIGRATION_GUARD_CODES.beforePhysical
							)
								return null;
							if (
								error.sqlstate === MIGRATION_GUARD_CODES.afterPhysical ||
								error.sqlstate === MIGRATION_GUARD_CODES.afterLedger
							)
								return yield* Effect.fail(
									BoltError.make(
										'migration_invalid',
										'commit',
										'the migration did not reach its verified physical prefix; its SQL and ledger record were rolled back',
										error
									)
								);
							return yield* Effect.fail(error);
						})
					)
				);
			if (results === null) continue;
			for (const { at, step, count } of reads) {
				const n = Number(count ? results[at]?.rows[0]?.n : results[at]?.affected);
				if (count) step.count = n;
				else step.written = (step.written ?? 0) + n;
			}
			for (const { id, hazard, count, written } of steps.values()) {
				// a drop reports what it discards; any other step what it wrote, else what its count read
				const rows = (hazard === 'destructive' ? (count ?? written) : (written ?? count)) ?? 0;
				report.push({ id, hazard, rows, summary: impact_text({ id, hazard, rows }) });
			}
			if (file === undefined)
				return {
					duration_ms: (yield* Clock.currentTimeMillis) - started,
					steps: report
				} satisfies MigrationImpact;
		}
	}))();
