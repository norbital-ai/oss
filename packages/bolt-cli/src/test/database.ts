// The kit's databases. A schema is planned once per machine into a checkpoint (`images/<hash>.zst` and its shape); a
// worker loads a checkpoint into one in-memory PGlite and pools it, and every later acquisition restores that database
// to its checkpoint in place: the tables a test changed emptied and refilled, sequences rewound, session state reset.
// A database whose catalogs changed (a test ran DDL or kept a temp table) is closed and loaded afresh instead.
import type { PGlite } from '@electric-sql/pglite';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Effect, Exit, FileSystem, Layer, Option, Schema, Scope } from 'effect';
import type { PlatformError } from 'effect/PlatformError';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { TenantDb, applyPlan, plan } from '@norbital-ai/bolt/engine';
import {
	dbError,
	schemaSlice,
	type SchemaSlice,
	CAPTURE_TABLES,
	PgliteDb,
	Pristine
} from '@norbital-ai/bolt/tooling';
import type { DbError, EngineManifest, BoltError } from '@norbital-ai/bolt/engine';
import { CHECKPOINTS, inputs, keep, prune } from './checkpoint.ts';

export type TestDbFailure = BoltError | DbError | PlatformError;
/** The PGlite build (its versioned store path): an image from another build is another key. */
// `createRequire`, not `import.meta.resolve`: a template's vitest module runner supports only the former
const PGLITE = createRequire(import.meta.url).resolve('@electric-sql/pglite');
/** Images kept per machine (zstd, a few MiB each): more than one suite's schemas, so a run never evicts its own. */
const KEPT_IMAGES = 256;
/** Pooled databases a worker keeps idle; the oldest beyond this closes. */
const IDLE = 4;

const TABLES = `select format('%I.%I', n.nspname, c.relname) as name,
	coalesce((select string_agg(format('%I', a.attname), ', ' order by a.attnum) from pg_attribute a
		where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''), '') as cols
	from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname !~ '^pg_' and n.nspname <> 'information_schema' order by 1`;
const SEQUENCES = `select format('setval(%L, %s, %s)', format('%I.%I', schemaname, sequencename),
	coalesce(last_value, start_value), (last_value is not null)::text) as s
	from pg_sequences where schemaname !~ '^pg_' and schemaname <> 'information_schema'`;
/** A checkpoint's tables (columns, row counts) and sequences: read once when its image is made, not on every load. */
const Shape = Schema.Struct({
	tables: Schema.Array(Schema.Struct({ name: Schema.String, cols: Schema.String })),
	counts: Schema.Array(Schema.Number),
	sequences: Schema.Array(Schema.String)
});
type Shape = typeof Shape.Type;
const decodeShape = Schema.decodeUnknownEffect(Schema.fromJsonString(Shape));
const shapeOf = async (pg: PGlite): Promise<Shape> => {
	const tables = (await pg.query<{ name: string; cols: string }>(TABLES)).rows;
	const sequences = (await pg.query<{ s: string }>(SEQUENCES)).rows.map((r) => r.s);
	const row =
		tables.length === 0
			? {}
			: ((
					await pg.query<Record<string, number>>(
						`select ${tables.map((t, i) => `(select count(*)::int from ${t.name}) as "${i}"`).join(', ')}`
					)
				).rows[0] ?? {});
	return { tables, counts: tables.map((_, i) => row[String(i)] ?? 0), sequences };
};
/** A database to load: its dump, uncompressed (PGlite only untars it), and for a schema image its shape. */
type Checkpoint = { readonly blob: Blob; readonly shape?: Shape };

/** The plan for one schema, from the pristine dump: paid once per schema and machine, then a checkpoint. */
const freshImage = (slice: SchemaSlice) =>
	Effect.scoped(
		Effect.gen(function* () {
			const pg = yield* PgliteDb.open().pipe(Effect.provide(Pristine.layer));
			yield* applyPlan(PgliteDb.make(pg), yield* plan(null, slice), { accept: true });
			const shape = yield* Effect.tryPromise({ try: () => shapeOf(pg), catch: dbError });
			return { blob: yield* PgliteDb.dump(pg), shape };
		})
	);
/** The schema's checkpoint (`<hash>.zst`, its shape `<hash>.json`), else built once and kept (newest few hundred). */
const image = (slice: SchemaSlice, key: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const dir = join(CHECKPOINTS, 'images');
		const hash = createHash('sha256')
			.update(JSON.stringify([PGLITE, yield* inputs.image, key]))
			.digest('hex');
		const file = join(dir, `${hash}.zst`),
			shapeFile = join(dir, `${hash}.json`);
		// zstd, inflated natively: several times cheaper than gzip both ways, and PGlite only untars
		const kept = yield* Effect.all({
			bytes: fs
				.readFile(file)
				.pipe(Effect.flatMap((bytes) => Effect.try(() => zstdDecompressSync(bytes)))),
			shape: fs.readFileString(shapeFile).pipe(Effect.flatMap(decodeShape))
		}).pipe(Effect.option);
		if (Option.isSome(kept))
			return {
				blob: new Blob([kept.value.bytes]),
				shape: kept.value.shape
			} satisfies Checkpoint;
		return yield* Effect.gen(function* () {
			const made = yield* freshImage(slice);
			// the shape first, so an image on disk has its shape beside it
			yield* keep(shapeFile, JSON.stringify(made.shape));
			yield* keep(
				file,
				zstdCompressSync(new Uint8Array(yield* Effect.promise(() => made.blob.arrayBuffer())))
			);
			yield* prune(dir, KEPT_IMAGES);
			return made satisfies Checkpoint;
		});
	}).pipe(Effect.provide(NodeFileSystem.layer));

// Every catalog DDL writes: a create or alter leaves a newer xmin, a drop a smaller count. The write buffers exist
// before the baseline. Only objects created after initdb (oid 16384 on) can change, so each catalog is read
// over that oid range, not the thousands of built-in rows; the two tiny catalogs DDL may touch built-in rows of (a
// grant on `public`, an extension) are read whole.
const CATALOGS: readonly (readonly [catalog: string, oid: string | null])[] = [
	['pg_class', 'oid'],
	['pg_attribute', 'attrelid'],
	['pg_attrdef', 'oid'],
	['pg_constraint', 'oid'],
	['pg_index', 'indexrelid'],
	['pg_trigger', 'oid'],
	['pg_rewrite', 'oid'],
	['pg_proc', 'oid'],
	['pg_type', 'oid'],
	['pg_enum', 'oid'],
	['pg_policy', 'oid'],
	['pg_sequence', 'seqrelid'],
	['pg_namespace', null],
	['pg_extension', null]
];
const FINGERPRINT = `select concat_ws(',', ${CATALOGS.map(
	([c, oid]) =>
		`(select count(*) || ':' || coalesce(max(xmin::text::bigint), 0) from ${c}${oid === null ? '' : ` where ${oid} >= 16384`})`
).join(', ')}) as f`;

type Pooled = {
	readonly key: string;
	/** The checkpoint it was loaded from: a database whose catalogs changed reloads from it, not from disk. */
	readonly checkpoint: Checkpoint;
	readonly pg: PGlite;
	readonly scope: Scope.Closeable;
	/** Restores the checkpoint: only the tables a test changed, in one native transaction. */
	readonly restore: () => Promise<void>;
	readonly fingerprint: string;
};
const idle: Pooled[] = [];

// prepared once per session: planning the fourteen subqueries costs more than running them
const fingerprintOf = async (pg: PGlite) =>
	(await pg.query<{ f: string }>('execute bolt_kit_fingerprint')).rows[0]?.f ?? '';
/**
 * This session's next transaction id (32-bit, as `xmin` reads): every row written later has a newer `xmin`. Kept in a
 * session table, not passed as a parameter, so `bolt_kit_changed` has none and is planned once, not per restore.
 */
const BASE = 'update pg_temp.bolt_kit_base set x = txid_current() & 4294967295;';
const SESSION = [
	'reset all;',
	`set time zone 'UTC';`,
	'select pg_advisory_unlock_all();',
	'unlisten *;'
].join('\n');
/**
 * The checkpoint's rows copied into session temp tables (they outlive every test), and the restore. A table is as the
 * checkpoint left it while it holds as many rows and none newer than the last restore (an insert or update leaves a
 * newer `xmin`, a delete a smaller count): only the others are emptied and refilled.
 */
const capture = async (pg: PGlite, { tables, counts, sequences }: Shape) => {
	// the write buffers every session keeps exist before the baseline fingerprint, so a test's first write is no DDL change
	for (const table of CAPTURE_TABLES) await pg.exec(table);
	await pg.exec(`prepare bolt_kit_fingerprint as ${FINGERPRINT}`);
	await pg.exec(
		'create temp table bolt_kit_base (x bigint); insert into pg_temp.bolt_kit_base values (0);'
	);
	const refill = new Map<number, string>();
	for (const [i, t] of tables.entries()) {
		if ((counts[i] ?? 0) === 0 || t.cols === '') continue;
		await pg.exec(`create temp table bolt_kit_${i} as select ${t.cols} from ${t.name}`);
		refill.set(
			i,
			`insert into ${t.name} (${t.cols}) overriding system value select ${t.cols} from pg_temp.bolt_kit_${i};`
		);
	}
	if (tables.length > 0)
		await pg.exec(
			`prepare bolt_kit_changed as select ${tables
				.map(
					(t, i) =>
						`((select count(*) from ${t.name}) <> ${counts[i] ?? 0} or exists(select 1 from ${t.name} where xmin::text::bigint > (select x from pg_temp.bolt_kit_base))) as "${i}"`
				)
				.join(', ')}`
		);
	const rewind = sequences.length === 0 ? '' : `select ${sequences.join(', ')};`;
	await pg.exec(BASE);
	const restore = async () => {
		const changed =
			tables.length === 0
				? {}
				: ((await pg.query<Record<string, boolean>>('execute bolt_kit_changed')).rows[0] ?? {});
		const dirty = tables.flatMap((t, i) =>
			changed[String(i)] === true ? [[i, t.name] as const] : []
		);
		await pg.exec(
			[
				'begin;',
				// no trigger or foreign key fires: rows return exactly as the checkpoint held them
				'set local session_replication_role = replica;',
				...dirty.map(([, name]) => `delete from ${name};`),
				...dirty.flatMap(([i]) => refill.get(i) ?? []),
				rewind,
				'commit;',
				SESSION,
				BASE
			].join('\n')
		);
	};
	return { restore, fingerprint: await fingerprintOf(pg) };
};
const close = (entry: Pooled) => Scope.close(entry.scope, Exit.void);
type Prepare<E> = (pg: PGlite) => Effect.Effect<void, E>;
const load = <E>(
	key: string,
	source: Effect.Effect<Checkpoint, TestDbFailure>,
	prepare?: Prepare<E>
) =>
	Effect.gen(function* () {
		const checkpoint = yield* source;
		const scope = yield* Scope.make();
		return yield* Effect.gen(function* () {
			const pg = yield* PgliteDb.open(checkpoint.blob).pipe(
				Scope.provide(scope),
				Effect.provide(Pristine.layer)
			);
			if (prepare !== undefined) yield* prepare(pg);
			const state = yield* Effect.tryPromise({
				try: async () => capture(pg, checkpoint.shape ?? (await shapeOf(pg))),
				catch: dbError
			});
			return { key, checkpoint, pg, scope, ...state } satisfies Pooled;
		}).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
	});
/** A pooled database at its checkpoint again, or `false` when a test changed its catalogs. A failed restore is the kit's bug: it dies. */
const restored = (entry: Pooled) =>
	Effect.tryPromise({
		try: async () => {
			if ((await fingerprintOf(entry.pg)) !== entry.fingerprint) return false;
			await entry.restore();
			return true;
		},
		catch: dbError
	}).pipe(Effect.orDie);
const acquire = <E>(
	key: string,
	source: Effect.Effect<Checkpoint, TestDbFailure>,
	prepare?: Prepare<E>
) =>
	Effect.gen(function* () {
		const at = idle.findIndex((e) => e.key === key);
		const [entry] = at < 0 ? [] : idle.splice(at, 1);
		if (entry !== undefined) {
			if (yield* restored(entry)) return entry;
			yield* close(entry);
			return yield* load(key, Effect.succeed(entry.checkpoint), prepare);
		}
		return yield* load(key, source, prepare);
	});
const release = (entry: Pooled) =>
	Effect.suspend(() => {
		idle.push(entry);
		return Effect.forEach(idle.splice(0, Math.max(0, idle.length - IDLE)), close, {
			discard: true
		});
	});

// built on the machine's first run (initdb), else read once per process
const pristine = Pristine.pipe(
	Effect.flatten,
	Effect.map((blob): Checkpoint => ({ blob })),
	Effect.provide(Pristine.layer)
);
/** A test's database: in-memory PGlite at `schema`'s checkpoint (empty without one), exclusive to the scope. */
const open = (
	schema?: EngineManifest | SchemaSlice
): Effect.Effect<PGlite, TestDbFailure, Scope.Scope> => {
	const slice =
		schema === undefined ? undefined : 'workspace' in schema ? schemaSlice(schema) : schema;
	const key = slice === undefined ? 'pristine' : JSON.stringify(slice);
	return Effect.acquireRelease(
		acquire<never>(key, slice === undefined ? pristine : image(slice, key)),
		release
	).pipe(Effect.map((e) => e.pg));
};
export const TestDb = {
	open,
	/**
	 * An empty database `prepare` fills (DDL, rows) once per worker, then restored to that state on every acquisition.
	 * `key` names the preparation: one key, one `prepare`, across every file a worker runs.
	 */
	prepared: <E>(
		key: string,
		prepare: Prepare<E>
	): Effect.Effect<PGlite, TestDbFailure | E, Scope.Scope> =>
		Effect.acquireRelease(acquire(`prepared:${key}`, pristine, prepare), release).pipe(
			Effect.map((e) => e.pg)
		),
	layer: (schema?: EngineManifest | SchemaSlice): Layer.Layer<TenantDb, TestDbFailure> =>
		Layer.effect(TenantDb, Effect.map(open(schema), PgliteDb.make))
};
