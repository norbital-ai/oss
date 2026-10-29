/// <reference types="node" />
// Seed packs (rule 70, docs/seeding.md): the public `base` pack from `seed/public/**` and the `test` pack from
// `seed/test/**`, rows as stored (the template's own tests seed from `test`; no host provisions it). A pack is a sibling of the artifact with its own hash: `pack.json`, `rows/<model>.jsonl`,
// `assets/**`. A bank tree's private `rows/**` are never a pack: `seedRows` reads them into memory for `bolt seed`.
import { createHash } from 'node:crypto';
import { Effect, FileSystem, Predicate, Result, Schema } from 'effect';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, type Rolldown } from 'vite';
import type { Json, EngineManifest } from '@norbital-ai/bolt/engine';
import { decodeSeed, type PackJson } from '@norbital-ai/bolt/engine';
import { decodeIdentity, IDENTITY, type SeedAsset } from '@norbital-ai/bolt/tooling';
import type { CheckDiagnostic } from '../check/index.ts';
import { assetPath } from '@norbital-ai/bolt/artifact';
import { rowsIn, seedPack } from '../seed.ts';
import { BOLT, EXT } from '../bolt.ts';
import { sha256Hex } from '@norbital-ai/store';

/** Rows per model, the identity rows (`sys_user`, run-time `sys_integration` instances) included, as JSON. */
export type SeedRows = {
	readonly [model: string]: readonly { readonly [field: string]: Json }[];
};

// hook:cli-kit — Bolt's root module, src or the published build (`bolt.ts`)
const BOLT_INDEX = join(BOLT, `index${EXT}`);
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
const Source = Schema.Struct({
	bank: Schema.optionalKey(
		Schema.Struct({ tree: Schema.String, start: Schema.optionalKey(Schema.Array(Schema.String)) })
	)
});

/** Imports `seed/+seeder.ts` through the bundler (it may import template modules the node loader cannot). */
const seederOf = Effect.fn('bolt.seederOf')(function* (root: string, cache: string) {
	const fs = yield* FileSystem.FileSystem;
	const built = yield* Effect.tryPromise({
		try: () =>
			build({
				configFile: false,
				logLevel: 'silent',
				root,
				resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT_INDEX }] },
				build: {
					write: false,
					ssr: join(root, 'seed/+seeder.ts'),
					rolldownOptions: {
						output: {
							format: 'es',
							entryFileNames: 'seed.mjs',
							codeSplitting: false,
							// a reader may import model modules for their declared fields: their bodies never run here
							banner: "globalThis[Symbol.for('norbital.bolt.seedBuild')]=true;"
						}
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
	// content-addressed, written whole: a concurrent run (a test worker) never imports a half-written bundle
	if (!(yield* fs.exists(file))) {
		const part = `${file}.${process.pid}.${Date.now()}`;
		yield* fs.writeFileString(part, chunk.code);
		yield* fs.rename(part, file);
	}
	const mod = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(pathToFileURL(file).href),
		catch: (cause) => new SeedSourceError({ cause })
	});
	return yield* Schema.decodeUnknownEffect(Source)(
		Predicate.isObject(mod) ? mod['default'] : undefined
	).pipe(Effect.mapError((cause) => new SeedSourceError({ cause })));
});

/** `<dir>/assets.json` (`{ path, sha256, bytes, contentType }`) checked against `<dir>/assets/**` (rule 70). */
const assetList = Effect.fn('bolt.seedAssets')(function* (
	root: string,
	dir: 'seed/public' | 'seed/test',
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const file = join(root, dir, 'assets.json');
	if (!(yield* fs.exists(file))) return [];
	const list = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Asset)))(
		yield* fs.readFileString(file)
	);
	const ok: SeedAsset[] = [];
	for (const a of list) {
		const path = join(root, dir, 'assets', a.path);
		const fail = (message: string) =>
			errors.push({
				code: 'seed/asset',
				path: `${dir}/assets/${a.path}`,
				message: `${dir}/assets/${a.path}: ${message}`
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
/** A bank tree's files the private rows name, as pack assets (their facts computed here; the bank is read, never written). */
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

/** A pack's rows decoded against the manifest, its `start` automations and its assets checked; `false` on any error. */
function checkPack(
	name: string,
	m: EngineManifest,
	rows: SeedRows,
	start: readonly string[],
	assets: readonly SeedAsset[],
	errors: CheckDiagnostic[]
): boolean {
	const before = errors.length;
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
		return false;
	}

	for (const c of Object.keys(rows))
		if (c.startsWith('sys_') && !(IDENTITY as readonly string[]).includes(c))
			errors.push({
				code: 'seed/decode',
				path,
				message: `${path}: only ${IDENTITY.join(', ')} are seeded among system exposures, not '${c}'`
			});
	for (const p of assetRefs(m, rows))
		if (!assets.some((a) => a.path === p))
			errors.push({
				code: 'seed/asset',
				path,
				message: `${path}: a row names the asset '${p}', which the pack does not carry`
			});
	return errors.length === before;
}

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
	if (!checkPack(name, m, rows, start, assets, errors)) return undefined;
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

/**
 * The `test` pack: `seed/test/**` rows and `seed/test/assets*` as authored, no seeder and no bank. Without a
 * `seed/test/` directory there is none (an earlier one is removed). The kit builds it the same way.
 */
export const buildTestPack = Effect.fn('bolt.buildTestPack')(function* (
	root: string,
	m: EngineManifest,
	out: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	if (!(yield* fs.exists(join(root, 'seed/test')))) {
		yield* fs.remove(join(out, 'test'), { recursive: true, force: true });
		return undefined;
	}
	return yield* writePack(
		out,
		'test',
		m,
		yield* seedPack(root, errors, 'test'),
		[],
		yield* assetList(root, 'seed/test', errors),
		join(root, 'seed/test/assets'),
		errors
	);
});

/** The template's seeder (`seed/+seeder.ts`), none without one; a seeder that cannot load is a `seed/seeder` error. */
const loadSeeder = Effect.fn('bolt.loadSeeder')(function* (
	root: string,
	cache: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	if (!(yield* fs.exists(join(root, 'seed/+seeder.ts')))) return undefined;
	return yield* seederOf(root, cache).pipe(
		Effect.catch((e) => {
			errors.push({
				code: 'seed/seeder',
				path: 'seed/+seeder.ts',
				message: `seed/+seeder.ts: ${e.message}`
			});
			return Effect.succeed(null);
		})
	);
});
/** `bolt check`'s public rows (`seed/public/**`) decoded as the `base` pack is; the seeder loads, or it is an error. */
export const publicSeed = Effect.fn('bolt.publicSeed')(function* (
	root: string,
	m: EngineManifest,
	cache: string,
	errors: CheckDiagnostic[]
) {
	if ((yield* loadSeeder(root, cache, errors)) === null) return undefined;
	const rows = yield* seedPack(root, errors);
	return rows !== undefined &&
		checkPack('base', m, rows, [], yield* assetList(root, 'seed/public', errors), errors)
		? rows
		: undefined;
});

/** The `base` pack (always, possibly empty) and the `test` pack when `seed/test/` exists. A release carries `base`. */
export const buildPacks = Effect.fn('bolt.buildPacks')(function* (
	root: string,
	m: EngineManifest,
	out: string,
	errors: CheckDiagnostic[]
) {
	const packs: { [pack: string]: PackJson } = {};
	const base = yield* writePack(
		out,
		'base',
		m,
		yield* seedPack(root, errors),
		[],
		yield* assetList(root, 'seed/public', errors),
		join(root, 'seed/public/assets'),
		errors
	);
	if (base !== undefined) packs['base'] = base;
	const test = yield* buildTestPack(root, m, out, errors);
	if (test !== undefined) packs['test'] = test;
	return packs;
});

/** What `bolt seed` sends: the public and private rows together, each named asset with a reader of its bytes. */
export type Seeding = {
	readonly tree: string;
	readonly rows: SeedRows;
	readonly start: readonly string[];
	readonly assets: readonly SeedAsset[];
	readonly bytes: (path: string) => Uint8Array;
};
/**
 * The rows `bolt seed` loads into one environment, read into memory from `bank` (a bank checkout): the public rows,
 * then the seeder's bank tree's `rows/**\/<model>.json`, decoded as a pack is.
 * Null when its seeder names no bank tree; undefined, with `errors`, when any row or asset is refused.
 */
export const seedRows = Effect.fn('bolt.seedRows')(function* (
	root: string,
	m: EngineManifest,
	bank: string,
	cache: string,
	errors: CheckDiagnostic[]
) {
	const fs = yield* FileSystem.FileSystem;
	const seeder = yield* loadSeeder(root, cache, errors);
	if (seeder === null) return undefined;
	if (seeder?.bank === undefined) return null;
	const { tree, start = [] } = seeder.bank;
	const directory = join(bank, tree);
	if (!(yield* fs.exists(directory)) || (yield* fs.stat(directory)).type !== 'Directory') {
		errors.push({
			code: 'seed/bank',
			path: 'seed',
			message: `the bank at ${bank} has no tree '${tree}'`
		});
		return undefined;
	}
	const base = yield* seedPack(root, errors);
	const own = yield* rowsIn(join(directory, 'rows'), `${tree}/rows`, errors);
	if (errors.length > 0) return undefined;
	const rows: { [c: string]: SeedRows[string] } = { ...base };
	for (const [c, list] of Object.entries(own)) rows[c] = [...(rows[c] ?? []), ...list];
	const shipped = yield* assetList(root, 'seed/public', errors);
	const publicPaths = new Set(shipped.map((a) => a.path));
	const banked = yield* bankAssets(
		[...assetRefs(m, rows)].filter((p) => !publicPaths.has(p)),
		directory,
		errors
	);
	const assets = [...shipped, ...banked];
	if (!checkPack('private', m, rows, start, assets, errors)) return undefined;
	return {
		tree,
		rows,
		start,
		assets,
		bytes: (path: string) =>
			readFileSync(join(publicPaths.has(path) ? join(root, 'seed/public/assets') : directory, path))
	} satisfies Seeding;
});
