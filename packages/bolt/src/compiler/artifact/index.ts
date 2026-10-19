/// <reference types="node" />
// The one artifact (§2.3 decision 2): `bolt build` writes `artifact.json`, `manifest.json` (C1, pure data), `schema.sql`,
// `guest.mjs` (tenant code only) with its `guest-assets/<sha256>`, `client/**`, `assets/**`, `skills/**` and `workspace/**` (the source and its type index, the
// agent's `workspace_search` and `workspace_type`) into `.norbital/artifact/`; seed packs are its
// sibling (`.norbital/seed/<pack>/`) with their own hashes. Every host activates through `readArtifact`.
import { Effect, FileSystem, Path, Schema } from 'effect';
import { TemplateManifest } from '../../protocol/schema.ts';
import { join } from 'node:path';
import type { EngineManifest } from '../../engine/manifest.ts';
import type { GuestProgram } from '../../engine/guest/runner.ts';
import { fingerprint, plan, schemaSlice } from '../../engine/schema/plan.ts';
import { RANK } from '../../engine/schema/ddl.ts';
import type { CheckResult } from '../check/index.ts';
import type { Discovered } from '../discover.ts';
import { buildClient, BuildError } from './client.ts';
import { buildServerPages } from './server.ts';
import { artifactHash, CONTRACT, treeHash, type ArtifactJson } from '../../engine/artifact/read.ts';
import { sha256Hex } from '../../engine/write/sql.ts';
import type { TypeIndex } from './types.ts';

export {
	CONTRACT,
	activationRequirements,
	loadPackWithAssets,
	readArtifact,
	workspaceFiles,
	type Artifact,
	type ArtifactJson
} from '../../engine/artifact/read.ts';

/** The template's catalogue metadata when present (`key` and `name`). */
export const templateMeta = Effect.fn('bolt.templateMeta')(function* (root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(root, 'norbital.template.json');
	if (!(yield* fs.exists(file))) return { handle: path.basename(root), name: path.basename(root) };
	const t = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(TemplateManifest))(
		yield* fs.readFileString(file)
	);
	const bank = t.seed?.bankTree;
	return {
		handle: t.key,
		name: t.name,
		...(bank === undefined ? {} : { bank })
	};
});

/** `schema.sql`: the plan from an empty database, in apply order (review aid; hosts apply `plan`, rule 69). */
export function schemaSql(m: EngineManifest): string {
	const creates = plan(null, m)
		.steps.flatMap((s) => (s.create === null ? [] : [s.create]))
		.sort((a, b) => RANK[a.rank] - RANK[b.rank]);
	return `${creates.flatMap((o) => o.create.map((s) => `${s.trim().replace(/;?$/, ';')}`)).join('\n\n')}\n`;
}

/**
 * Writes the artifact of a clean `check` into `out` (replaced whole); `types` is the checker's index when the type stage ran.
 */
export const writeArtifact = Effect.fn('bolt.writeArtifact')(function* (
	root: string,
	c: CheckResult & { manifest: EngineManifest; guest: GuestProgram },
	files: readonly Discovered[],
	out: string,
	types?: TypeIndex
) {
	const fs = yield* FileSystem.FileSystem;
	const meta = yield* templateMeta(root);
	yield* fs.remove(out, { recursive: true, force: true });
	yield* fs.makeDirectory(out, { recursive: true });
	const manifestText = `${JSON.stringify(c.manifest, null, '\t')}\n`;
	yield* fs.writeFileString(join(out, 'manifest.json'), manifestText);
	yield* fs.writeFileString(join(out, 'guest.mjs'), c.guest.source);
	if (c.guest.sourceMap !== undefined)
		yield* fs.writeFileString(join(out, 'guest.mjs.map'), c.guest.sourceMap);
	// `?bytes` imports (§5.8), by sha256; server-only, never under the browser-served `assets/`. guest.mjs names each sha, so its hash covers them
	for (const [hash, bytes] of Object.entries(c.guest.assets ?? {})) {
		yield* fs.makeDirectory(join(out, 'guest-assets'), { recursive: true });
		yield* fs.writeFile(join(out, 'guest-assets', hash), bytes);
	}
	yield* fs.writeFileString(join(out, 'schema.sql'), schemaSql(c.manifest));
	const builtClient = yield* buildClient(root, files, c.manifest, join(out, 'client'), meta.name);
	const serverPages = yield* buildServerPages(root, files, c.manifest, out);
	const pages: Record<string, ArtifactJson['pages'][string]> = {};
	for (const [route, server] of Object.entries(serverPages)) {
		const client = builtClient.pages[route];
		if (client === undefined)
			return yield* new BuildError({
				cause: new Error(`Public page ${route} has no browser entry`)
			});
		pages[route] = { ...client, server };
	}
	const client = { entry: builtClient.entry, css: builtClient.css };
	if (yield* fs.exists(join(root, 'assets')))
		yield* fs.copy(join(root, 'assets'), join(out, 'assets'));
	for (const f of files.filter((x) => x.role === 'skill')) {
		yield* fs.makeDirectory(join(out, 'skills'), { recursive: true });
		yield* fs.copyFile(join(root, f.path), join(out, 'skills', `${f.name}.md`));
	}
	yield* fs.copy(join(root, 'src'), join(out, 'workspace', 'src'));
	for (const file of yield* fs.readDirectory(join(out, 'workspace', 'src'), { recursive: true }))
		if (/\.(test|spec)\.ts$/.test(file)) yield* fs.remove(join(out, 'workspace', 'src', file));
	if (types !== undefined)
		yield* fs.writeFileString(
			join(out, 'workspace', 'types.json'),
			`${JSON.stringify(types, null, '\t')}\n`
		);
	const hashes = {
		manifest: sha256Hex(manifestText),
		guest: sha256Hex(c.guest.source),
		client: yield* treeHash(join(out, 'client')),
		server: yield* treeHash(join(out, 'server'))
	};
	const body = {
		format: 1 as const,
		contract: CONTRACT,
		handle: meta.handle,
		name: meta.name,
		schema: fingerprint(schemaSlice(c.manifest)),
		transforms: [...c.transforms].sort(),
		projections: [...c.projections].sort(),
		client,
		pages,
		hashes
	};
	const artifact: ArtifactJson = { ...body, hash: yield* artifactHash(out, body) };
	yield* fs.writeFileString(
		join(out, 'artifact.json'),
		`${JSON.stringify(artifact, null, '\t')}\n`
	);
	return artifact;
});

export {
	buildPacks,
	loadPack,
	readPack,
	type BankReader,
	type Pack,
	type PackJson,
	type SeedRows,
	type SeedSource
} from './seed.ts';
