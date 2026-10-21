// Seed packs as hosts read them (rule 70, §7.2): `pack.json` plus `rows/<collection>.jsonl`, written by `bolt build`
// (compiler/artifact/seed.ts). Loading one is a restore into a database with no workspace rows. Here, not in the
// compiler, so any host (bolt start or an adapter) loads packs through `@norbital-ai/bolt/engine` without the build toolchain.
import { EMBED } from '../integrations/embed.ts';
import { SYSTEM } from '../../system/index.ts';
import { Effect, FileSystem, Option, Schema } from 'effect';
import { TenantTx } from '../db/tenant-db.ts';
import { enqueue } from '../runs/queue.ts';
import { Chain } from './sql.ts';
import { join } from 'node:path';
import type { Json } from '../../decl/values.ts';
import type { RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { seed as restore } from './seed.ts';
import { decodeConfiguration, definitionOf } from '../integrations/instances.ts';
export type SeedAsset = {
	path: string;
	sha256: string;
	bytes: number;
	contentType: string;
};
export type PackJson = {
	format: 1;
	name: string;
	hash: string;
	start: readonly string[];
	rows: {
		readonly [collection: string]: number;
	};
	assets: readonly SeedAsset[];
};
export type Pack = {
	dir: string;
	meta: PackJson;
	rows: {
		readonly [collection: string]: readonly {
			readonly [field: string]: Json;
		}[];
	};
};
/** The system collections a pack may seed, in load order: members, then integration instances (a personal one names its member). */
export const IDENTITY = ['sys_user', 'sys_integration'] as const;
const IDENTITY_COLUMNS: {
	readonly [t: string]: readonly string[];
} = {
	sys_user: ['id', 'name', 'email', 'kind', 'active', 'admin', 'team', 'phone', 'telegram'],
	sys_integration: ['id', 'integration', 'name', 'owner', 'active', 'configuration']
};
/** The rows that make a database "not empty": a named instance is the schema plan's (`source:connections`), never a seed's. */
const SEEDED: {
	readonly [t: string]: string;
} = { sys_integration: 'WHERE NOT named' };
/**
 * Identity seeds choose source affiliations; they cannot declare teams or policy grants. An instance seed is a run-time
 * instance of a defined integration: a connection (named, its envoy) is source, and its credentials are never seeded.
 * The seeded instances come back as they are stored: their configuration decoded, its defaults filled.
 */
export function decodeIdentity(m: EngineManifest, rows: Pack['rows']): Pack['rows'] {
	const unknown = Object.keys(rows).find(
		(c) => m.models[c] === undefined && !(IDENTITY as readonly string[]).includes(c)
	);
	if (unknown !== undefined)
		throw BoltError.make('seedDecode', 'decode', `seed: unknown collection '${unknown}'`);
	for (const [i, row] of (rows['sys_user'] ?? []).entries()) {
		const team = row['team'];
		if (
			team !== undefined &&
			team !== null &&
			(typeof team !== 'string' || !Object.hasOwn(m.teams, team))
		)
			throw BoltError.make(
				'seedDecode',
				'decode',
				`seed sys_user[${i}]: team must name an authored source handle`
			);
	}
	const columns = IDENTITY_COLUMNS['sys_integration']!;
	const instances = (rows['sys_integration'] ?? []).map((row, i) => {
		const fail = (message: string): never => {
			throw BoltError.make('seedDecode', 'decode', `seed sys_integration[${i}]: ${message}`);
		};
		const extra = Object.keys(row).find((k) => !columns.includes(k));
		if (extra !== undefined)
			fail(
				`'${extra}' is not seeded (an instance seeds ${columns.join(', ')}; connections and their envoys are +workspace.ts's)`
			);
		if (typeof row['id'] !== 'string') fail('every row carries its id');
		if (Object.hasOwn(m.connections, String(row['id'])))
			fail(`'${String(row['id'])}' is a connection of +workspace.ts, not a seed`);
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
			contentType: Schema.String
		})
	)
});
const RowSchema = Schema.Record(Schema.String, Schema.Json);
const decodeJson = <A, I>(schema: Schema.Codec<A, I>, text: string) =>
	Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
		Effect.mapError((cause) => BoltError.make('seedDecode', 'decode', cause.message, cause))
	);
/** Open is scoped by FileSystem; every parse failure and interruption releases the handle. */
const readRowsFile = Effect.fn('Bolt.readPackRows')(function* (path: string) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const file = yield* fs.open(path);
			const decoder = new TextDecoder();
			const rows: RowData[] = [];
			let pending = '';
			while (true) {
				const chunk = yield* file.readAlloc(1024 * 1024);
				if (Option.isNone(chunk)) break;
				pending += decoder.decode(chunk.value, { stream: true });
				let end;
				while ((end = pending.indexOf('\n')) >= 0) {
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					if (line !== '') rows.push(yield* decodeJson(RowSchema, line));
				}
			}
			pending += decoder.decode();
			if (pending !== '') rows.push(yield* decodeJson(RowSchema, pending));
			return rows;
		})
	);
});
export const readPack = Effect.fn('Bolt.readPack')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const meta = yield* decodeJson(PackSchema, yield* fs.readFileString(join(dir, 'pack.json')));
	const entries = yield* Effect.forEach(
		Object.keys(meta.rows),
		(c) =>
			readRowsFile(join(dir, 'rows', `${c}.jsonl`)).pipe(Effect.map((rows) => [c, rows] as const)),
		{ concurrency: 'unbounded' }
	);
	return { dir, meta, rows: Object.fromEntries(entries) };
});
/**
 * Rule 70: loads a pack only into a database with no workspace rows (`false` when it had some and nothing changed):
 * identity stages first, then the restore of every collection in relationship order.
 */
export const loadPack = Effect.fn('Bolt.loadPack')(function* (
	db: TenantDb,
	m: EngineManifest,
	pack: Pack,
	now: string
) {
	const identity = yield* Effect.try({
		try: () => decodeIdentity(m, pack.rows),
		catch: (error) =>
			error instanceof BoltError
				? error
				: BoltError.make('seedDecode', 'decode', String(error), error)
	});
	const tables = [
		...IDENTITY,
		...Object.keys(m.models).filter((table) => !Object.hasOwn(SYSTEM.models, table))
	];
	const [probe] = yield* db.read([
		{
			text:
				tables
					.map((t) => `SELECT 1 FROM "${t}"${SEEDED[t] === undefined ? '' : ` ${SEEDED[t]}`}`)
					.join(' UNION ALL ') + ' LIMIT 1',
			params: []
		}
	]);
	if (probe!.rows.length > 0) return false;
	// ponytail: identity and the restore are two transactions; one, when the restore takes a caller's transaction
	yield* db.transaction(
		Effect.gen(function* () {
			const tx = yield* TenantTx;
			// one insert per shape: a column a row leaves out takes its default, never another row's null
			for (const t of IDENTITY)
				for (const rows of Map.groupBy(identity[t] ?? [], (r) =>
					IDENTITY_COLUMNS[t]!.filter((c) => r[c] !== undefined).join()
				).values()) {
					const cols = IDENTITY_COLUMNS[t]!.filter((c) => rows[0]![c] !== undefined);
					const text = `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(', ')}) SELECT ${cols.map((c) => `r."${c}"`).join(', ')}
				FROM jsonb_populate_recordset(null::${t}, $1::jsonb) r ON CONFLICT (id) DO NOTHING`;
					yield* tx.query({ text, params: [JSON.stringify(rows)] });
				}
		})
	);
	const identities: ReadonlySet<string> = new Set(IDENTITY);
	const tenant = Object.fromEntries(Object.entries(pack.rows).filter(([c]) => !identities.has(c)));
	if (Object.keys(tenant).length > 0) yield* restore(m, db, tenant, now);
	// a pack writes past the acts that queue `bolt.embed`: seeded rows of a semantic collection would never get a vector
	if (Object.keys(tenant).some((c) => m.models[c]?.search?.semantic !== undefined)) {
		const chain = new Chain();
		enqueue(chain, [{ automation: EMBED, input: {}, dueAt: now, cause: 'updated', depth: 0 }]);
		yield* db.write(chain.sql('1'));
	}
	return true;
});
