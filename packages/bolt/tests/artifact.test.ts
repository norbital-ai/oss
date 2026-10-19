import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { expect } from 'vitest';
import {
	artifactHash,
	CONTRACT,
	readArtifact,
	treeHash,
	publicPageKeys,
	type ArtifactJson
} from '../src/engine/artifact/read.ts';
import { sha256Hex } from '../src/engine/write/sql.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { fingerprint, schemaSlice } from '../src/engine/schema/plan.ts';

const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	integrations: {},
	pipelines: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
};

it.effect('selects public SSR routes by audience, independently of portal chrome', () =>
	Effect.sync(() => {
		const app = {
			title: 'App',
			description: 'Example',
			icon: 'lucide:layout',
			pages: { home: { title: 'Home' } }
		};
		expect(
			publicPageKeys({
				...manifest,
				apps: {
					internal: { ...app, pages: { home: { title: 'Home', portal: true } } },
					site: { ...app, audience: { public: ['visitors'] } },
					portal: { ...app, audience: 'external' },
					shared: { ...app, audience: 'all' },
					'kiosk/clock': { ...app, audience: 'external' }
				},
				kiosks: {
					private: { ...app, policies: ['kiosk'] },
					clock: { ...app, auth: 'none', policies: ['kiosk'] },
					portal: { ...app, auth: 'external', policies: ['kiosk'] },
					shared: { ...app, auth: 'all', policies: ['kiosk'] }
				}
			})
		).toEqual([
			'app/kiosk/clock/home',
			'app/portal/home',
			'app/shared/home',
			'app/site/home',
			'kiosk/clock/home',
			'kiosk/portal/home',
			'kiosk/shared/home'
		]);
	})
);

const publicManifest: EngineManifest = {
	...manifest,
	apps: {
		site: {
			title: 'Site',
			description: 'Example',
			icon: 'lucide:globe',
			audience: 'external',
			pages: { home: { title: 'Home' } }
		}
	}
};
const publicFixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-public-artifact-' });
	const text = `${JSON.stringify(publicManifest)}\n`;
	const source = 'export default {};';
	const pageSource =
		'export default { page: { "app/site/home": { body: () => ({ body: "<h1>Site</h1>", head: "", data: {} }) } } };';
	yield* fs.makeDirectory(path.join(dir, 'client', 'assets'), { recursive: true });
	yield* fs.makeDirectory(path.join(dir, 'client', 'public', 'app', 'site', 'home'), {
		recursive: true
	});
	yield* fs.makeDirectory(path.join(dir, 'server', 'app', 'site'), { recursive: true });
	yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
	yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
	yield* fs.writeFileString(path.join(dir, 'client', 'assets', 'site.js'), '/* public client */');
	yield* fs.writeFileString(path.join(dir, 'client', 'assets', 'site.css'), 'h1{color:orange}');
	yield* fs.writeFileString(
		path.join(dir, 'client', 'public', 'app', 'site', 'home', 'index.html'),
		'<!doctype html><div id="bolt"><!--bolt-public-body--></div>'
	);
	yield* fs.writeFileString(path.join(dir, 'server', 'app', 'site', 'home.mjs'), pageSource);
	const body: Omit<ArtifactJson, 'hash'> = {
		format: 1,
		contract: CONTRACT,
		handle: 'norbital_public',
		name: 'Public fixture',
		schema: fingerprint(schemaSlice(publicManifest)),
		transforms: [],
		projections: [],
		client: { entry: '', css: [] },
		pages: {
			'app/site/home': {
				entry: 'assets/site.js',
				css: ['assets/site.css'],
				server: { file: 'server/app/site/home.mjs', sha256: sha256Hex(pageSource) }
			}
		},
		hashes: {
			manifest: sha256Hex(text),
			guest: sha256Hex(source),
			client: yield* treeHash(path.join(dir, 'client')),
			server: yield* treeHash(path.join(dir, 'server'))
		}
	};
	const save = Effect.fnUntraced(function* (value: Omit<ArtifactJson, 'hash'>) {
		yield* fs.writeFileString(
			path.join(dir, 'artifact.json'),
			JSON.stringify({ ...value, hash: yield* artifactHash(dir, value) })
		);
	});
	yield* save(body);
	return { dir, body, pageSource, save };
});

it.live('verifies private public-page programs and refuses server-tree tampering', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const fixture = yield* publicFixture();
		const artifact = yield* readArtifact(fixture.dir);
		expect(artifact.pages['app/site/home']).toEqual({
			program: { source: fixture.pageSource },
			entry: 'assets/site.js',
			css: ['assets/site.css']
		});
		yield* fs.writeFileString(
			path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs'),
			`${fixture.pageSource}\n// changed`
		);
		expect(yield* readArtifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifactDigest'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('requires exact public routes and validates each program digest independently', () =>
	Effect.gen(function* () {
		const fixture = yield* publicFixture();
		yield* fixture.save({ ...fixture.body, pages: {} });
		expect(yield* readArtifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifactDigest'
		});
		yield* fixture.save({
			...fixture.body,
			pages: {
				'app/site/home': {
					entry: 'assets/site.js',
					css: ['assets/site.css'],
					server: { file: 'server/app/site/home.mjs', sha256: sha256Hex('different program') }
				}
			}
		});
		expect(yield* readArtifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifactDigest'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('refuses public page paths and symlinks that escape the verified artifact trees', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const fixture = yield* publicFixture();
		yield* fixture.save({
			...fixture.body,
			pages: {
				'app/site/home': {
					entry: '../guest.mjs',
					css: [],
					server: { file: 'server/app/site/home.mjs', sha256: sha256Hex(fixture.pageSource) }
				}
			}
		});
		expect(yield* readArtifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifactDigest'
		});
		const outside = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-public-outside-' });
		yield* fs.writeFileString(path.join(outside, 'page.mjs'), fixture.pageSource);
		yield* fs.remove(path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs'));
		yield* fs.symlink(
			path.join(outside, 'page.mjs'),
			path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs')
		);
		yield* fixture.save({
			...fixture.body,
			hashes: { ...fixture.body.hashes, server: yield* treeHash(path.join(fixture.dir, 'server')) }
		});
		expect(yield* readArtifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifactDigest',
			message: expect.stringContaining('outside its server tree')
		});
	}).pipe(Effect.provide(NodeServices.layer))
);
it.live('artifact digests depend on bytes and sorted paths, never mtimes', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-hash-' });
		yield* fs.writeFileString(path.join(root, 'b'), 'second');
		yield* fs.writeFileString(path.join(root, 'a'), 'first');
		const hash = yield* treeHash(root);
		expect(hash).toBe(sha256Hex(`a\0${sha256Hex('first')}\nb\0${sha256Hex('second')}`));
		yield* fs.utimes(
			path.join(root, 'a'),
			new Date('2000-01-01T00:00:00Z'),
			new Date('2020-01-01T00:00:00Z')
		);
		expect(yield* treeHash(root)).toBe(hash);
		yield* fs.writeFileString(path.join(root, 'a'), 'changed');
		expect(yield* treeHash(root)).not.toBe(hash);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('reads lazily, decodes artifact files once and refuses a changed digest', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-read-' });
		const pending = readArtifact(dir);
		const text = `${JSON.stringify(manifest)}\n`;
		const source = 'export default {};';
		yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
		yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
		const body: Omit<ArtifactJson, 'hash'> = {
			format: 1,
			contract: CONTRACT,
			handle: 'norbital_fixture',
			name: 'Fixture',
			schema: fingerprint(schemaSlice(manifest)),
			transforms: [],
			projections: [],
			client: { entry: '', css: [] },
			pages: {},
			hashes: {
				manifest: sha256Hex(text),
				guest: sha256Hex(source),
				client: yield* treeHash(path.join(dir, 'client')),
				server: yield* treeHash(path.join(dir, 'server'))
			}
		};
		const artifact: ArtifactJson = { ...body, hash: yield* artifactHash(dir, body) };
		yield* fs.writeFileString(path.join(dir, 'artifact.json'), JSON.stringify(artifact));
		expect((yield* pending).manifest).toEqual(manifest);
		yield* fs.writeFileString(path.join(dir, 'guest.mjs'), `${source}\n// tampered`);
		expect(yield* readArtifact(dir).pipe(Effect.flip)).toMatchObject({
			_tag: 'BoltError',
			code: 'artifactDigest'
		});
		yield* fs.writeFileString(path.join(dir, 'artifact.json'), '{}');
		expect(yield* readArtifact(dir).pipe(Effect.flip)).toMatchObject({ _tag: 'ManifestInvalid' });
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'authenticates historical snapshot metadata without reading or trusting its native bytes',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-untrusted-snapshot-' });
			const text = `${JSON.stringify(manifest)}\n`,
				source = 'export default {};',
				bytes = new Uint8Array([0, 1, 2, 3]);
			yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
			yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
			yield* fs.writeFile(path.join(dir, 'guest.snapshot'), bytes);
			const body: Omit<ArtifactJson, 'hash'> = {
				format: 1,
				contract: CONTRACT,
				handle: 'untrusted',
				name: 'Untrusted snapshot',
				schema: fingerprint(schemaSlice(manifest)),
				transforms: [],
				projections: [],
				client: { entry: '', css: [] },
				pages: {},
				hashes: {
					manifest: sha256Hex(text),
					guest: sha256Hex(source),
					client: yield* treeHash(path.join(dir, 'client')),
					server: yield* treeHash(path.join(dir, 'server'))
				},
				snapshot: { key: 'tenant-authored native bytes', sha: sha256Hex(bytes) }
			};
			const artifact: ArtifactJson = { ...body, hash: yield* artifactHash(dir, body) };
			yield* fs.writeFileString(path.join(dir, 'artifact.json'), JSON.stringify(artifact));
			const controlled: FileSystem.FileSystem = {
				...fs,
				readFile: (file) =>
					file.endsWith('guest.snapshot')
						? Effect.die(new Error('native snapshot bytes must never be read'))
						: fs.readFile(file)
			};
			const loaded = yield* readArtifact(dir).pipe(
				Effect.provideService(FileSystem.FileSystem, controlled)
			);
			expect(loaded.artifact.snapshot).toEqual(body.snapshot);
			expect(loaded.guest.source).toBe(source);
			expect('snapshot' in loaded.guest).toBe(false);
			yield* fs.remove(path.join(dir, 'guest.snapshot'));
			expect((yield* readArtifact(dir)).guest.source).toBe(source);
			yield* fs.writeFileString(
				path.join(dir, 'artifact.json'),
				JSON.stringify({
					...artifact,
					snapshot: { ...body.snapshot, sha: sha256Hex('rewritten metadata') }
				})
			);
			expect(yield* readArtifact(dir).pipe(Effect.flip)).toMatchObject({ code: 'artifactDigest' });
		}).pipe(Effect.provide(NodeServices.layer))
);
