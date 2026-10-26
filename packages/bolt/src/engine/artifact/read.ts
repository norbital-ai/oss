// A host's reading of the artifact (rule 69), without the build toolchain: `@norbital-ai/bolt/artifact`. `bolt build`
// writes what this reads (compiler/artifact/index.ts); `artifact.json` and `manifest.json` are decoded here, once (A.4).
// Every read goes through Effect's `FileSystem` and `Path`: in a cell they are the host's artifact port, which resolves
// symlinks and refuses a path outside the release, so containment here is a check of the path's shape.
import { sha256Hex } from '@norbital-ai/store';
import { Effect, FileSystem, Path, Predicate, Result, Schema, Stream } from 'effect';
import * as EffectArray from 'effect/Array';
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
import { migrationSchema, readMigrations, type MigrationBundle } from '../schema/migrations.ts';
import { current } from '@norbital-ai/store';
import { fromStore } from '../../protocol/errors.ts';
import { drain, packLoader, type Pack, type PackSource, type SeedAsset } from '../write/pack.ts';

export const ArtifactJsonSchema = Schema.Struct({
	format: Schema.Literal(1),
	/** The engine contract this artifact was built against (§2.3 decision 5); a host refuses one it does not implement. */
	contract: Schema.String,
	/** The tenant handle (`norbital.template.json` `key`, else the directory name) and the display name. */
	handle: Schema.String,
	name: Schema.String,
	/** The schema fingerprint `plan`/`applyPlan` record (rule 69). */
	schema: Schema.String,
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
	migrations: MigrationBundle;
	guest: GuestProgram;
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
/** sha256 hex of a tree's sorted `<path>\0<sha256 hex>` lines, `\n`-joined: a folder's `treeHash`, a skill's digest. */
export const treeDigest = (files: Iterable<readonly [path: string, bytes: Uint8Array]>): string =>
	sha256Hex(
		Array.from(files, ([file, bytes]) => `${file}\0${sha256Hex(bytes)}`)
			.sort()
			.join('\n')
	);
export const treeHash = Effect.fn('bolt.artifactTreeHash')(function* (dir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files: (readonly [string, Uint8Array])[] = [];
	for (const file of yield* tree(dir)) files.push([file, yield* fs.readFile(path.join(dir, file))]);
	return treeDigest(files);
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
			yield* treeHash(path.join(dir, 'workspace', 'src')),
			yield* treeHash(path.join(dir, 'migrations'))
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
	contracts: readonly string[] = [CONTRACT],
	/** `executed`: a host that admitted the release already checked its trees; only what runs here is checked again. */
	digests: 'all' | 'executed' = 'all'
) {
	const fs = yield* FileSystem.FileSystem;
	const { join } = yield* Path.Path;
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
	const migrations = yield* readMigrations(join(dir, 'migrations'));
	yield* current(migrations.snapshot, migrationSchema(manifest)).pipe(Effect.mapError(fromStore));
	// The fingerprint folds in this engine's system layer: only an artifact of this contract can be re-derived here.
	// A pinned older release's schema is verified by its own graph's HOST_API; its digest still binds the manifest.
	if (artifact.contract === CONTRACT && fingerprint(schemaSlice(manifest)) !== artifact.schema)
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
	const { format, contract, handle, name, schema, client, pages, hashes, snapshot } = artifact;
	const actual = {
		manifest: sha256Hex(manifestText),
		guest: sha256Hex(guest.source),
		...(digests === 'executed'
			? {}
			: {
					client: yield* treeHash(join(dir, 'client')),
					server: yield* treeHash(join(dir, 'server'))
				})
	};
	const bad =
		(Object.keys(actual) as (keyof typeof actual)[]).find((k) => hashes[k] !== actual[k]) ??
		(digests === 'executed' ||
		(yield* artifactHash(dir, {
			format,
			contract,
			handle,
			name,
			schema,
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
		for (const name of [page.entry, ...page.css, `public/${route}/index.html`])
			if ((yield* fs.stat(join(dir, 'client', name))).type !== 'File')
				return yield* BoltError.make(
					'artifactDigest',
					'admission',
					`the public page ${route} names a browser file outside its client tree`
				);
		const absolute = join(dir, page.server.file);
		const source = yield* text(absolute);
		if (sha256Hex(source) !== page.server.sha256)
			return yield* BoltError.make(
				'artifactDigest',
				'admission',
				`the public page ${route} does not match its server program digest; rebuild it`
			);
		const map = `${absolute}.map`;
		const program: GuestProgram = { source };
		if (yield* fs.exists(map)) program.sourceMap = yield* text(map);
		const assets = join(dir, `server/${route}.assets`);
		if (yield* fs.exists(assets)) {
			const held: Record<string, Uint8Array> = {};
			for (const hash of yield* fs.readDirectory(assets)) {
				const bytes = new Uint8Array(yield* file(join(assets, hash)));
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
		migrations,
		guest,
		client: join(dir, 'client'),
		pages: pagePrograms
	} satisfies Artifact;
});

/**
 * The artifact's `workspace/` (the source `bolt build` copied) as the agent's workspace port; `undefined` for an
 * artifact built without one. A path never leaves the directory.
 */
export const workspaceFiles = Effect.fn('bolt.workspaceFiles')(function* (artifactDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = path.join(artifactDir, 'workspace');
	if (!(yield* fs.exists(dir))) return undefined;
	// the type setup beside the source is the language tool's, not the agent's to search
	const list = (yield* tree(dir)).filter((file) => !file.startsWith('.norbital/'));
	return {
		// repository-health:allow EFF3 -- WorkspacePort is the host's Promise ABI.
		files: async () => list,
		// repository-health:allow EFF3 -- WorkspacePort is the host's Promise ABI.
		read: (name) =>
			list.includes(name)
				? Effect.runPromise(fs.readFileString(path.join(dir, name)))
				: Promise.resolve(null)
	} satisfies WorkspacePort;
});

/** The artifact's skill folders (`skills/<name>/`): one file's bytes, by the skill and its path in the folder. */
export const skillFiles = Effect.fn('bolt.skillFiles')(function* (artifactDir: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	// repository-health:allow EFF3 -- the agent's skill files are the host's Promise ABI.
	return (skill: string, file: string): Promise<Uint8Array> =>
		file.split('/').some((part) => part === '' || part === '.' || part === '..')
			? Promise.reject(new Error(`'${file}' is not a path in a skill`))
			: Effect.runPromise(fs.readFile(path.join(artifactDir, 'skills', skill, file)));
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
const seedFiles = (m: EngineManifest, meta: Pack['meta']) => {
	const assets = new Map(meta.assets.map((a) => [a.path, a]));
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
			name: path.slice(path.lastIndexOf('/') + 1),
			mime: asset.contentType,
			bytes: asset.bytes,
			sha256: asset.sha256
		}); // hook:runtime — a seeded FileRef carries its size
	};
	/** One row of `c` as it is restored; `files` fills as the rows go by. */
	const rowOf = (c: string, r: RowData) =>
		Result.gen(function* () {
			const row: { [f: string]: Json } = { ...r };
			for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) {
				const v = row[f];
				if (k.kind === 'file' && v !== undefined)
					row[f] = EffectArray.isArray<typeof v>(v)
						? yield* Result.all(v.map((x) => ref(c, f, x)))
						: yield* ref(c, f, v);
			}
			return row;
		});
	return { files, rowOf };
};

/**
 * `packLoader` (rule 70) with the pack's assets: each `{ asset }` value of a `file` field becomes the `FileRef` of a
 * `sys_file` row, and each asset's bytes are put in the files store once, in bounded batches after the rows; a last step
 * records the `sys_file` rows. Nothing is stored when the database already had rows.
 */
export const packAssetLoader = Effect.fn('bolt.packAssetLoader')(function* (
	db: TenantDbShape,
	m: EngineManifest,
	pack: PackSource,
	files: Files['Service'],
	now: string
) {
	const fs = yield* FileSystem.FileSystem;
	const pathService = yield* Path.Path;
	const seeded = seedFiles(m, pack.meta);
	const rows = yield* packLoader(
		db,
		m,
		{
			...pack,
			rows: (c, from) =>
				pack.rows(c, from).pipe(Stream.mapEffect((row) => Effect.fromResult(seeded.rowOf(c, row))))
		},
		now
	);
	/** The assets left to store, one per path: set once the rows are in. */
	let pending: SeedFile[] | undefined;
	const keys = new Map<string, string>();
	let answer: 'loaded' | 'hadRows' | undefined;
	const store = (path: string, asset: SeedAsset) =>
		Effect.gen(function* () {
			const bytes = yield* fs.readFile(pathService.join(pack.dir, 'assets', path));
			return (yield* files
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
		});
	const record = Effect.suspend(() =>
		db.write({
			text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at)
		SELECT x.id, x.name, x.mime, x.size, x.key, x.sha256, x.field, $2::timestamptz
		FROM jsonb_to_recordset($1::jsonb) AS x(id text, name text, mime text, size int, key text, sha256 text, field text) ON CONFLICT (id) DO NOTHING`,
			params: [
				JSON.stringify(
					[...seeded.files].map(([id, { field, path, asset }]) => ({
						id,
						name: pathService.basename(path),
						mime: asset.contentType,
						size: asset.bytes,
						key: keys.get(path),
						sha256: asset.sha256,
						field
					}))
				),
				now
			]
		})
	);
	const step = Effect.gen(function* () {
		if (answer !== undefined) return answer;
		if (pending === undefined) {
			const loaded = yield* rows.step;
			if (loaded === 'more') return loaded;
			if (loaded === 'hadRows' || seeded.files.size === 0) {
				answer = loaded;
				return answer;
			}
			pending = [...new Map([...seeded.files.values()].map((f) => [f.path, f])).values()];
			return 'more' as const;
		}
		// Bound both requests and retained media in a Cell entry; a larger single asset still runs alone.
		const batch: SeedFile[] = [];
		let bytes = 0;
		while (batch.length < 4) {
			const next = pending[pending.length - 1 - batch.length];
			if (next === undefined || (batch.length > 0 && bytes + next.asset.bytes > 8 * 1024 * 1024))
				break;
			batch.push(next);
			bytes += next.asset.bytes;
		}
		if (batch.length > 0) {
			yield* Effect.forEach(
				batch,
				(next) =>
					store(next.path, next.asset).pipe(
						Effect.tap((key) => Effect.sync(() => keys.set(next.path, key)))
					),
				{ concurrency: 4, discard: true }
			);
			pending.length -= batch.length;
			return 'more' as const;
		}
		yield* record;
		answer = 'loaded';
		return answer;
	});
	return { step };
});
/** `packAssetLoader` whole: `false` when the database had rows and nothing changed. */
export const loadPackWithAssets = Effect.fn('bolt.loadPackWithAssets')(function* (
	db: TenantDbShape,
	m: EngineManifest,
	pack: PackSource,
	files: Files['Service'],
	now: string
) {
	return (yield* drain((yield* packAssetLoader(db, m, pack, files, now)).step)) === 'loaded';
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
