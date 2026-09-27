/// <reference types="node" />
// A host's reading of the artifact (rule 69), without the build toolchain: `@norbital-ai/bolt/artifact`. `bolt build`
// writes what this reads (index.ts).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, FilesPort, RowData, TenantDb } from '../../engine/contracts.ts';
import { BoltError } from '../../engine/contracts.ts';
import type { WorkspacePort } from '../../engine/agent/tools.ts';
import { SNAPSHOT_PRELUDE } from '../../engine/guest/prelude.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';
import { fingerprint, schemaSlice } from '../../engine/schema/plan.ts';
import { loadPack, type Pack } from '../../engine/write/pack.ts';

export type ArtifactJson = {
	format: 1;
	/** The engine contract this artifact was built against (§2.3 decision 5); a host refuses one it does not implement. */
	contract: string;
	/** The tenant handle (`norbital.template.json` `key`, else the directory name) and the display name. */
	handle: string; name: string;
	/** The schema fingerprint `plan`/`applyPlan` record (rule 69). */
	schema: string;
	/** Collections that attach a transform body (the manifest strips bodies). */
	transforms: readonly string[];
	client: { entry: string; css: readonly string[] };
	/** sha256 of manifest.json, guest.mjs and every client file; `hash` covers all of it. */
	hashes: { manifest: string; guest: string; client: string };
	/** `guest.snapshot` (snapshot.ts): the host it restores on (`SNAPSHOT_KEY`) and its sha256; absent when V8 refused it. */
	snapshot?: { key: string; sha: string };
	hash: string;
};
export type Artifact = { dir: string; artifact: ArtifactJson; manifest: EngineManifest; guest: GuestProgram; transforms: readonly string[]; client: string };

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
// hook:cli-kit — a path join: a DOM test environment's transform rewrites `new URL(…, import.meta.url)` to an asset
const PKG = JSON.parse(readFileSync(join(fileURLToPath(import.meta.url), '../../../../package.json'), 'utf8')) as { name: string; version: string };
// ponytail: the digest is of the package release, not yet of the C1 JSON Schema + C2 ABI descriptor (§2.3 decision 5);
// switch when those descriptors exist as files. A host implements a set of these.
export const CONTRACT = sha(`${PKG.name}@${PKG.version}`);
const IVM = (createRequire(import.meta.url)('isolated-vm/package.json') as { version: string }).version;
/** A V8 snapshot restores only on the V8 build that made it (another one aborts the process), and holds the prelude it was made with. */
export const SNAPSHOT_KEY = `v8 ${process.versions.v8} isolated-vm ${IVM} ${process.platform}-${process.arch} prelude ${sha(SNAPSHOT_PRELUDE).slice(0, 12)}`;

function tree(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
		.map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/')).sort() : [];
}
export const treeHash = (dir: string) => sha(tree(dir).map((f) => `${f}\0${sha(readFileSync(join(dir, f)))}`).join('\n'));
/** `hash`: the body with the assets, skills and workspace source (`types.json` is derived from that source). */
export const artifactHash = (dir: string, body: Omit<ArtifactJson, 'hash'>) =>
	sha(JSON.stringify([body, treeHash(join(dir, 'assets')), treeHash(join(dir, 'skills')), treeHash(join(dir, 'workspace', 'src'))]));

/**
 * Activation's reading of an artifact (rule 69): refuses a contract this engine does not implement, a manifest whose
 * schema is not the one recorded, and (L-BOLT-903) any file whose digest is not the recorded one — the manifest, the
 * guest, the client tree, and through `hash` the assets, skills and workspace source.
 */
export function readArtifact(dir: string, contracts: readonly string[] = [CONTRACT]): Artifact {
	const file = join(dir, 'artifact.json');
	if (!existsSync(file)) throw new BoltError('notFound', 'admission', `${dir} holds no artifact.json; run bolt build`);
	const artifact = JSON.parse(readFileSync(file, 'utf8')) as ArtifactJson;
	if (!contracts.includes(artifact.contract))
		throw new BoltError('contract', 'admission', `the artifact was built for engine contract ${artifact.contract.slice(0, 12)}…, which this host does not implement; rebuild it`);
	const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
	const manifest = JSON.parse(manifestText) as EngineManifest;
	if (fingerprint(schemaSlice(manifest)) !== artifact.schema) throw new BoltError('schemaMismatch', 'admission', 'manifest.json does not match the artifact schema hash');
	const map = join(dir, 'guest.mjs.map');
	const guest: GuestProgram = { source: readFileSync(join(dir, 'guest.mjs'), 'utf8'), ...(existsSync(map) ? { sourceMap: readFileSync(map, 'utf8') } : {}) };
	const assets = join(dir, 'guest-assets');
	if (existsSync(assets)) guest.assets = Object.fromEntries(readdirSync(assets).map((hash) => {
		const bytes = new Uint8Array(readFileSync(join(assets, hash)));
		if (sha(bytes) !== hash) throw new BoltError('corrupt', 'admission', `the artifact's server asset ${hash.slice(0, 12)}… does not match its sha256; rebuild it`);
		return [hash, bytes];
	}));
	const { format, contract, handle, name, schema, transforms, client, hashes, snapshot } = artifact;
	// a snapshot built for another host is not read; this host evaluates guest.mjs per invocation instead
	if (snapshot?.key === SNAPSHOT_KEY) guest.snapshot = new Uint8Array(readFileSync(join(dir, 'guest.snapshot')));
	const actual = { manifest: sha(manifestText), guest: sha(guest.source), client: treeHash(join(dir, 'client')) };
	const bad = (Object.keys(actual) as (keyof typeof actual)[]).find((k) => hashes?.[k] !== actual[k])
		?? (guest.snapshot !== undefined && sha(guest.snapshot) !== snapshot?.sha ? 'snapshot' : undefined)
		?? (artifactHash(dir, { format, contract, handle, name, schema, transforms, client, hashes, ...(snapshot === undefined ? {} : { snapshot }) }) === artifact.hash ? undefined : 'hash');
	if (bad !== undefined) throw new BoltError('artifactDigest', 'admission', `the artifact's ${bad} does not match its recorded digest; rebuild it`);
	return { dir, artifact, manifest, guest, transforms: artifact.transforms, client: join(dir, 'client') };
}

/**
 * The artifact's `workspace/` (the source `bolt build` copied and its `types.json`) as the agent's workspace port; `undefined`
 * for an artifact built without one. A path never leaves the directory.
 */
export function workspaceFiles(artifactDir: string): WorkspacePort | undefined {
	const dir = resolve(artifactDir, 'workspace');
	if (!existsSync(dir)) return undefined;
	const list = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name !== 'types.json')
		.map((d) => relative(dir, join(d.parentPath, d.name)).split(sep).join('/')).sort();
	const types = existsSync(join(dir, 'types.json')) ? (JSON.parse(readFileSync(join(dir, 'types.json'), 'utf8')) as { entries: Awaited<ReturnType<WorkspacePort['types']>> }).entries : null;
	return {
		files: async () => list,
		read: async (path) => list.includes(path) ? readFileSync(join(dir, path), 'utf8') : null,
		types: async () => types,
	};
}

/** A seed row's `file` value names a pack asset as `{ asset: '<path under assets/>' }` (or an array of them). */
export const assetPath = (v: unknown): string | undefined =>
	typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { asset?: unknown }).asset === 'string' ? (v as { asset: string }).asset : undefined;
const uuidOf = (s: string) => { const h = sha(s); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

/**
 * `loadPack` (rule 70) with the pack's assets: each `{ asset }` value of a `file` field becomes the `FileRef` of a
 * `sys_file` row (one per collection, field and asset; ids derived, so a reload is the same), and each asset's bytes are
 * put in the files store once. Nothing is stored when the database already had rows.
 */
export async function loadPackWithAssets(db: TenantDb, m: EngineManifest, pack: Pack, files: FilesPort, now: string): Promise<boolean> {
	const assets = new Map(pack.meta.assets.map((a) => [a.path, a]));
	const refs = new Map<string, { field: string; path: string }>();
	const toRef = (c: string, f: string, v: Json): Json => {
		const path = assetPath(v);
		if (path === undefined) return v;
		const a = assets.get(path);
		if (a === undefined) throw new BoltError('seedDecode', 'decode', `seed ${c}.${f}: the pack has no asset '${path}'`);
		const id = uuidOf(`${c}.${f}\0${path}`);
		refs.set(id, { field: `${c}.${f}`, path });
		return { id, name: basename(path), mime: a.contentType, bytes: a.bytes, sha256: a.sha256 }; // hook:runtime — a seeded FileRef carries its size
	};
	const rows = Object.fromEntries(Object.entries(pack.rows).map(([c, list]) => {
		const fileFields = Object.entries(m.models[c]?.fields ?? {}).filter(([, k]) => k.kind === 'file').map(([f]) => f);
		return [c, fileFields.length === 0 ? list : list.map((r) => {
			const out: { [f: string]: Json } = { ...r };
			for (const f of fileFields) if (out[f] !== undefined) out[f] = Array.isArray(out[f]) ? out[f].map((x) => toRef(c, f, x)) : toRef(c, f, out[f]);
			return out as RowData;
		})];
	}));
	if (!(await loadPack(db, m, { ...pack, rows }, now))) return false;
	if (refs.size === 0) return true;
	const keys = new Map<string, string>();
	const list: { id: string; name: string; mime: string; size: number; key: string; sha256: string; field: string }[] = [];
	for (const [id, { field, path }] of refs) {
		const a = assets.get(path)!;
		let key = keys.get(path);
		if (key === undefined) {
			key = (await files.put(readFileSync(join(pack.dir, 'assets', path)), { name: basename(path), mime: a.contentType }, AbortSignal.timeout(60_000))).key;
			keys.set(path, key);
		}
		list.push({ id, name: basename(path), mime: a.contentType, size: a.bytes, key, sha256: a.sha256, field });
	}
	await db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at)
		SELECT x.id, x.name, x.mime, x.size, x.key, x.sha256, x.field, $2::timestamptz
		FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, mime text, size int, key text, sha256 text, field text) ON CONFLICT (id) DO NOTHING`,
	params: [JSON.stringify(list), now] });
	return true;
}
