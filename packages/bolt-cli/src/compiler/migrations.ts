// Editable committed SQL: replay originals, alternatives and the declared schema before issuing a release lock.
import { Effect, FileSystem, Path, Result, Schema } from 'effect';
import {
	INTROSPECT,
	IntrospectRow,
	archive_of,
	build,
	canonical,
	check_file,
	check_squash_sources,
	checksum_of,
	executable,
	generate,
	generate_squash,
	pending,
	physical_hash,
	physical_definitions_of,
	q,
	read_lock,
	read_physical_definitions,
	read_snapshot,
	sha256_hex,
	verify,
	verify_squash,
	type MigrationLock,
	type MigrationFile,
	type PhysicalDefinitions,
	type SchemaSpec,
	type SquashReceipt
} from '@norbital-ai/store';
import type { EngineManifest } from '@norbital-ai/bolt/engine';
import type { SchemaSlice } from '@norbital-ai/bolt/tooling';
import {
	migration_lines,
	read_migration_sources,
	history_schema_objects,
	from_store
} from '@norbital-ai/bolt/tooling';
import { PgliteDb, Pristine } from '@norbital-ai/bolt/node';
import { migration_objects, migration_schema, BoltError } from '@norbital-ai/bolt/engine';

/** `function <name> <definition>` lines by name: what a body comparison reads off an introspection. */
const functionLines = (lines: readonly string[]): ReadonlyMap<string, string> =>
	new Map(
		[
			...Map.groupBy(
				lines.filter((line) => line.startsWith('function ')),
				(line) => line.split(' ', 2)[1] ?? ''
			)
		].map(([name, defs]) => [name, canonical([...defs].sort())])
	);
/**
 * The declared statements re-creating each function whose declared body neither the verified history (`physical.json`
 * at its last file) nor this replay holds: an engine or store runtime body a Bolt release changed, which the schema
 * snapshot cannot see. An edited migration file differs from the held history instead, and stays refused.
 * ponytail: functions only; a changed native trigger or a removed function still fails the proof until handled here.
 */
const runtimeFunctions = (
	held: readonly string[],
	replayed: readonly string[],
	declared: readonly string[],
	statements: readonly string[]
): readonly string[] => {
	const [before, now] = [functionLines(held), functionLines(replayed)];
	const changed = [...functionLines(declared)]
		.filter(([name, defs]) => before.get(name) !== defs && now.get(name) !== defs)
		.map(([name]) => name);
	return statements.filter((text) =>
		changed.some((name) =>
			new RegExp(`create\\s+or\\s+replace\\s+function\\s+(public\\.)?"?${name}"?\\s*\\(`, 'i').test(
				text
			)
		)
	);
};

/**
 * The definitions a script leaves on a pristine database are a pure function of its text: cached by its hash.
 * ponytail: clears at 16 entries; a watch loop proves the same few schemas and squashes.
 */
const pristineDefinitions = new Map<string, readonly string[]>();
const definitionsOf = Effect.fn('Bolt.pristineDefinitions')(function* (script: string) {
	const key = sha256_hex(script);
	const held = pristineDefinitions.get(key);
	if (held !== undefined) return held;
	const lines = yield* Effect.scoped(
		Effect.gen(function* () {
			const db = PgliteDb.make(yield* PgliteDb.open());
			yield* db.write({ text: script, params: [] });
			return migration_lines(
				yield* db.rows(IntrospectRow, { text: INTROSPECT, params: [] }),
				true,
				true
			);
		})
	);
	if (pristineDefinitions.size >= 16) pristineDefinitions.clear();
	pristineDefinitions.set(key, lines);
	return lines;
});

/**
 * Replayed migration prefixes by content (`prefixKeys`): each prefix's introspected definitions, and the database after
 * the last prefix a proof replayed, so the next proof of the same history replays only the files after it.
 * ponytail: definitions clear at 256 entries, images keep the newest 4; a watch loop and a test file prove few histories.
 */
const prefixLines = new Map<string, readonly string[]>();
const prefixImages = new Map<string, Blob>();
const prefixKeys = (files: readonly MigrationFile[]): readonly string[] =>
	files.reduce<string[]>(
		(keys, file) => [...keys, sha256_hex(`${keys.at(-1)}\n${file.name}\n${checksum_of(file)}`)],
		[sha256_hex('')]
	);
const rememberLines = (key: string, lines: readonly string[]) => {
	if (prefixLines.size >= 256) prefixLines.clear();
	prefixLines.set(key, lines);
};

// Not in INTROSPECT: a live database's provider keeps schemas of its own, so only a replay can tell these apart.
const SchemaName = Schema.Struct({ name: Schema.String });
const OTHER_SCHEMAS = `select nspname as name from pg_namespace
	where nspname not like 'pg\\_%' and nspname not in ('information_schema', current_schema())`;

/** Generation writes its SQL, snapshot, proof and lock together, only once the whole history is proved and accepted. */
export const prepare_migrations = Effect.fn('Bolt.prepare_migrations')(function* (
	root: string,
	manifest: EngineManifest | SchemaSlice,
	mode: 'generate' | 'verify',
	options: { readonly squash?: string; readonly accept?: true | readonly string[] } = {}
) {
	if (mode !== 'generate' && options.squash !== undefined)
		return yield* BoltError.make(
			'migration_invalid',
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
		? yield* read_lock(yield* fs.readFileString(lockFile)).pipe(Effect.mapError(from_store))
		: undefined;
	const { files, squashes } = yield* read_migration_sources(directory, oldLock);
	const snapshotFile = path.join(directory, 'snapshot.json');
	// generated files: written with the proof and lock, never before them
	const generatedFiles: Array<readonly [string, string]> = [];
	let snapshotText = (yield* fs.exists(snapshotFile))
		? yield* fs.readFileString(snapshotFile)
		: undefined;
	if (snapshotText !== undefined && oldLock !== undefined && oldLock.snapshot !== sha256_hex(snapshotText))
		return yield* BoltError.make('migration_changed', 'admission', 'The original snapshot changed since verification; restore it before planning its successor.');
	const previous =
		snapshotText === undefined
			? null
			: yield* read_snapshot(snapshotText).pipe(Effect.mapError(from_store));
	const next = migration_schema(manifest);
	const declared = yield* build(next).pipe(Effect.mapError(from_store));
	const native = yield* migration_objects(next);
	const held =
		physicalText === undefined
			? undefined
			: yield* read_physical_definitions(physicalText).pipe(Effect.mapError(from_store));
	// a rebased history's own files have no proof yet: its last proved prefix is what it holds
	const heldLines = held?.[files.findLast((file) => held[file.name] !== undefined)?.name ?? ''];
	if (mode === 'generate' && (previous === null || canonical(previous.original) !== canonical(next))) {
		if (previous === null && files.length > 0)
			return yield* BoltError.make(
				'migration_invalid',
				'admission',
				'migrations/snapshot.json is missing beside existing files'
			);
		const generated = yield* generate(
			previous,
			next,
			{
				number: files.length + 1,
				name: files.length === 0 ? 'initial' : 'schema',
				...(options.accept !== undefined && options.accept !== true
					? { accept: options.accept }
					: {})
			},
			migration_objects
		).pipe(Effect.catchTag('StoreError', (e) => Effect.fail(from_store(e))));
		const prologue: string[] = [];
		if (previous !== null) {
			// Backfills must use the new runtime bodies: a function a Bolt release changed is re-created first.
			const expected = yield* definitionsOf(
				[...declared, ...native.flatMap((object) => object.create)]
					.map((sql) => `${sql.trim().replace(/;$/, '')};`)
					.join('\n')
			).pipe(Effect.provide(Pristine.layer));
			prologue.push(
				...runtimeFunctions(heldLines ?? [], heldLines ?? [], expected, [
					...declared,
					...native.flatMap((object) => object.create)
				])
			);
		}
		const upgraded = {
			...generated.file,
			sql: [
				prologue.length === 0 ? '' : `-- step runtime:functions (backfill)\n${prologue.map((sql) => `${sql};`).join('\n')}`,
				generated.file.sql
			].filter((block) => block.length > 0).join('\n\n')
		};
		// a Studio build runs on a copy of live's data, and its merge approval accepts these steps: a generated file a failed
		// build would discard could never carry its accept lines otherwise
		const accepted =
			options.accept === true || process.env['BOLT_ACCEPT_DESTRUCTIVE'] === '1'
				? upgraded.sql.replace(/^-- step (\S+) \(destructive\)\s*$/gm, '$&\n-- accept: $1')
				: upgraded.sql;
		const file = path.join(directory, upgraded.name);
		if (yield* fs.exists(file))
			return yield* BoltError.make(
				'migration_changed',
				'admission',
				`${generated.file.name} already exists; existing migrations are never overwritten`
			);
		generatedFiles.push([file, accepted], [snapshotFile, generated.snapshot]);
		files.push({ ...upgraded, sql: accepted });
		snapshotText = generated.snapshot;
	}
	if (snapshotText === undefined)
		return yield* BoltError.make(
			'migration_invalid',
			'admission',
			'migrations/snapshot.json is missing; run bolt build'
		);
	const snapshot = snapshotText;
	let heldPhysical: PhysicalDefinitions | undefined;
	if (mode === 'verify') {
		if (oldLock === undefined || oldLock.physical === undefined || physicalText === undefined)
			return yield* BoltError.make(
				'migration_changed',
				'admission',
				'migrations need physical replay verification; run bolt build'
			);
		yield* pending(files, oldLock, [], snapshot, squashes).pipe(Effect.mapError(from_store));
		heldPhysical = yield* read_physical_definitions(physicalText).pipe(Effect.mapError(from_store));
	}
	const key = sha256_hex(
		canonical({
			proofVersion: 8,
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
	// the same inputs as the last verified proof (either mode): its replay would answer the same physical definitions
	// and only over a lock that already holds this history: a build that wrote its proof elsewhere left this one stale
	const proved =
		oldLock !== undefined &&
		Result.isSuccess(yield* Effect.result(pending(files, oldLock, [], snapshot, squashes)));
	if (
		options.squash === undefined &&
		proved &&
		(yield* fs.exists(cache)) &&
		(yield* fs.readFileString(cache)) === key
	)
		return;
	yield* Effect.forEach(files, check_file).pipe(Effect.mapError(from_store));
	const proof = yield* Effect.scoped(
		Effect.gen(function* () {
			// resume from the longest replayed prefix of this history; every shorter prefix's definitions are remembered
			const keys = prefixKeys(files);
			let start = 0,
				remembered = 0;
			for (; remembered < keys.length && prefixLines.has(keys[remembered] ?? ''); remembered++)
				if (prefixImages.has(keys[remembered] ?? '')) start = remembered;
			// a history whose every prefix is remembered needs no replay: its database opens only for a write after it
			const all = remembered === keys.length;
			const history = files.slice(start);
			const replay = yield* Effect.cached(
				Effect.gen(function* () {
					const pg = yield* PgliteDb.open(prefixImages.get(keys[start] ?? ''));
					const db = PgliteDb.make(pg);
					if (all)
						for (const file of history) yield* db.write({ text: executable(file), params: [] });
					return { pg, db };
				})
			);
			const inspect = { text: INTROSPECT, params: [] };
			const physical: Record<string, string> = {};
			const definitions: Record<string, readonly string[]> = {};
			const prefixes = new Map<number, readonly string[]>();
			const record = (index: number, lines: readonly string[]) => {
				const name = index === 0 ? '' : (files[index - 1]?.name ?? '');
				prefixes.set(index, lines);
				physical[name] = physical_hash(lines);
				definitions[name] = lines;
				rememberLines(keys[index] ?? '', lines);
			};
			// read before recording: recording may clear the remembered definitions
			const held = (all ? keys : keys.slice(0, start + 1)).map((key) => prefixLines.get(key));
			for (const [index, lines] of held.entries())
				record(
					index,
					lines ??
						migration_lines(yield* (yield* replay).db.rows(IntrospectRow, inspect), true, true)
				);
			if (!all) {
				const { pg, db } = yield* replay;
				for (const [index, file] of history.entries()) {
					yield* db.write({ text: executable(file), params: [] });
					record(
						start + index + 1,
						migration_lines(yield* db.rows(IntrospectRow, inspect), true, true)
					);
				}
				const schemas = yield* db.rows(SchemaName, { text: OTHER_SCHEMAS, params: [] });
				if (schemas.length > 0)
					return yield* BoltError.make(
						'migration_invalid',
						'admission',
						`a migration may not create a schema: ${schemas.map((row) => row.name).join(', ')}`
					);
				const last = keys.at(-1) ?? '';
				prefixImages.delete(last);
				if (prefixImages.size >= 4) prefixImages.delete(prefixImages.keys().next().value ?? '');
				prefixImages.set(last, yield* PgliteDb.dump(pg));
			}
			// One script, not one transaction per statement: the declared schema is hundreds of statements.
			const expected = yield* definitionsOf(
				[...declared, ...native.flatMap((object) => object.create)]
					.map((text) => `${text.trim().replace(/;$/, '')};`)
					.join('\n')
			);
			let actual = prefixes.get(files.length) ?? [];
			const bodies = [
				...(heldLines !== undefined
					? runtimeFunctions(heldLines, actual, expected, [
							...declared,
							...native.flatMap((object) => object.create)
						])
					: [])
			];
			// a check passing here would cache this proof, and the next build would skip generating what the runtime needs
			if (mode === 'verify' && bodies.length > 0)
				return yield* BoltError.make(
					'migration_changed',
					'admission',
					'this Bolt release changed runtime functions the migrations do not hold yet; run bolt build to generate the next migration'
				);
			if (bodies.length > 0) {
				bodies.push(
					...(yield* history_schema_objects(next.tables, next.currency)).flatMap((object) => object.create)
				);
			}
			if (bodies.length > 0) {
				const name = `${String(files.length + 1).padStart(4, '0')}_runtime_functions.sql`;
				if (yield* fs.exists(path.join(directory, name)))
					return yield* BoltError.make(
						'migration_changed',
						'admission',
						`${name} already exists; existing migrations are never overwritten`
					);
				const file: MigrationFile = {
					name,
					sql: `-- ${name}: runtime function bodies this Bolt release changed.\n\n${bodies.map((text) => `${text.trim().replace(/;$/, '')};`).join('\n\n')}\n`
				};
				yield* check_file(file).pipe(Effect.mapError(from_store));
				generatedFiles.push([path.join(directory, name), file.sql]);
				files.push(file);
				const { db } = yield* replay;
				yield* db.write({ text: file.sql, params: [] });
				actual = migration_lines(yield* db.rows(IntrospectRow, inspect), true, true);
				prefixes.set(files.length, actual);
				physical[name] = physical_hash(actual);
				definitions[name] = actual;
			}
			const receipts: SquashReceipt[] = [];
			for (const receipt of oldLock?.squashes ?? []) {
				const file = squashes.find((file) => file.name === receipt.file);
				if (file === undefined)
					return yield* BoltError.make(
						'migration_changed',
						'admission',
						`${receipt.file} is missing`
					);
				const lines = yield* definitionsOf(file.sql);
				const verified = yield* verify_squash(
					files.slice(0, receipt.replaces.length),
					file,
					prefixes.get(receipt.replaces.length) ?? [],
					lines
				).pipe(Effect.mapError(from_store));
				if (canonical(verified) !== canonical(receipt))
					return yield* BoltError.make(
						'migration_changed',
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
					const checked = yield* Effect.result(check_squash_sources([...prefix, file]));
					if (Result.isFailure(checked)) {
						if (prefix.length === 0) return yield* from_store(checked.failure);
						break;
					}
					prefix.push(file);
				}
				const complete = prefix.length === files.length;
				const tables = Object.keys(next.tables);
				if (
					complete &&
					tables.length > 0 &&
					(yield* (yield* replay).db.value(Schema.Boolean, {
						text: `select ${tables.map((table) => `exists(select 1 from ${q(table)})`).join(' or ')}`,
						params: []
					}))
				)
					return yield* BoltError.make(
						'migration_invalid',
						'admission',
						'a squash cannot replace history that creates rows; schema equality does not prove data equivalence'
					);
				const slug = `squash_${options.squash}_${archive_of(prefix).slice(0, 12)}`
					.replace(/[^a-z0-9]+/gi, '_')
					.replace(/^_+|_+$/g, '')
					.toLowerCase();
				// A procedural/data suffix stays byte-for-byte. Replay the DDL prefix to preserve its historical definitions.
				const proposed: MigrationFile = complete
					? (yield* generate_squash(prefix, next, { name: options.squash }, migration_objects).pipe(
							Effect.catchTag('StoreError', (e) => Effect.fail(from_store(e)))
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
				const lines = yield* definitionsOf(file.sql);
				archived = yield* verify_squash(prefix, file, prefixes.get(prefix.length) ?? [], lines).pipe(
					Effect.mapError(from_store)
				);
				definitions[file.name] = lines;
				const existing = receipts.find((receipt) => receipt.file === archived?.file);
				if (existing !== undefined && canonical(existing) !== canonical(archived))
					return yield* BoltError.make(
						'migration_changed',
						'admission',
						`${file.name}: a retained squash never changes`
					);
				if (existing === undefined) receipts.push(archived);
				physical[file.name] = archived.proof;
			}
			const lock = yield* verify(files, snapshot, next, actual, expected, {
				physical,
				...(receipts.length === 0 ? {} : { squashes: receipts })
			}).pipe(Effect.mapError(from_store));
			return { lock, archived, definitions };
		}).pipe(Effect.provide(Pristine.layer))
	);
	if (
		mode === 'verify' &&
		canonical(yield* read_lock(proof.lock).pipe(Effect.mapError(from_store))) !== canonical(oldLock)
	)
		return yield* BoltError.make(
			'migration_changed',
			'admission',
			'migration replay proofs changed; run bolt build and review migrations.lock.json'
		);
	if (mode === 'verify') {
		if (canonical(heldPhysical) !== canonical(proof.definitions))
			return yield* BoltError.make(
				'migration_changed',
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
					if (sha256_hex(yield* fs.readFileString(destination)) !== checksum_of(file))
						return yield* BoltError.make(
							'migration_changed',
							'admission',
							`${file.name}: an existing archive never changes`
						);
				} else yield* fs.writeFileString(destination, file.sql);
			}
		}
		yield* fs.makeDirectory(directory, { recursive: true });
		for (const [file, text] of generatedFiles) yield* fs.writeFileString(file, text);
		yield* fs.writeFileString(physicalFile, physical_definitions_of(proof.definitions));
		yield* fs.writeFileString(lockFile, proof.lock);
		// Only remove redundant source copies once immutable archived bytes and their verified receipt are durable.
		if (proof.archived !== undefined)
			for (const file of files.slice(0, proof.archived.replaces.length)) {
				const source = path.join(directory, file.name);
				if (yield* fs.exists(source)) {
					if (sha256_hex(yield* fs.readFileString(source)) !== checksum_of(file))
						return yield* BoltError.make(
							'migration_changed',
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
