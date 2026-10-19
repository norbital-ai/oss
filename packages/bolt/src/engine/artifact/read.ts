/// <reference types="node" />
// A host's reading of the artifact (rule 69), without the build toolchain: `@norbital-ai/bolt/artifact`. `bolt build`
// writes what this reads (compiler/artifact/index.ts); `artifact.json` and `manifest.json` are decoded here, once (A.4).
import { sha256Hex } from '../write/sql.ts';
import { readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { Effect, FileSystem, Path, Predicate, Result, Schema } from 'effect';
import release from '../../../package.json' with { type: 'json' };
import type { Json } from '../../decl/values.ts';
import type { RowData } from '../contracts.ts';
import { ManifestInvalid } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { Files } from '../ports.ts';
import { decodeManifest, type EngineManifest } from '../manifest.ts';
import type { WorkspacePort } from '../agent/tools.ts';
import type { GuestProgram } from '../guest/runner.ts';
import { fingerprint, schemaSlice } from '../schema/plan.ts';
import { loadPack, type Pack, type SeedAsset } from '../write/pack.ts';

export const ArtifactJsonSchema = Schema.Struct({
	format: Schema.Literal(1),
	/** The engine contract this artifact was built against (§2.3 decision 5); a host refuses one it does not implement. */
	contract: Schema.String,
	/** The tenant handle (`norbital.template.json` `key`, else the directory name) and the display name. */
	handle: Schema.String,
	name: Schema.String,
	/** The schema fingerprint `plan`/`applyPlan` record (rule 69). */
	schema: Schema.String,
	/** Collections that attach a transform body (the manifest strips bodies). */
	transforms: Schema.Array(Schema.String),
	projections: Schema.Array(Schema.String),
	client: Schema.Struct({ entry: Schema.String, css: Schema.Array(Schema.String) }),
	/** Public routes carry their own browser entry and a private, bounded server program. */
	pages: Schema.Record(
		Schema.String,
		Schema.Struct({
			entry: Schema.String,
			css: Schema.Array(Schema.String),
			server: Schema.Struct({ file: Schema.String, sha256: Schema.String })
		})
	),
	/** sha256 of manifest.json, guest.mjs and every client/server file; `hash` covers all of it. */
	hashes: Schema.Struct({
		manifest: Schema.String,
		guest: Schema.String,
		client: Schema.String,
		server: Schema.String
	}),
	/** Historical descriptor data covered by `hash`; native snapshot files are never read or executed. */
	snapshot: Schema.optionalKey(Schema.Struct({ key: Schema.String, sha: Schema.String })),
	hash: Schema.String
});
export type ArtifactJson = typeof ArtifactJsonSchema.Type;
export type Artifact = {
	dir: string;
	artifact: ArtifactJson;
	manifest: EngineManifest;
	guest: GuestProgram;
	transforms: readonly string[];
	projections: readonly string[];
	client: string;
	pages: Readonly<
		Record<
			string,
			{ readonly program: GuestProgram; readonly entry: string; readonly css: readonly string[] }
		>
	>;
};

/** The route namespace keeps a nested app named kiosk/* distinct from a kiosk. Portal chrome does not decide SSR. */
export function publicPageKeys(m: EngineManifest): readonly string[] {
	return [
		...Object.entries(m.apps).flatMap(([name, app]) =>
			(app.audience ?? 'members') === 'members'
				? []
				: Object.keys(app.pages).map((page) => `app/${name}/${page}`)
		),
		...Object.entries(m.kiosks ?? {}).flatMap(([name, kiosk]) =>
			(kiosk.auth ?? 'members') === 'members'
				? []
				: Object.keys(kiosk.pages).map((page) => `kiosk/${name}/${page}`)
		)
	].sort();
}

const Release = Schema.Struct({ name: Schema.String, version: Schema.String });
const PKG = Schema.decodeUnknownSync(Release)(release);
// ponytail: the digest is of the package release, not yet of the C1 JSON Schema + C2 ABI descriptor (§2.3 decision 5);
// switch when those descriptors exist as files. A host implements a set of these.
export const CONTRACT = sha256Hex(`${PKG.name}@${PKG.version}`);

export const tree = Effect.fn('bolt.artifactTree')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	if (!(yield* fs.exists(dir))) return [];
	const files: string[] = [];
	for (const name of yield* fs.readDirectory(dir, { recursive: true }))
		if ((yield* fs.stat(path.join(dir, name))).type === 'File')
			files.push(name.split(path.sep).join('/'));
	return files.sort();
});
export const treeHash = Effect.fn('bolt.artifactTreeHash')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const hashes: string[] = [];
	for (const file of yield* tree(dir))
		hashes.push(`${file}\0${sha256Hex(yield* fs.readFile(path.join(dir, file)))}`);
	return sha256Hex(hashes.join('\n'));
});
export const artifactHash = Effect.fn('bolt.artifactHash')(function* (
	dir: string,
	body: Omit<ArtifactJson, 'hash'>
) {
	const path = yield* Path.Path;
	return sha256Hex(
		JSON.stringify([
			body,
			yield* treeHash(path.join(dir, 'assets')),
			yield* treeHash(path.join(dir, 'skills')),
			yield* treeHash(path.join(dir, 'workspace', 'src'))
		])
	);
});

// `hash` covers the body as written: its nested objects keep their key order
const decodeArtifactJson = Schema.decodeUnknownResult(Schema.fromJsonString(ArtifactJsonSchema), {
	propertyOrder: 'original'
});
/** A file of the artifact, whole; one that cannot be read refuses activation. */
const file = (path: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFile(path)).pipe(
		Effect.mapError((cause) =>
			BoltError.make('notFound', 'admission', `${path} cannot be read; run bolt build`, cause)
		)
	);
const text = (path: string) => Effect.map(file(path), (b) => new TextDecoder().decode(b));

/**
 * Activation's reading of an artifact (rule 69): refuses a contract this engine does not implement, an `artifact.json` or
 * `manifest.json` that does not decode (`ManifestInvalid`), a manifest whose schema is not the one recorded, and
 * (L-BOLT-903) any file whose digest is not the recorded one — the manifest, the guest, the client tree, and through
 * `hash` the assets, skills and workspace source.
 * Historical snapshot metadata remains in the descriptor digest; its native blob is never read or trusted.
 */
export const readArtifact = Effect.fn('bolt.readArtifact')(function* (
	dir: string,
	contracts: readonly string[] = [CONTRACT]
) {
	const fs = yield* FileSystem.FileSystem;
	const at = join(dir, 'artifact.json');
	if (!(yield* fs.exists(at)))
		return yield* BoltError.make(
			'notFound',
			'admission',
			`${dir} holds no artifact.json; run bolt build`
		);
	const artifact = yield* Effect.fromResult(
		decodeArtifactJson(yield* text(at)).pipe(
			Result.mapError((e) => new ManifestInvalid({ issues: e.message.split('\n') }))
		)
	);
	if (!contracts.includes(artifact.contract))
		return yield* BoltError.make(
			'contract',
			'admission',
			`the artifact was built for engine contract ${artifact.contract.slice(0, 12)}…, which this host does not implement; rebuild it`
		);
	const manifestText = yield* text(join(dir, 'manifest.json'));
	const manifest = yield* Effect.fromResult(
		Result.flatMap(
			Result.try({
				try: (): unknown => JSON.parse(manifestText),
				catch: (e) =>
					new ManifestInvalid({
						issues: [`manifest.json: ${e instanceof Error ? e.message : 'not JSON'}`]
					})
			}),
			decodeManifest
		)
	);
	if (fingerprint(schemaSlice(manifest)) !== artifact.schema)
		return yield* BoltError.make(
			'schemaMismatch',
			'admission',
			'manifest.json does not match the artifact schema hash'
		);
	const map = join(dir, 'guest.mjs.map');
	const guest: GuestProgram = {
		source: yield* text(join(dir, 'guest.mjs')),
		...((yield* fs.exists(map)) ? { sourceMap: yield* text(map) } : {})
	};
	const assets = join(dir, 'guest-assets');
	if (yield* fs.exists(assets)) {
		const held: { [hash: string]: Uint8Array } = {};
		for (const hash of yield* fs.readDirectory(assets)) {
			const bytes = new Uint8Array(yield* file(join(assets, hash)));
			if (sha256Hex(bytes) !== hash)
				return yield* BoltError.make(
					'corrupt',
					'admission',
					`the artifact's server asset ${hash.slice(0, 12)}… does not match its sha256; rebuild it`
				);
			held[hash] = bytes;
		}
		guest.assets = held;
	}
	const {
		format,
		contract,
		handle,
		name,
		schema,
		transforms,
		projections,
		client,
		pages,
		hashes,
		snapshot
	} = artifact;
	const actual = {
		manifest: sha256Hex(manifestText),
		guest: sha256Hex(guest.source),
		client: yield* treeHash(join(dir, 'client')),
		server: yield* treeHash(join(dir, 'server'))
	};
	const bad =
		(Object.keys(actual) as (keyof typeof actual)[]).find((k) => hashes[k] !== actual[k]) ??
		((yield* artifactHash(dir, {
			format,
			contract,
			handle,
			name,
			schema,
			transforms,
			projections,
			client,
			pages,
			hashes,
			...(snapshot === undefined ? {} : { snapshot })
		})) === artifact.hash
			? undefined
			: 'hash');
	if (bad !== undefined)
		return yield* BoltError.make(
			'artifactDigest',
			'admission',
			`the artifact's ${bad} does not match its recorded digest; rebuild it`
		);
	const expectedPages = publicPageKeys(manifest);
	if (JSON.stringify(Object.keys(pages).sort()) !== JSON.stringify(expectedPages))
		return yield* BoltError.make(
			'artifactDigest',
			'admission',
			'the artifact must contain exactly the public page programs declared by its manifest; rebuild it'
		);
	const pagePrograms: Record<
		string,
		{ program: GuestProgram; entry: string; css: readonly string[] }
	> = {};
	const canonicalFile = (name: string) =>
		name.length > 0 &&
		!name.includes('\\') &&
		!name.includes('\0') &&
		name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
	const artifactRoot = expectedPages.length === 0 ? '' : yield* fs.realPath(dir);
	const clientRoot = expectedPages.length === 0 ? '' : yield* fs.realPath(join(dir, 'client'));
	const serverRoot = expectedPages.length === 0 ? '' : yield* fs.realPath(join(dir, 'server'));
	if (
		expectedPages.length > 0 &&
		(clientRoot !== join(artifactRoot, 'client') || serverRoot !== join(artifactRoot, 'server'))
	)
		return yield* BoltError.make(
			'artifactDigest',
			'admission',
			'the public page client and server trees must belong to the artifact'
		);
	for (const route of expectedPages) {
		const page = pages[route];
		if (
			page === undefined ||
			!/^(?:app|kiosk)\/(?:[a-z][a-z0-9_]*\/)+[a-z][a-z0-9_]*$/.test(route) ||
			page.server.file !== `server/${route}.mjs` ||
			![page.entry, ...page.css].every(canonicalFile)
		)
			return yield* BoltError.make(
				'artifactDigest',
				'admission',
				`the public page ${route} has an invalid artifact path; rebuild it`
			);
		for (const name of [page.entry, ...page.css, `public/${route}/index.html`]) {
			const actual = yield* fs.realPath(join(dir, 'client', name));
			if (!actual.startsWith(clientRoot + sep) || (yield* fs.stat(actual)).type !== 'File')
				return yield* BoltError.make(
					'artifactDigest',
					'admission',
					`the public page ${route} names a browser file outside its client tree`
				);
		}
		const absolute = yield* fs.realPath(join(dir, page.server.file));
		if (!absolute.startsWith(serverRoot + sep))
			return yield* BoltError.make(
				'artifactDigest',
				'admission',
				`the public page ${route} names a program outside its server tree`
			);
		const source = yield* text(absolute);
		if (sha256Hex(source) !== page.server.sha256)
			return yield* BoltError.make(
				'artifactDigest',
				'admission',
				`the public page ${route} does not match its server program digest; rebuild it`
			);
		const map = `${absolute}.map`;
		const program: GuestProgram = { source };
		if (yield* fs.exists(map)) {
			if (!(yield* fs.realPath(map)).startsWith(serverRoot + sep))
				return yield* BoltError.make(
					'artifactDigest',
					'admission',
					`the public page ${route} names a source map outside its server tree`
				);
			program.sourceMap = yield* text(map);
		}
		const assets = join(dir, `server/${route}.assets`);
		if (yield* fs.exists(assets)) {
			const held: Record<string, Uint8Array> = {};
			for (const hash of yield* fs.readDirectory(assets)) {
				const asset = yield* fs.realPath(join(assets, hash));
				if (!asset.startsWith(serverRoot + sep))
					return yield* BoltError.make(
						'artifactDigest',
						'admission',
						`the public page ${route} names an asset outside its server tree`
					);
				const bytes = new Uint8Array(yield* file(asset));
				if (sha256Hex(bytes) !== hash)
					return yield* BoltError.make(
						'artifactDigest',
						'admission',
						`the public page ${route} has a corrupt server asset; rebuild it`
					);
				held[hash] = bytes;
			}
			program.assets = held;
		}
		pagePrograms[route] = { program, entry: page.entry, css: page.css };
	}
	return {
		dir,
		artifact,
		manifest,
		guest,
		transforms,
		projections,
		client: join(dir, 'client'),
		pages: pagePrograms
	} satisfies Artifact;
});

const TypesJson = Schema.fromJsonString(
	Schema.Struct({
		entries: Schema.Record(
			Schema.String,
			Schema.Struct({
				type: Schema.String,
				docs: Schema.optionalKey(Schema.String),
				source: Schema.optionalKey(Schema.String)
			})
		)
	})
);
/**
 * The artifact's `workspace/` (the source `bolt build` copied and its `types.json`) as the agent's workspace port; `undefined`
 * for an artifact built without one. A path never leaves the directory.
 */
export const workspaceFiles = Effect.fn('bolt.workspaceFiles')(function* (artifactDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = path.resolve(artifactDir, 'workspace');
	if (!(yield* fs.exists(dir))) return undefined;
	const list = (yield* tree(dir)).filter((file) => file !== 'types.json');
	const types = (yield* fs.exists(path.join(dir, 'types.json')))
		? yield* Schema.decodeUnknownEffect(TypesJson)(
				yield* fs.readFileString(path.join(dir, 'types.json'))
			).pipe(Effect.mapError((cause) => new ManifestInvalid({ issues: [cause.message] })))
		: null;
	return {
		// repository-health:allow EFF3 -- WorkspacePort is the host's Promise ABI.
		files: async () => list,
		// repository-health:allow EFF3 -- WorkspacePort is the host's Promise ABI.
		read: async (name) => (list.includes(name) ? readFile(path.join(dir, name), 'utf8') : null),
		// repository-health:allow EFF3 -- WorkspacePort is the host's Promise ABI.
		types: async () => types?.entries ?? null
	} satisfies WorkspacePort;
});

/** A seed row's `file` value names a pack asset as `{ asset: '<path under assets/>' }` (or an array of them). */
export const assetPath = (v: unknown): string | undefined =>
	Predicate.isObject(v) && 'asset' in v && typeof v.asset === 'string' ? v.asset : undefined;
const uuidOf = (s: string) => {
	const h = sha256Hex(s);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

type SeedFile = { field: string; path: string; asset: SeedAsset };
/**
 * The pack's rows with each `{ asset }` value of a `file` field as the `FileRef` of a `sys_file` row (one per collection,
 * field and asset; ids derived, so a reload is the same), and those files by id. An asset the pack lacks refuses the pack.
 */
const seedFiles = (m: EngineManifest, pack: Pack) =>
	Result.gen(function* () {
		const assets = new Map(pack.meta.assets.map((a) => [a.path, a]));
		const files = new Map<string, SeedFile>();
		const ref = (c: string, f: string, v: Json): Result.Result<Json, BoltError> => {
			const path = assetPath(v);
			if (path === undefined) return Result.succeed(v);
			const asset = assets.get(path);
			if (asset === undefined)
				return Result.fail(
					BoltError.make('seedDecode', 'decode', `seed ${c}.${f}: the pack has no asset '${path}'`)
				);
			const id = uuidOf(`${c}.${f}\0${path}`);
			files.set(id, { field: `${c}.${f}`, path, asset });
			return Result.succeed({
				id,
				name: basename(path),
				mime: asset.contentType,
				bytes: asset.bytes,
				sha256: asset.sha256
			}); // hook:runtime — a seeded FileRef carries its size
		};
		const rows: { [c: string]: readonly RowData[] } = {};
		for (const [c, list] of Object.entries(pack.rows)) {
			const fileFields = Object.entries(m.models[c]?.fields ?? {})
				.filter(([, k]) => k.kind === 'file')
				.map(([f]) => f);
			const out: RowData[] = [];
			for (const r of list) {
				const row: { [f: string]: Json } = { ...r };
				for (const f of fileFields) {
					const v = row[f];
					if (v !== undefined)
						row[f] = Array.isArray(v)
							? yield* Result.all(v.map((x) => ref(c, f, x)))
							: yield* ref(c, f, v);
				}
				out.push(row);
			}
			rows[c] = out;
		}
		return { rows, files };
	});

/**
 * `loadPack` (rule 70) with the pack's assets: each `{ asset }` value of a `file` field becomes the `FileRef` of a
 * `sys_file` row, and each asset's bytes are put in the files store once. Nothing is stored when the database already
 * had rows.
 */
export const loadPackWithAssets = Effect.fn('bolt.loadPackWithAssets')(function* (
	db: TenantDbShape,
	m: EngineManifest,
	pack: Pack,
	files: Files['Service'],
	now: string
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const seeded = yield* Effect.fromResult(seedFiles(m, pack));
	if (!(yield* loadPack(db, m, { ...pack, rows: seeded.rows }, now))) return false;
	if (seeded.files.size === 0) return true;
	const keys = new Map<string, string>();
	const list: {
		id: string;
		name: string;
		mime: string;
		size: number;
		key: string;
		sha256: string;
		field: string;
	}[] = [];
	for (const [id, { field, path, asset }] of seeded.files) {
		let key = keys.get(path);
		if (key === undefined) {
			const bytes = yield* fs.readFile(pathService.join(pack.dir, 'assets', path));
			key = (yield* files
				.put(bytes, { name: pathService.basename(path), mime: asset.contentType })
				.pipe(
					Effect.timeoutOrElse({
						duration: '60 seconds',
						orElse: () =>
							Effect.fail(
								BoltError.make(
									'timeout',
									'facility',
									`storing the seed asset ${path} took longer than 60 s`
								)
							)
					})
				)).key;
			keys.set(path, key);
		}
		list.push({
			id,
			name: pathService.basename(path),
			mime: asset.contentType,
			size: asset.bytes,
			key,
			sha256: asset.sha256,
			field
		});
	}
	yield* db.write({
		text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at)
		SELECT x.id, x.name, x.mime, x.size, x.key, x.sha256, x.field, $2::timestamptz
		FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, mime text, size int, key text, sha256 text, field text) ON CONFLICT (id) DO NOTHING`,
		params: [JSON.stringify(list), now]
	});
	return true;
});

/** Facilities and declaration refusals a host checks before activating the verified artifact. */
export function activationRequirements(m: EngineManifest): {
	files: true;
	mail: true;
	secrets: boolean;
	issues: readonly string[];
} {
	const secrets = m.workspace.secrets ?? {};
	const oauth = Object.entries(m.integrations).flatMap(([name, d]) =>
		d.oauth === undefined ? [] : [[name, d.oauth] as const]
	);
	const issues: string[] = [];
	for (const [name, o] of oauth)
		for (const variable of [o.client, o.secret])
			if (!Object.hasOwn(secrets, variable))
				issues.push(
					`integration '${name}' signs in with secret '${variable}', which src/+secrets.ts does not declare`
				);
	return {
		files: true,
		mail: true,
		secrets: oauth.length > 0 || Object.keys(secrets).length > 0,
		issues
	};
}
