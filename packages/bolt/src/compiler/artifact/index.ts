/// <reference types="node" />
// The one artifact (§2.3 decision 2): `bolt build` writes `artifact.json`, `manifest.json` (C1, pure data), `schema.sql`,
// `guest.mjs` (tenant code only) with its `guest-assets/<sha256>` and `guest.snapshot` (snapshot.ts), `client/**`, `assets/**`, `skills/**` and `workspace/**` (the source and its type index, the
// agent's `workspace_read` and `workspace_type`) into `.norbital/artifact/`; seed packs are its
// sibling (`.norbital/seed/<pack>/`) with their own hashes. Every host activates through `readArtifact`.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { EngineManifest } from '../../engine/contracts.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';
import { fingerprint, plan, schemaSlice } from '../../engine/schema/plan.ts';
import { RANK } from '../../engine/schema/ddl.ts';
import type { CheckResult } from '../check/index.ts';
import type { Discovered } from '../discover.ts';
import { buildClient } from './client.ts';
import { artifactHash, CONTRACT, sha, SNAPSHOT_KEY, treeHash, type ArtifactJson } from './read.ts';
import { buildSnapshot } from './snapshot.ts';
import type { TypeIndex } from './types.ts';

export { CONTRACT, loadPackWithAssets, readArtifact, type Artifact, type ArtifactJson } from './read.ts';


/** The template's catalogue metadata when present (`key`, `name` as a string or `{ [locale]: string }`). */
export function templateMeta(root: string): { handle: string; name: string; bank?: string } {
	const file = join(root, 'norbital.template.json');
	const t = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as { key?: string; name?: string | { [l: string]: string }; bank?: string; seed?: { bankTree?: string } } : {};
	const name = typeof t.name === 'string' ? t.name : t.name === undefined ? undefined : Object.values(t.name)[0];
	const bank = t.bank ?? t.seed?.bankTree;
	return { handle: t.key ?? basename(root), name: name ?? basename(root), ...(bank === undefined ? {} : { bank }) };
}

/** `schema.sql`: the plan from an empty database, in apply order (review aid; hosts apply `plan`, rule 69). */
export function schemaSql(m: EngineManifest): string {
	const creates = plan(null, m).steps.flatMap((s) => (s.create === null ? [] : [s.create])).sort((a, b) => RANK[a.rank] - RANK[b.rank]);
	return `${creates.flatMap((o) => o.create.map((s) => `${s.trim().replace(/;?$/, ';')}`)).join('\n\n')}\n`;
}

/**
 * Writes the artifact of a clean `check` into `out` (replaced whole); `types` is the checker's index when the type stage ran.
 * `log` hears why V8 refused the guest snapshot, if it did.
 */
export async function writeArtifact(root: string, c: CheckResult & { manifest: EngineManifest; guest: GuestProgram }, files: readonly Discovered[], out: string, types?: TypeIndex,
	log?: (line: string) => void): Promise<ArtifactJson> {
	const meta = templateMeta(root);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const manifestText = `${JSON.stringify(c.manifest, null, '\t')}\n`;
	writeFileSync(join(out, 'manifest.json'), manifestText);
	writeFileSync(join(out, 'guest.mjs'), c.guest.source);
	if (c.guest.sourceMap !== undefined) writeFileSync(join(out, 'guest.mjs.map'), c.guest.sourceMap);
	const snap = buildSnapshot(c.guest);
	if ('bytes' in snap) writeFileSync(join(out, 'guest.snapshot'), snap.bytes);
	else log?.(`no guest snapshot (each invocation evaluates guest.mjs): ${snap.refused}`);
	// `?bytes` imports (§5.8), by sha256; server-only, never under the browser-served `assets/`. guest.mjs names each sha, so its hash covers them
	for (const [hash, bytes] of Object.entries(c.guest.assets ?? {})) {
		mkdirSync(join(out, 'guest-assets'), { recursive: true });
		writeFileSync(join(out, 'guest-assets', hash), bytes);
	}
	writeFileSync(join(out, 'schema.sql'), schemaSql(c.manifest));
	const client = await buildClient(root, files, c.manifest, join(out, 'client'), meta.name);
	if (existsSync(join(root, 'assets'))) cpSync(join(root, 'assets'), join(out, 'assets'), { recursive: true });
	for (const f of files.filter((x) => x.role === 'skill')) {
		mkdirSync(join(out, 'skills'), { recursive: true });
		cpSync(join(root, f.path), join(out, 'skills', `${f.name}.md`));
	}
	cpSync(join(root, 'src'), join(out, 'workspace', 'src'), { recursive: true, filter: (f) => !/\.(test|spec)\.ts$/.test(f) });
	if (types !== undefined) writeFileSync(join(out, 'workspace', 'types.json'), `${JSON.stringify(types, null, '\t')}\n`);
	const hashes = { manifest: sha(manifestText), guest: sha(c.guest.source), client: treeHash(join(out, 'client')) };
	const body = { format: 1 as const, contract: CONTRACT, handle: meta.handle, name: meta.name, schema: fingerprint(schemaSlice(c.manifest)),
		transforms: [...c.transforms].sort(), client, hashes, ...('bytes' in snap ? { snapshot: { key: SNAPSHOT_KEY, sha: sha(snap.bytes) } } : {}) };
	const artifact: ArtifactJson = { ...body, hash: artifactHash(out, body) };
	writeFileSync(join(out, 'artifact.json'), `${JSON.stringify(artifact, null, '\t')}\n`);
	return artifact;
}

export { buildPacks, loadPack, readPack, type BankReader, type Pack, type PackJson, type SeedRows, type SeedSource } from './seed.ts';
