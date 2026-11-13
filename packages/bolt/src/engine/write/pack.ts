// Seed packs as hosts read them: `pack.json` plus `rows/<model>.jsonl`, written by `bolt build`
// (bolt-cli's compiler/artifact/seed.ts). Loading one is a restore into a database with no workspace rows. Here, not in the
// compiler, so any host (tethered or untethered) loads packs through `@norbital-ai/bolt/engine` without the build toolchain.
import { EMBED } from '../integrations/embed.ts';
import { INDEX } from './index-run.ts';
import { SYSTEM } from '../../system/index.ts';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { literal } from '@norbital-ai/store';
import { enqueue } from '../runs/queue.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { Chain } from './sql.ts';
import type { Json } from '../../decl/values.ts';
import type { RowData, Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { DbError } from '../errors.ts';
import { restorer } from './seed.ts';
import { decodeConfiguration, definitionOf } from '../integrations/instances.ts';
import { catalog_of } from '../access/pred.ts';
import { null_row_sql, q } from '@norbital-ai/store';
/** A seed pack's decoded `pack.json`: its name, hash, starting automations, row counts per model and asset list. */
export type PackJson = typeof PackSchema.Type;
export type SeedAsset = PackJson['assets'][number];
export type Pack = {
	dir: string;
	meta: PackJson;
	rows: {
		readonly [model: string]: readonly {
			readonly [field: string]: Json;
		}[];
	};
};
/** The system models a pack may seed, in load order: members, then integration instances (a personal one names its member). */
export const IDENTITY = ['sys_user', 'sys_integration'] as const;
const IDENTITY_COLUMNS = {
	sys_user: ['id', 'name', 'email', 'kind', 'active', 'admin', 'team', 'phone', 'telegram', 'slack', 'discord'],
	sys_integration: ['id', 'integration', 'name', 'owner', 'active', 'configuration']
} satisfies Record<(typeof IDENTITY)[number], readonly string[]>;
/**
 * Identity seeds choose source affiliations; they cannot declare teams or policy grants. An instance seed is a run-time
 * instance of a defined integration. Credentials and envoy deployment are configured at runtime, never seeded.
 * The seeded instances come back as they are stored: their configuration decoded, its defaults filled.
 */
export function decode_identity(m: EngineManifest, rows: Pack['rows']): Pack['rows'] {
	const unknown = Object.keys(rows).find(
		(c) => m.models[c] === undefined && !IDENTITY.some((i) => i === c)
	);
	if (unknown !== undefined)
		throw BoltError.make('seed_decode', 'decode', `seed: unknown model '${unknown}'`);
	for (const [i, row] of (rows['sys_user'] ?? []).entries()) {
		const team = row['team'];
		if (
			team !== undefined &&
			team !== null &&
			(typeof team !== 'string' || !Object.hasOwn(m.teams, team))
		)
			throw BoltError.make(
				'seed_decode',
				'decode',
				`seed sys_user[${i}]: team must name an authored source handle`
			);
	}
	const columns = IDENTITY_COLUMNS.sys_integration;
	const instances = (rows['sys_integration'] ?? []).map((row, i) => {
		const fail = (message: string): never => {
			throw BoltError.make('seed_decode', 'decode', `seed sys_integration[${i}]: ${message}`);
		};
		const extra = Object.keys(row).find((k) => !columns.includes(k));
		if (extra !== undefined)
			fail(
				`'${extra}' is not seeded (an instance seeds ${columns.join(', ')}; credentials and envoy deployment are runtime settings)`
			);
		if (typeof row['id'] !== 'string') fail('every row carries its id');
		const def =
			definitionOf(m, String(row['integration'])) ??
			fail(`no integration '${String(row['integration'])}' is defined`);
		const configuration = decodeConfiguration(def, row['configuration'] ?? {});
		return 'problem' in configuration
			? fail(configuration.problem)
			: { ...row, configuration: configuration.value };
	});
	return rows['sys_integration'] === undefined ? rows : { ...rows, sys_integration: instances };
}
const PackSchema = Schema.Struct({
	format: Schema.Literal(1),
	name: Schema.String,
	hash: Schema.String,
	start: Schema.Array(Schema.String),
	rows: Schema.Record(Schema.String, Schema.Int),
	assets: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			sha256: Schema.String,
			bytes: Schema.Int,
			content_type: Schema.String
		})
	)
});
const RowSchema = Schema.Record(Schema.String, Schema.Json);
const decodeJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
		Effect.mapError((cause) => BoltError.make('seed_decode', 'decode', cause.message, cause))
	);
/** A rows file's lines, cut from its bytes (the artifact port reads whole files): one row each, decoded as it is read. */
function* linesOf(bytes: Uint8Array) {
	let start = 0;
	for (let at = bytes.indexOf(10); at !== -1; start = at + 1, at = bytes.indexOf(10, start))
		if (at > start) yield bytes.subarray(start, at);
	if (start < bytes.length) yield bytes.subarray(start);
}
/** A pack as a loader takes it: its `pack.json` and each model's rows from row `from`, streamed when restored. */
export type PackSource = {
	readonly meta: PackJson;
	readonly rows: (model: string, from: number) => Stream.Stream<RowData, BoltError>;
	/** One of `meta.assets`' bytes, by its path. */
	readonly asset: (path: string) => Effect.Effect<Uint8Array, BoltError, FileSystem.FileSystem>;
};
/** A pack directory's `assets/<path>`. */
const assetAt = (dir: string) => (path: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(`${dir}/assets/${path}`)).pipe(
		Effect.mapError((cause) => BoltError.make('seed_decode', 'decode', cause.message, cause))
	);
export const source_of = (pack: Pack): PackSource => ({
	meta: pack.meta,
	rows: (model, from) => Stream.fromIterable((pack.rows[model] ?? []).slice(from)),
	asset: assetAt(pack.dir)
});
/**
 * Rows a host holds in memory (`bolt seed`'s, never written to its disk) as a pack named `name`; each asset's bytes come
 * from `asset`, the host's store of what the seeding run uploaded.
 */
export const memory_source = (
	name: string,
	rows: Pack['rows'],
	start: readonly string[],
	assets: readonly SeedAsset[],
	asset: (path: string) => Effect.Effect<Uint8Array, BoltError>
): PackSource => ({
	meta: {
		format: 1,
		name,
		hash: '',
		start,
		rows: Object.fromEntries(Object.entries(rows).map(([c, r]) => [c, r.length])),
		assets
	},
	rows: (model, from) => Stream.fromIterable((rows[model] ?? []).slice(from)),
	asset
});
/** A pack whose rows stay on disk until each model is restored, a line at a time (a cell holds 128 MiB). */
export const read_pack_source = Effect.fn('Bolt.read_pack_source')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	// posix, relative to a release in a cell or absolute in-process
	const meta = yield* decodeJson(PackSchema, yield* fs.readFileString(`${dir}/pack.json`));
	// the model being restored, read once for all of its steps; the rows a step skips are cut, never decoded
	let held: { model: string; bytes: Uint8Array } | undefined;
	const bytesOf = (model: string) =>
		held?.model === model
			? Effect.succeed(held.bytes)
			: fs.readFile(`${dir}/rows/${model}.jsonl`).pipe(
					Effect.mapError((cause) => BoltError.make('seed_decode', 'decode', cause.message, cause)),
					Effect.tap((bytes) =>
						Effect.sync(() => {
							held = { model, bytes };
						})
					)
				);
	const text = new TextDecoder();
	return {
		meta,
		asset: assetAt(dir),
		rows: (model: string, from: number) =>
			Object.hasOwn(meta.rows, model)
				? Stream.unwrap(
						Effect.map(bytesOf(model), (bytes) =>
							Stream.fromIterable(linesOf(bytes)).pipe(
								Stream.drop(from),
								Stream.mapEffect((line) => decodeJson(RowSchema, text.decode(line)))
							)
						)
					)
				: Stream.empty
	} satisfies PackSource;
});
/** Every model's rows in memory, for in-process hosts and test kits. */
export const read_pack = Effect.fn('Bolt.read_pack')(function* (dir: string) {
	const source = yield* read_pack_source(dir);
	const entries = yield* Effect.forEach(
		Object.keys(source.meta.rows),
		(c) =>
			Stream.runCollect(source.rows(c, 0)).pipe(
				Effect.map((rows) => [c, Array.from(rows)] as const)
			),
		{ concurrency: 'unbounded' }
	);
	return { dir, meta: source.meta, rows: Object.fromEntries(entries) } satisfies Pack;
});
/** A pack load's step: `more` while steps remain; `loaded`, or `hadRows` when the database had rows and nothing changed. */
export type PackStep = 'more' | 'loaded' | 'hadRows';
/**
 * Rule 70: loads a pack only into a database with no workspace rows, in bounded steps (one unit of
 * work each): identity first, then the restore of every model in relationship order (`restorer`'s steps).
 */
export const packLoader = Effect.fn('Bolt.packLoader')(function* (
	db: TenantDb,
	m: EngineManifest,
	pack: PackSource,
	now: string
) {
	const identities: ReadonlySet<string> = new Set(IDENTITY);
	const cat = catalog_of(m);
	const names = Object.keys(pack.meta.rows);
	const tenant = names.filter((c) => !identities.has(c));
	const identityStep = Effect.gen(function* () {
		// every model is named (an unknown one is refused); only the members and instances are read here
		const identityRows = Object.fromEntries(
			yield* Effect.forEach(names, (c) =>
				(identities.has(c) ? Stream.runCollect(pack.rows(c, 0)) : Effect.succeed([])).pipe(
					Effect.map((rows) => [c, Array.from(rows)] as const)
				)
			)
		);
		const identity = yield* Effect.try({
			try: () => decode_identity(m, identityRows),
			catch: (error) =>
				error instanceof BoltError
					? error
					: BoltError.make('seed_decode', 'decode', String(error), error)
		});
		const tables = [
			...IDENTITY,
			...Object.keys(m.models).filter((table) => !Object.hasOwn(SYSTEM.models, table))
		];
		const [probe] = yield* db.read([
			{
				text:
					tables
						.map((t) => `SELECT 1 FROM "${t}"`)
						.join(' UNION ALL ') + ' LIMIT 1',
				params: []
			}
		]);
		if (probe === undefined) return yield* Effect.fail(DbError.make('XX000', 'The database did not answer the seed emptiness read.'));
		if (probe.rows.length > 0) return false;
		const probeSql = tables
			.map(
				(table) =>
					`select 1 from ${q(table)}`
			)
			.join(' union all ');
		const body = `begin if exists (${probeSql}) then raise exception using errcode = 'BP001', message = 'the seed database is no longer empty'; end if; end`;
		const statements: Sql[] = [{ text: `do ${literal(body)}`, params: [] }];
		// Model and decoding finished before the batch: no stream, file or guest work holds its locks.
		for (const table of IDENTITY)
			for (const rows of Map.groupBy(identity[table] ?? [], (row) =>
				IDENTITY_COLUMNS[table].filter((column) => row[column] !== undefined).join()
			).values()) {
				const first = rows[0];
				if (first === undefined) continue;
				const columns = IDENTITY_COLUMNS[table].filter((column) => first[column] !== undefined);
				statements.push({
					text: `insert into ${q(table)} (${columns.map(q).join(', ')}) select ${columns.map((column) => `r.${q(column)}`).join(', ')}
					from jsonb_populate_recordset(${null_row_sql(table, cat.models.get(table)?.fields.keys() ?? [])}, $1::jsonb) r on conflict (id) do nothing`,
					params: [JSON.stringify(rows)]
				});
			}
		return yield* db
			.transaction({
				statements,
				lock: { tables, mode: 'SHARE ROW EXCLUSIVE', advisory: ['bolt:seed'] }
			})
			.pipe(
				Effect.as(true),
				Effect.catchTag('DbError', (error) =>
					error.sqlstate === 'BP001' ? Effect.succeed(false) : Effect.fail(error)
				)
			);
	});
	const restore = yield* restorer(m, db, { models: tenant, rows: pack.rows }, now);
	// a pack writes past the acts that queue `bolt.embed`: seeded rows of a semantic model would never get a vector; its
	// `start` automations are queued with the rows, so no host carries them to a later admission
	const embed = Effect.suspend(() => {
		const runs = [
			...(tenant.some((c) => m.models[c]?.search?.semantic !== undefined)
				? [{ automation: EMBED, input: {}, due_at: now, cause: 'schedule', depth: 0 }]
				: []),
			// nor would a pure search index's vector, which only an act evaluates
			...(tenant.some((c) =>
				Object.values(m.models[c]?.search?.indexes ?? {}).some((index) => index.field === undefined)
			)
				? [{ automation: INDEX, input: {}, due_at: now, cause: 'schedule', depth: 0 }]
				: []),
			...pack.meta.start.map((automation) => ({
				automation,
				input: {},
				due_at: now,
				cause: 'start',
				depth: 0
			}))
		];
		if (runs.length === 0) return Effect.void;
		const chain = new Chain();
		enqueue(chain, runs);
		return nativeCommit(db.write, 'bootstrap', chain, CapturedResult).pipe(Effect.asVoid);
	});
	let identified = false,
		answer: 'loaded' | 'hadRows' | undefined;
	const step = Effect.gen(function* () {
		if (answer !== undefined) return answer;
		if (!identified) {
			const restored = yield* identityStep;
			identified = true;
			if (!restored) answer = 'hadRows';
			return answer ?? ('more' as const);
		}
		if (yield* restore.step) return 'more' as const;
		yield* embed;
		answer = 'loaded';
		return answer;
	});
	return { step };
});
/** A loader's steps one after another, to its answer (in-process hosts and test kits; a cell host enters each alone). */
export const drain = <E, R>(step: Effect.Effect<PackStep, E, R>) =>
	Effect.gen(function* () {
		let answer = yield* step;
		while (answer === 'more') answer = yield* step;
		return answer;
	});
/** `packLoader` whole: `false` when the database had rows and nothing changed. */
export const load_pack = Effect.fn('Bolt.load_pack')(function* (
	db: TenantDb,
	m: EngineManifest,
	pack: PackSource,
	now: string
) {
	return (yield* drain((yield* packLoader(db, m, pack, now)).step)) === 'loaded';
});
