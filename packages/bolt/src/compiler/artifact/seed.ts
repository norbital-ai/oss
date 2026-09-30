/// <reference types="node" />
// Seed packs (rule 70, X-13, X-15, §7.2): the public `base` pack from `seed/**`, and a `sample` pack read from a bank
// tree by the template's `seed/seed.ts` (or, without one, every `<collection>.json` of the tree). A pack is a sibling of
// the artifact with its own hash: `pack.json`, `rows/<collection>.jsonl`, `assets/**`. Loading one is a restore.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type Rollup } from 'vite';
import type { AutomationName } from '../../decl/names.ts';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, RowData, TenantDb } from '../../engine/contracts.ts';
import { decodeSeed, type SeedPack } from '../../engine/write/seed.ts';
import { IDENTITY, type PackJson, type SeedAsset } from '../../engine/write/pack.ts';
import type { CheckDiagnostic } from '../check/index.ts';
import { assetPath } from './read.ts';

/** Rows per collection, identity stages (`sys_team`, `sys_user`) included. */
export type SeedRows = { readonly [collection: string]: readonly { readonly [field: string]: Json }[] };
/** One bank tree, read-only (memory `do-not-alter-source-material`). Paths are relative to the tree. */
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
export { loadPack, readPack, type Pack, type PackJson, type SeedAsset } from '../../engine/write/pack.ts';

// hook:cli-kit — a path join: a DOM test environment's transform rewrites `new URL(…, import.meta.url)` to an asset
const BOLT = join(dirname(fileURLToPath(import.meta.url)), '../..', `index${extname(fileURLToPath(import.meta.url))}`);
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export function bankReader(root: string, tree: string): BankReader {
	const base = join(root, tree);
	const at = (p: string) => join(base, p);
	return {
		tree,
		has: (p) => existsSync(at(p)),
		json: (p) => JSON.parse(readFileSync(at(p), 'utf8')),
		bytes: (p) => readFileSync(at(p)),
		files: (dir = '') => existsSync(at(dir))
			? readdirSync(at(dir), { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
				.map((d) => relative(base, join(d.parentPath, d.name)).split(sep).join('/')).sort()
			: [],
	};
}

/**
 * Without a `seed.ts`: every top-level `<name>.json` of the tree is that collection's rows, and the bank's identity
 * stages become `sys_team` / `sys_user` as §7.2 maps them (`status: 'admin'` → admin, `team_id` → team).
 */
export function defaultRows(bank: BankReader): SeedRows {
	const out: { [c: string]: { readonly [f: string]: Json }[] } = {};
	for (const file of bank.files().filter((f) => /^[^/]+\.json$/.test(f))) {
		const name = file.slice(0, -'.json'.length);
		const rows = bank.json<{ [f: string]: Json }[]>(file);
		if (name === 'team') out['sys_team'] = rows.map((r) => ({ id: r['id']!, name: r['name']!, parent: r['parent_id'] ?? r['parent'] ?? null }));
		else if (name === 'user') out['sys_user'] = rows.map((r) => ({ id: r['id']!, name: r['name']!, email: r['email'] ?? null, ...(r['phone'] == null ? {} : { phone: r['phone'] }), kind: 'staff',
			admin: r['status'] === 'admin', team: r['team_id'] ?? r['team'] ?? null }));
		else out[name] = rows;
	}
	return out;
}

/** Imports `seed/seed.ts` through the bundler (it may import template modules the node loader cannot). */
async function seedSource(root: string, cache: string): Promise<SeedSource> {
	const out = await build({ configFile: false, logLevel: 'silent', root, resolve: { alias: [{ find: /^@norbital-ai\/bolt$/, replacement: BOLT }] },
		build: { write: false, ssr: join(root, 'seed/seed.ts'), rollupOptions: { output: { format: 'es', entryFileNames: 'seed.mjs', codeSplitting: false } } } }) as Rollup.RollupOutput;
	const chunk = out.output.find((o): o is Rollup.OutputChunk => o.type === 'chunk')!;
	const file = join(cache, `seed-${sha(chunk.code).slice(0, 16)}.mjs`);
	mkdirSync(cache, { recursive: true });
	writeFileSync(file, chunk.code);
	return (await import(pathToFileURL(file).href) as { default: SeedSource }).default;
}

/** `seed/assets.json` (`{ path, sha256, bytes, contentType }`) checked against `seed/assets/**` (rule 70). */
function assetList(root: string, errors: CheckDiagnostic[]): SeedAsset[] {
	const file = join(root, 'seed/assets.json');
	if (!existsSync(file)) return [];
	const list = JSON.parse(readFileSync(file, 'utf8')) as SeedAsset[];
	const ok: SeedAsset[] = [];
	for (const a of list) {
		const path = join(root, 'seed/assets', a.path);
		const fail = (message: string) => errors.push({ code: 'seed/asset', path: `seed/assets/${a.path}`, message: `seed/assets/${a.path}: ${message}` });
		if (!existsSync(path)) { fail('missing'); continue; }
		const bytes = readFileSync(path);
		if (bytes.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs')) { fail('is a Git-LFS pointer; fetch the object'); continue; }
		if (bytes.byteLength !== a.bytes) { fail(`is ${bytes.byteLength} bytes; assets.json says ${a.bytes}`); continue; }
		if (sha(bytes) !== a.sha256) { fail('sha256 does not match assets.json'); continue; }
		ok.push(a);
	}
	return ok;
}

/** Every asset path the rows' `file` values name (`{ asset }`, read.ts). */
function assetRefs(m: EngineManifest, rows: SeedRows): Set<string> {
	const out = new Set<string>();
	for (const [c, list] of Object.entries(rows)) for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) {
		if (k.kind !== 'file') continue;
		for (const r of list) for (const v of [r[f]].flat()) { const p = assetPath(v); if (p !== undefined) out.add(p); }
	}
	return out;
}

const MIME: { readonly [ext: string]: string } = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
	'.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
/** A bank tree's files the sample rows name, as pack assets (their facts computed here; the bank is read, never written). */
function bankAssets(paths: Iterable<string>, dir: string, errors: CheckDiagnostic[]): SeedAsset[] {
	const out: SeedAsset[] = [];
	for (const path of [...paths].sort()) {
		const file = join(dir, path);
		const fail = (message: string) => errors.push({ code: 'seed/asset', path: `bank ${path}`, message: `bank asset ${path}: ${message}` });
		if (!existsSync(file)) { fail('missing'); continue; }
		const bytes = readFileSync(file);
		if (bytes.subarray(0, 40).toString('latin1').startsWith('version https://git-lfs')) { fail('is a Git-LFS pointer; fetch the object'); continue; }
		out.push({ path, sha256: sha(bytes), bytes: bytes.byteLength, contentType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' });
	}
	return out;
}

/** Writes one pack; its hash covers every row file and asset. Decode and `start` errors are build errors. */
function writePack(out: string, name: string, m: EngineManifest, rows: SeedRows, start: readonly string[], assets: readonly SeedAsset[],
	assetDir: string, errors: CheckDiagnostic[]): PackJson | undefined {
	const path = `seed (${name} pack)`;
	for (const a of start) if (m.automations[a] === undefined) errors.push({ code: 'seed/start', path, message: `${path}: start names '${a}', which is no automation of the workspace` });
	try {
		decodeSeed(m, Object.fromEntries(Object.entries(rows).filter(([c]) => !c.startsWith('sys_'))) as SeedPack);
	} catch (e) {
		errors.push({ code: 'seed/decode', path, message: `${path}: ${e instanceof Error ? e.message : String(e)}` });
		return undefined;
	}
	for (const c of Object.keys(rows)) if (c.startsWith('sys_') && !(IDENTITY as readonly string[]).includes(c))
		errors.push({ code: 'seed/decode', path, message: `${path}: only ${IDENTITY.join(' and ')} are seeded among system collections, not '${c}'` });
	for (const p of assetRefs(m, rows)) if (!assets.some((a) => a.path === p))
		errors.push({ code: 'seed/asset', path, message: `${path}: a row names the asset '${p}', which the pack does not carry` });
	const dir = join(out, name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, 'rows'), { recursive: true });
	const h = createHash('sha256');
	const counts: { [c: string]: number } = {};
	for (const c of Object.keys(rows).sort()) {
		const text = rows[c]!.map((r) => JSON.stringify(r)).join('\n') + '\n';
		writeFileSync(join(dir, 'rows', `${c}.jsonl`), text);
		h.update(`rows/${c}\0${text}\0`);
		counts[c] = rows[c]!.length;
	}
	for (const a of assets) {
		mkdirSync(dirname(join(dir, 'assets', a.path)), { recursive: true });
		copyFileSync(join(assetDir, a.path), join(dir, 'assets', a.path));
		h.update(`assets/${a.path}\0${a.sha256}\0`);
	}
	h.update(`start\0${JSON.stringify(start)}`);
	const meta: PackJson = { format: 1, name, hash: h.digest('hex'), start, rows: counts, assets };
	writeFileSync(join(dir, 'pack.json'), `${JSON.stringify(meta, null, '\t')}\n`);
	return meta;
}

/** The bank the `base` pack is read with: none. A reader that needs its bank checks `has` first. */
const noBank: BankReader = {
	tree: '', has: () => false, files: () => [],
	json: (p) => { throw new Error(`the base pack reads no bank (asked for '${p}'); guard bank reads with bank.has()`); },
	bytes: (p) => { throw new Error(`the base pack reads no bank (asked for '${p}'); guard bank reads with bank.has()`); },
};

/**
 * The `base` pack (always, possibly empty) and, with `bank` (a bank checkout), the `sample` pack of the tree `seed.ts`
 * names, or the tree `tree` names when there is no `seed.ts`. hook:packaging-ui — with a `seed.ts`, the base pack is
 * its rows over no bank (the template's public seed files through the same conversion as the sample); without one,
 * the `seed/**` files as they are.
 */
export async function buildPacks(root: string, m: EngineManifest, files: SeedRows, out: string,
	options: { bank?: string; tree?: string; cache: string }, errors: CheckDiagnostic[]): Promise<{ [pack: string]: PackJson }> {
	const packs: { [pack: string]: PackJson } = {};
	const hasReader = existsSync(join(root, 'seed/seed.ts'));
	const source = hasReader ? await seedSource(root, options.cache).catch((e: unknown) => {
		errors.push({ code: 'seed/reader', path: 'seed/seed.ts', message: `seed/seed.ts: ${e instanceof Error ? e.message : String(e)}` });
		return undefined;
	}) : undefined;
	let baseRows: SeedRows | undefined = files;
	if (source !== undefined) baseRows = await Promise.resolve().then(() => source.rows(noBank)).catch((e: unknown) => {
		errors.push({ code: 'seed/reader', path: 'seed/seed.ts', message: `seed/seed.ts (base pack, no bank): ${e instanceof Error ? e.message : String(e)}` });
		return undefined;
	});
	const base = baseRows === undefined ? undefined : writePack(out, 'base', m, baseRows, [], assetList(root, errors), join(root, 'seed/assets'), errors);
	if (base !== undefined) packs['base'] = base;
	if (options.bank === undefined) return packs;
	const tree = source?.bank ?? options.tree;
	if (tree === undefined) {
		errors.push({ code: 'seed/bank', path: 'seed', message: 'a bank was given but no tree: seed/seed.ts names none and the template declares no bank' });
		return packs;
	}
	if (!existsSync(join(options.bank, tree)) || !statSync(join(options.bank, tree)).isDirectory()) {
		errors.push({ code: 'seed/bank', path: 'seed', message: `the bank at ${options.bank} has no tree '${tree}'` });
		return packs;
	}
	const reader = bankReader(options.bank, tree);
	let rows: SeedRows;
	try {
		rows = source === undefined ? defaultRows(reader) : await source.rows(reader);
	} catch (e) {
		errors.push({ code: 'seed/reader', path: 'seed/seed.ts', message: `reading bank tree '${tree}': ${e instanceof Error ? e.message : String(e)}` });
		return packs;
	}
	const sample = writePack(out, 'sample', m, rows, source?.start ?? [], bankAssets(assetRefs(m, rows), join(options.bank, tree), errors), join(options.bank, tree), errors);
	if (sample !== undefined) packs['sample'] = sample;
	return packs;
}
