// Editable committed SQL: replay originals, alternatives and the declared schema before issuing a release lock.
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import {
	INTROSPECT,
	IntrospectRow,
	archiveOf,
	build,
	canonical,
	checkFile,
	checkSquashSources,
	checksumOf,
	generate,
	generateSquash,
	pending,
	physicalHash,
	physicalDefinitionsOf,
	q,
	readLock,
	readPhysicalDefinitions,
	readSnapshot,
	sha256Hex,
	verify,
	verifySquash,
	type MigrationLock,
	type MigrationFile,
	type PhysicalDefinitions,
	type SchemaObject,
	type SchemaSpec,
	type SquashReceipt
} from '@norbital-ai/store';
import type { EngineManifest } from '../engine/manifest.ts';
import {
	migrationLines,
	migrationSchema,
	readMigrationSources
} from '../engine/schema/migrations.ts';
import { managedTables } from '../engine/schema/plan.ts';
import { sourceObjects } from '../engine/schema/engine.ts';
import { auditTriggers } from '../engine/schema/audit.ts';
import { PgliteDb, Pristine } from '../node/db/pglite.ts';
import { BoltError, fromStore } from '../protocol/errors.ts';

/** These exact native triggers are source definitions, including every historical prefix's own arguments. */
const auditSource = (schema: SchemaSpec): readonly SchemaObject[] =>
	Object.values(schema.tables).some(
		(table) => table.nativeRules !== undefined && table.audit === true
	)
		? [...sourceObjects(), ...auditTriggers(schema.tables)]
		: [];

/** Generation leaves editable SQL on a failed proof, but never replaces a verified lock with an unproved history. */
export const prepareMigrations = Effect.fn('Bolt.prepareMigrations')(function* (
	root: string,
	manifest: EngineManifest,
	mode: 'generate' | 'verify',
	options: { readonly squash?: string } = {}
) {
	if (mode !== 'generate' && options.squash !== undefined)
		return yield* BoltError.make(
			'migrationInvalid',
			'admission',
			'squash generation requires bolt build --squash=<name>'
		);
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(root, 'migrations');
	if (mode === 'verify' && !(yield* fs.exists(directory))) return;
	const lockFile = path.join(directory, 'migrations.lock.json');
	const physicalFile = path.join(directory, 'physical.json');
	const physicalText = (yield* fs.exists(physicalFile))
		? yield* fs.readFileString(physicalFile)
		: undefined;
	const oldLock: MigrationLock | undefined = (yield* fs.exists(lockFile))
		? yield* readLock(yield* fs.readFileString(lockFile)).pipe(Effect.mapError(fromStore))
		: undefined;
	const { files, squashes } = yield* readMigrationSources(directory, oldLock);
	const snapshotFile = path.join(directory, 'snapshot.json');
	let snapshotText = (yield* fs.exists(snapshotFile))
		? yield* fs.readFileString(snapshotFile)
		: undefined;
	const previous =
		snapshotText === undefined
			? null
			: yield* readSnapshot(snapshotText).pipe(Effect.mapError(fromStore));
	const next = migrationSchema(manifest);
	if (mode === 'generate' && (previous === null || canonical(previous) !== canonical(next))) {
		if (previous === null && files.length > 0)
			return yield* BoltError.make(
				'migrationInvalid',
				'admission',
				'migrations/snapshot.json is missing beside existing files'
			);
		// Old Bolt snapshots encoded writer-owned delete behavior in audit; preserve their original bytes and identity.
		const before =
			previous === null ? null : { ...previous, tables: managedTables(previous.tables) };
		const generated = yield* generate(
			before,
			next,
			{
				number: files.length + 1,
				name: files.length === 0 ? 'initial' : 'schema'
			},
			auditSource
		).pipe(Effect.mapError(fromStore));
		yield* fs.makeDirectory(directory, { recursive: true });
		const file = path.join(directory, generated.file.name);
		if (yield* fs.exists(file))
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				`${generated.file.name} already exists; existing migrations are never overwritten`
			);
		yield* fs.writeFileString(file, generated.file.sql);
		yield* fs.writeFileString(snapshotFile, generated.snapshot);
		files.push(generated.file);
		snapshotText = generated.snapshot;
	}
	if (snapshotText === undefined)
		return yield* BoltError.make(
			'migrationInvalid',
			'admission',
			'migrations/snapshot.json is missing; run bolt build'
		);
	const snapshot = snapshotText;
	let heldPhysical: PhysicalDefinitions | undefined;
	if (mode === 'verify') {
		if (oldLock === undefined || oldLock.physical === undefined || physicalText === undefined)
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				'migrations need physical replay verification; run bolt build'
			);
		yield* pending(files, oldLock, [], snapshot, squashes).pipe(Effect.mapError(fromStore));
		heldPhysical = yield* readPhysicalDefinitions(physicalText).pipe(Effect.mapError(fromStore));
	}
	const declared = yield* build(next).pipe(Effect.mapError(fromStore));
	const native = auditSource(next);
	const key = sha256Hex(
		canonical({
			proofVersion: 7,
			snapshot,
			files,
			squashes,
			next,
			declared,
			native,
			lock: oldLock,
			physicalText
		})
	);
	const cache = path.join(root, '.norbital', 'cache', 'migrations.sha256');
	if (mode === 'verify' && (yield* fs.exists(cache)) && (yield* fs.readFileString(cache)) === key)
		return;
	yield* Effect.forEach(files, checkFile).pipe(Effect.mapError(fromStore));
	const proof = yield* Effect.scoped(
		Effect.gen(function* () {
			const replayDb = PgliteDb.make(yield* PgliteDb.open());
			const declaredDb = PgliteDb.make(yield* PgliteDb.open());
			const inspect = { text: INTROSPECT, params: [] };
			const physical: Record<string, string> = {};
			const definitions: Record<string, readonly string[]> = {};
			const prefixes = new Map<number, readonly string[]>();
			const empty = migrationLines(yield* replayDb.rows(IntrospectRow, inspect), true, true);
			prefixes.set(0, empty);
			physical[''] = physicalHash(empty);
			definitions[''] = empty;
			for (const [index, file] of files.entries()) {
				yield* replayDb.write({ text: file.sql, params: [] });
				const lines = migrationLines(yield* replayDb.rows(IntrospectRow, inspect), true, true);
				prefixes.set(index + 1, lines);
				physical[file.name] = physicalHash(lines);
				definitions[file.name] = lines;
			}
			for (const text of declared) yield* declaredDb.write({ text, params: [] });
			for (const object of native)
				for (const text of object.create) yield* declaredDb.write({ text, params: [] });
			const actual = migrationLines(yield* replayDb.rows(IntrospectRow, inspect), true, true);
			const expected = migrationLines(yield* declaredDb.rows(IntrospectRow, inspect), true, true);
			const receipts: SquashReceipt[] = [];
			for (const receipt of oldLock?.squashes ?? []) {
				const file = squashes.find((file) => file.name === receipt.file);
				if (file === undefined)
					return yield* BoltError.make(
						'migrationChanged',
						'admission',
						`${receipt.file} is missing`
					);
				const baseline = PgliteDb.make(yield* PgliteDb.open());
				yield* baseline.write({ text: file.sql, params: [] });
				const lines = migrationLines(yield* baseline.rows(IntrospectRow, inspect), true, true);
				const verified = yield* verifySquash(
					files.slice(0, receipt.replaces.length),
					file,
					prefixes.get(receipt.replaces.length) ?? [],
					lines
				).pipe(Effect.mapError(fromStore));
				if (canonical(verified) !== canonical(receipt))
					return yield* BoltError.make(
						'migrationChanged',
						'admission',
						`${receipt.file}: a retained squash receipt changed; create a new squash instead`
					);
				receipts.push(verified);
				physical[file.name] = verified.proof;
				definitions[file.name] = lines;
			}
			let archived: SquashReceipt | undefined;
			if (options.squash !== undefined) {
				const prefix: MigrationFile[] = [];
				for (const file of files) {
					const checked = yield* Effect.result(checkSquashSources([...prefix, file]));
					if (Result.isFailure(checked)) {
						if (prefix.length === 0) return yield* fromStore(checked.failure);
						break;
					}
					prefix.push(file);
				}
				const complete = prefix.length === files.length;
				if (complete)
					for (const table of Object.keys(next.tables)) {
						const populated = yield* replayDb.value(Schema.Boolean, {
							text: `select exists(select 1 from ${q(table)} limit 1)`,
							params: []
						});
						if (populated)
							return yield* BoltError.make(
								'migrationInvalid',
								'admission',
								'a squash cannot replace history that creates rows; schema equality does not prove data equivalence'
							);
					}
				const slug = `squash_${options.squash}_${archiveOf(prefix).slice(0, 12)}`
					.replace(/[^a-z0-9]+/gi, '_')
					.replace(/^_+|_+$/g, '')
					.toLowerCase();
				// A procedural/data suffix stays byte-for-byte. Replay the DDL prefix to preserve its historical definitions.
				const proposed: MigrationFile = complete
					? (yield* generateSquash(prefix, next, { name: options.squash }, auditSource).pipe(
							Effect.mapError(fromStore)
						)).file
					: {
							name: `${String(prefix.length).padStart(4, '0')}_${slug}.sql`,
							sql: `-- Verified replay of ${prefix.length} immutable schema migration files.\n\n${prefix.map((file) => file.sql).join('\n\n')}`
						};
				const destination = path.join(directory, 'squashes', proposed.name);
				yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
				const file = (yield* fs.exists(destination))
					? { name: proposed.name, sql: yield* fs.readFileString(destination) }
					: proposed;
				if (!(yield* fs.exists(destination))) yield* fs.writeFileString(destination, file.sql);
				const baseline = PgliteDb.make(yield* PgliteDb.open());
				yield* baseline.write({ text: file.sql, params: [] });
				const lines = migrationLines(yield* baseline.rows(IntrospectRow, inspect), true, true);
				archived = yield* verifySquash(prefix, file, prefixes.get(prefix.length) ?? [], lines).pipe(
					Effect.mapError(fromStore)
				);
				definitions[file.name] = lines;
				const existing = receipts.find((receipt) => receipt.file === archived?.file);
				if (existing !== undefined && canonical(existing) !== canonical(archived))
					return yield* BoltError.make(
						'migrationChanged',
						'admission',
						`${file.name}: a retained squash never changes`
					);
				if (existing === undefined) receipts.push(archived);
				physical[file.name] = archived.proof;
			}
			const lock = yield* verify(files, snapshot, next, actual, expected, {
				physical,
				...(receipts.length === 0 ? {} : { squashes: receipts })
			}).pipe(Effect.mapError(fromStore));
			return { lock, archived, definitions };
		}).pipe(Effect.provide(Pristine.layer))
	);
	if (
		mode === 'verify' &&
		canonical(yield* readLock(proof.lock).pipe(Effect.mapError(fromStore))) !== canonical(oldLock)
	)
		return yield* BoltError.make(
			'migrationChanged',
			'admission',
			'migration replay proofs changed; run bolt build and review migrations.lock.json'
		);
	if (mode === 'verify') {
		if (canonical(heldPhysical) !== canonical(proof.definitions))
			return yield* BoltError.make(
				'migrationChanged',
				'admission',
				'migration physical definitions changed; run bolt build and review physical.json'
			);
	}
	if (mode === 'generate') {
		if (proof.archived !== undefined) {
			const archive = path.join(directory, 'archive', proof.archived.archive);
			yield* fs.makeDirectory(archive, { recursive: true });
			for (const file of files.slice(0, proof.archived.replaces.length)) {
				const destination = path.join(archive, file.name);
				if (yield* fs.exists(destination)) {
					if (sha256Hex(yield* fs.readFileString(destination)) !== checksumOf(file))
						return yield* BoltError.make(
							'migrationChanged',
							'admission',
							`${file.name}: an existing archive never changes`
						);
				} else yield* fs.writeFileString(destination, file.sql);
			}
		}
		yield* fs.writeFileString(physicalFile, physicalDefinitionsOf(proof.definitions));
		yield* fs.writeFileString(lockFile, proof.lock);
		// Only remove redundant source copies once immutable archived bytes and their verified receipt are durable.
		if (proof.archived !== undefined)
			for (const file of files.slice(0, proof.archived.replaces.length)) {
				const source = path.join(directory, file.name);
				if (yield* fs.exists(source)) {
					if (sha256Hex(yield* fs.readFileString(source)) !== checksumOf(file))
						return yield* BoltError.make(
							'migrationChanged',
							'admission',
							`${file.name} changed during squash; its source copy was preserved`
						);
					yield* fs.remove(source);
				}
			}
	}
	yield* fs.makeDirectory(path.dirname(cache), { recursive: true });
	yield* fs.writeFileString(cache, key);
});
