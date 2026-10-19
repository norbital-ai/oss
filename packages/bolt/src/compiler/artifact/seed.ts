/// <reference types="node" />
// Seed packs (rule 70, X-13, X-15, §7.2): the public `base` pack from `seed/**`, and a `sample` pack read from a bank
// tree by the template's `seed/seed.ts` (or, without one, every `<collection>.json` of the tree). A pack is a sibling of
// the artifact with its own hash: `pack.json`, `rows/<collection>.jsonl`, `assets/**`. Loading one is a restore.
import { createHash } from 'node:crypto';
import { Effect, FileSystem, Result, Schema } from 'effect';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Rolldown } from 'vite';
import type { AutomationName } from '../../decl/names.ts';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest } from '../../engine/manifest.ts';
import { decodeSeed } from '../../engine/write/seed.ts';
import {
	decodeIdentity,
	IDENTITY,
	type PackJson,
	type SeedAsset
} from '../../engine/write/pack.ts';
import type { CheckDiagnostic } from '../check/index.ts';
import { assetPath } from '../../engine/artifact/read.ts';

/** Rows per collection, the identity rows (`sys_user`, run-time `sys_integration` instances) included. */
export type SeedRows = {
	readonly [collection: string]: readonly { readonly [field: string]: Json }[];
};
/** One bank tree, read-only. Paths are relative to the tree. */
export type BankReader = {
	readonly tree: string;
	has(path: string): boolean;
	json<T = unknown>(path: string): T;
	bytes(path: string): Uint8Array;
	/** Every file under `dir` (default the tree), relative to the tree, sorted. */
	files(dir?: string): string[];
};
/** `seed/seed.ts`'s default export (§3.3.10, X-15): runs only at build; imports no runtime value from bolt. */
export type SeedSource = {
	bank: string;
	rows(bank: BankReader): SeedRows | Promise<SeedRows>;
	/** Rule 70's first-admission start: one run of each on the first admission of an environment built from the pack. */
	start?: readonly AutomationName[];
};
export {
	loadPack,
	readPack,
	type Pack,
	type PackJson,
	type SeedAsset
} from '../../engine/write/pack.ts';

// hook:cli-kit — a path join: a DOM test environment's transform rewrites `new URL(…, import.meta.url)` to an asset
const BOLT = join(
	dirname(fileURLToPath(import.meta.url)),
	'../..',
	`index${extname(fileURLToPath(import.meta.url))}`
);
import { sha256Hex } from '../../engine/write/sql.ts';
class SeedSourceError extends Schema.TaggedError<SeedSourceError>()('SeedSourceError', {
	message: Schema.String,
	cause: Schema.Defect()
}) {
	constructor({ cause }: { cause: unknown }) {
		super({ cause, message: cause instanceof Error ? cause.message : String(cause) });
	}
}
const Asset = Schema.Struct({
	path: Schema.String,
	sha256: Schema.String,
	bytes: Schema.Number,
	contentType: Schema.String
});
const Rows = Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json)));
const Source = Schema.Struct({
	bank: Schema.String,
	rows: Schema.declare(
		(value: unknown): value is SeedSource['rows'] => typeof value === 'function'
	),
	start: Schema.optionalKey(Schema.Array(Schema.String))
});

function bankReader(root: string, tree: string): BankReader {
	const base = join(root, tree);
	const at = (p: string) => join(base, p);
	return {
		tree,
		has: (p) => existsSync(at(p)),
		json: (p) => JSON.parse(readFileSync(at(p), 'utf8')),
		bytes: (p) => readFileSync(at(p)),
		files: (dir = '') =>
			existsSync(at(dir))
				? readdirSync(at(dir), { recursive: true, withFileTypes: true })
						.filter((d) => d.isFile())
						.map((d) => relative(base, join(d.parentPath, d.name)).split(sep).join('/'))
						.sort()
				: []
	};
}

/**
 * Without a `seed.ts`: every top-level `<name>.json` of the tree is that collection's rows, and the bank's identity
 * rows become `sys_user` as §7.2 maps them (`status: 'admin'` → admin, `team_id` → team).
 */
function defaultRows(bank: BankReader): SeedRows {
	const out: { [c: string]: SeedRows[string] } = {};
	for (const file of bank.files().filter((f) => /^[^/]+\.json$/.test(f))) {
		const name = file.slice(0, -'.json'.length);
		const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Json)))(
			bank.json(file)
		);
		if (name === 'team')
			continue; // team definitions are authored, never restored from a bank
		else if (name === 'user')
			out['sys_user'] = rows.map((r) => {
				const row = Schema.decodeUnknownSync(
					Schema.Struct({
						id: Schema.Json,
						name: Schema.Json,
						email: Schema.optionalKey(Schema.Json),
						phone: Schema.optionalKey(Schema.Json),
						status: Schema.optionalKey(Schema.Json),
						team_id: Schema.optionalKey(Schema.Json)
					})
				)(r);
				return {
					id: row.id,
					name: row.name,
					email: row.email ?? null,
					...(row.phone == null ? {} : { phone: row.phone }),
					kind: 'staff',
					admin: row.status === 'admin',
					team: row.team_id ?? null
				};
			});
		else out[name] = rows;
	}
	return out;
}

/** Imports `seed/seed.ts` through the bundler (it may import template modules the node loader cannot). */
const seedSource = Effect.fn('bolt.seedSource')(function* (root: string, cache: string) {
	const fs = yield* FileSystem.FileSystem;
	const built = yield* Effect.tryPromise({
		try: () =>
			build({
				configFile: false,
				logLevel: 'silent',
				root,
				resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }] },
				build: {
					write: false,
					ssr: join(root, 'seed/seed.ts'),
					rolldownOptions: {
						output: { format: 'es', entryFileNames: 'seed.mjs', codeSplitting: false }
					}
				}
			}),
		catch: (cause) => new SeedSourceError({ cause })
	});
	const out = Array.isArray(built) ? built[0] : built;
	if (out === undefined || 'close' in out)
		return yield* Effect.fail(
			new SeedSourceError({ cause: new Error('the seed bundler returned no output') })
		);
	const chunk = out.output.find((o): o is Rolldown.OutputChunk => o.type === 'chunk');
	if (chunk === undefined)
		return yield* Effect.fail(
			new SeedSourceError({ cause: new Error('the seed bundler emitted no chunk') })
		);
	const file = join(cache, `seed-${sha256Hex(chunk.code).slice(0, 16)}.mjs`);
	yield* fs.makeDirectory(cache, { recursive: true });
	yield* fs.writeFileString(file, chunk.code);
	const mod: { default?: unknown } = yield* Effect.tryPromise({
		try: () => import(pathToFileURL(file).href),
		catch: (cause) => new SeedSourceError({ cause })
	});
	return yield* Schema.decodeUnknownEffect(Source)(mod.default).pipe(
		Effect.mapError((cause) => new SeedSourceError({ cause }))
	);
});

/** `seed/assets.json` (`{ path, sha256, bytes, contentType }`) checked against `seed/assets/**` (rule 70). */
const assetList = Effect.fn('bolt.seedAssets')(function* (root: string, errors: CheckDiagnostic[]) {
	const fs = yield* FileSystem.FileSystem;
	const file = join(root, 'seed/assets.json');
	if (!(yield* fs.exists(file))) return [];
	const list = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Asset)))(
		yield* fs.readFileString(file)
	);
	const ok: SeedAsset[] = [];
	for (const a of list) {
		const path = join(root, 'seed/assets', a.path);
		const fail = (message: string) =>
			errors.push({
				code: 'seed/asset',
				path: `seed/assets/${a.path}`,
				message: `seed/assets/${a.path}: ${message}`
			});
		if (!(yield* fs.exists(path))) {
			fail('missing');
			continue;
		}
		const bytes = yield* fs.readFile(path);
		if (
			new TextDecoder('latin1').decode(bytes.subarray(0, 40)).startsWith('version https://git-lfs')
		) {
			fail('is a Git-LFS pointer; fetch the object');
			continue;
		}
		if (bytes.byteLength !== a.bytes) {
			fail(`is ${bytes.byteLength} bytes; assets.json says ${a.bytes}`);
			continue;
		}
		if (sha256Hex(bytes) !== a.sha256) {
			fail('sha256 does not match assets.json');
			continue;
		}
		ok.push(a);
	}
	return ok;
});

/** Every asset path the rows' `file` values name (`{ asset }`, read.ts). */
function assetRefs(m: EngineManifest, rows: SeedRows): Set<string> {
	const out = new Set<string>();
	for (const [c, list] of Object.entries(rows))
		for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) {
			if (k.kind !== 'file') continue;
			for (const r of list)
				for (const v of [r[f]].flat()) {
					const p = assetPath(v);
					if (p !== undefined) out.add(p);
				}
		}
	return out;
}

const MIME: { readonly [ext: string]: string } = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.json': 'application/json',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
/** A bank tree's files the sample rows name, as pack assets (their facts computed here; the bank is read, never written). */
const bankAssets = Effect.fn('bolt.bankAssets')(function* (
	paths: Iterable<string>,
	dir: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const out: SeedAsset[] = [];
	for (const path of [...paths].sort()) {
		const file = join(dir, path);
		const fail = (message: string) =>
			errors.push({
				code: 'seed/asset',
				path: `bank ${path}`,
				message: `bank asset ${path}: ${message}`
			});
		if (!(yield* fs.exists(file))) {
			fail('missing');
			continue;
		}
		const bytes = yield* fs.readFile(file);
		if (
			new TextDecoder('latin1').decode(bytes.subarray(0, 40)).startsWith('version https://git-lfs')
		) {
			fail('is a Git-LFS pointer; fetch the object');
			continue;
		}
		out.push({
			path,
			sha256: sha256Hex(bytes),
			bytes: bytes.byteLength,
			contentType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
		});
	}
	return out;
});

/** Writes one pack; its hash covers every row file and asset. Decode and `start` errors are build errors. */
const writePack = Effect.fn('bolt.writePack')(function* (
	out: string,
	name: string,
	m: EngineManifest,
	rows: SeedRows,
	start: readonly string[],
	assets: readonly SeedAsset[],
	assetDir: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const path = `seed (${name} pack)`;
	for (const a of start)
		if (m.automations[a] === undefined)
			errors.push({
				code: 'seed/start',
				path,
				message: `${path}: start names '${a}', which is no automation of the workspace`
			});
	const decoded = Result.try({
		try: () => {
			decodeIdentity(m, rows);
			decodeSeed(
				m,
				Object.fromEntries(
					Object.entries(rows).filter(([c]) => !(IDENTITY as readonly string[]).includes(c))
				)
			);
		},
		catch: (cause) => new SeedSourceError({ cause })
	});
	if (Result.isFailure(decoded)) {
		const e = decoded.failure.cause;
		errors.push({
			code: 'seed/decode',
			path,
			message: `${path}: ${e instanceof Error ? e.message : String(e)}`
		});
		return undefined;
	}

	for (const c of Object.keys(rows))
		if (c.startsWith('sys_') && !(IDENTITY as readonly string[]).includes(c))
			errors.push({
				code: 'seed/decode',
				path,
				message: `${path}: only ${IDENTITY.join(', ')} are seeded among system collections, not '${c}'`
			});
	for (const p of assetRefs(m, rows))
		if (!assets.some((a) => a.path === p))
			errors.push({
				code: 'seed/asset',
				path,
				message: `${path}: a row names the asset '${p}', which the pack does not carry`
			});
	const dir = join(out, name);
	yield* fs.remove(dir, { recursive: true, force: true });
	yield* fs.makeDirectory(join(dir, 'rows'), { recursive: true });
	const h = createHash('sha256');
	const counts: { [c: string]: number } = {};
	for (const c of Object.keys(rows).sort()) {
		const file = join(dir, 'rows', `${c}.jsonl`);
		yield* Effect.scoped(
			Effect.gen(function* () {
				const fd = yield* fs.open(file, { flag: 'w' });
				h.update(`rows/${c}\0`);
				for (const r of rows[c] ?? []) {
					const line = `${JSON.stringify(r)}\n`;
					yield* fd.writeAll(new TextEncoder().encode(line));
					h.update(line);
				}
				h.update('\0');
			})
		);
		counts[c] = rows[c]?.length ?? 0;
	}
	for (const a of assets) {
		yield* fs.makeDirectory(dirname(join(dir, 'assets', a.path)), { recursive: true });
		yield* fs.copyFile(join(assetDir, a.path), join(dir, 'assets', a.path));
		h.update(`assets/${a.path}\0${a.sha256}\0`);
	}
	h.update(`start\0${JSON.stringify(start)}`);
	const meta: PackJson = { format: 1, name, hash: h.digest('hex'), start, rows: counts, assets };
	yield* fs.writeFileString(join(dir, 'pack.json'), `${JSON.stringify(meta, null, '\t')}\n`);
	return meta;
});

/** The bank the `base` pack is read with: none. A reader that needs its bank checks `has` first. */
const noBank: BankReader = {
	tree: '',
	has: () => false,
	files: () => [],
	json: (p) => {
		throw new Error(
			`the base pack reads no bank (asked for '${p}'); guard bank reads with bank.has()`
		);
	},
	bytes: (p) => {
		throw new Error(
			`the base pack reads no bank (asked for '${p}'); guard bank reads with bank.has()`
		);
	}
};

/**
 * The `base` pack (always, possibly empty) and, with `bank` (a bank checkout), the `sample` pack of the tree `seed.ts`
 * names, or the tree `tree` names when there is no `seed.ts`. hook:packaging-ui — with a `seed.ts`, the base pack is
 * its rows over no bank (the template's public seed files through the same conversion as the sample); without one,
 * the `seed/**` files as they are.
 */
export const buildPacks = Effect.fn('bolt.buildPacks')(function* (
	root: string,
	m: EngineManifest,
	files: SeedRows,
	out: string,
	options: { bank?: string; tree?: string; cache: string },
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const packs: { [pack: string]: PackJson } = {};
	const hasReader = yield* fs.exists(join(root, 'seed/seed.ts'));
	const source = hasReader
		? yield* seedSource(root, options.cache).pipe(
				Effect.catch((e) => {
					errors.push({
						code: 'seed/reader',
						path: 'seed/seed.ts',
						message: `seed/seed.ts: ${e.message}`
					});
					return Effect.succeed(undefined);
				})
			)
		: undefined;
	const read = (bank: BankReader) =>
		Effect.tryPromise({
			try: () => Promise.resolve(source?.rows(bank)),
			catch: (cause) => new SeedSourceError({ cause })
		}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Rows)));
	let baseRows: SeedRows | undefined = files;
	if (source !== undefined)
		baseRows = yield* read(noBank).pipe(
			Effect.catch((e) => {
				errors.push({
					code: 'seed/reader',
					path: 'seed/seed.ts',
					message: `seed/seed.ts (base pack, no bank): ${e.message}`
				});
				return Effect.succeed(undefined);
			})
		);
	const base =
		baseRows === undefined
			? undefined
			: yield* writePack(
					out,
					'base',
					m,
					baseRows,
					[],
					yield* assetList(root, errors),
					join(root, 'seed/assets'),
					errors
				);
	if (base !== undefined) packs['base'] = base;
	const tree = source?.bank ?? options.tree;
	if (tree === undefined && (source !== undefined || !hasReader))
		yield* fs.remove(join(out, 'sample'), { recursive: true, force: true });
	if (options.bank === undefined) return packs;
	if (tree === undefined) {
		errors.push({
			code: 'seed/bank',
			path: 'seed',
			message:
				'a bank was given but no tree: seed/seed.ts names none and the template declares no bank'
		});
		return packs;
	}
	const directory = join(options.bank, tree);
	if (!(yield* fs.exists(directory)) || (yield* fs.stat(directory)).type !== 'Directory') {
		errors.push({
			code: 'seed/bank',
			path: 'seed',
			message: `the bank at ${options.bank} has no tree '${tree}'`
		});
		return packs;
	}
	const reader = bankReader(options.bank, tree);
	const readRows = yield* (
		source === undefined
			? Effect.try({
					try: () => defaultRows(reader),
					catch: (cause) => new SeedSourceError({ cause })
				})
			: read(reader)
	).pipe(Effect.result);
	if (Result.isFailure(readRows)) {
		errors.push({
			code: 'seed/reader',
			path: 'seed/seed.ts',
			message: `reading bank tree '${tree}': ${readRows.failure.message}`
		});
		return packs;
	}
	const rows = readRows.success;
	const sample = yield* writePack(
		out,
		'sample',
		m,
		rows,
		source?.start ?? [],
		yield* bankAssets(assetRefs(m, rows), directory, errors),
		directory,
		errors
	);
	if (sample !== undefined) packs['sample'] = sample;
	return packs;
});
