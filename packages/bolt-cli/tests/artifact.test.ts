import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, expect } from 'vitest';
import {
	artifact_hash,
	CONTRACT,
	read_artifact,
	tree_hash,
	public_page_keys,
	type ArtifactJson
} from '../../bolt/src/engine/artifact/read.ts';
import { Port } from '../../bolt/src/engine/port.ts';
import { read_lock, read_snapshot, sha256_hex, snapshot_of } from '@norbital-ai/store';
import { artifact_port } from '../../bolt/src/node/artifact.ts';
import { prepare_migrations } from '../src/compiler/migrations.ts';
import { writeSource } from '../src/compiler/artifact/index.ts';
import { Pristine } from '../../bolt/src/node/db/pglite.ts';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { fingerprint, schema_slice } from '../../bolt/src/engine/schema/plan.ts';
import { TestWorkspace } from '../src/test/index.ts';

const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
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
			public_page_keys({
				...manifest,
				apps: {
					internal: { ...app, pages: { home: { title: 'Home', portal: true } } },
					site: { ...app, audience: { public: ['visitors'] } },
					portal: { ...app, audience: 'external' },
					shared: { ...app, audience: 'all' },
					'kiosk/clock': { ...app, audience: 'external' },
					private: { ...app, shell: 'kiosk', policies: ['kiosk'] },
					clock: { ...app, shell: 'kiosk', audience: { public: ['kiosk'] } },
					account: { ...app, shell: 'kiosk', audience: 'external', policies: ['kiosk'] },
					common: { ...app, shell: 'kiosk', audience: 'all', policies: ['kiosk'] }
				}
			})
		).toEqual([
			'app/kiosk/clock/home',
			'app/portal/home',
			'app/shared/home',
			'app/site/home',
			'kiosk/account/home',
			'kiosk/clock/home',
			'kiosk/common/home'
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
/** Each manifest's generated migrations, prepared (and replay-verified) once for the whole file. */
const prepared = await Effect.runPromise(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const generate = (m: EngineManifest) =>
			Effect.gen(function* () {
				const dir = yield* fs.makeTempDirectory({ prefix: 'bolt-artifact-migrations-' });
				yield* prepare_migrations(dir, m, 'generate');
				return join(dir, 'migrations');
			});
		return { plain: yield* generate(manifest), public: yield* generate(publicManifest) };
	}).pipe(Effect.provide(Pristine.layer), Effect.provide(NodeServices.layer))
);
afterAll(() => {
	for (const migrations of Object.values(prepared))
		rmSync(dirname(migrations), { recursive: true, force: true });
});
const publicFixture = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-public-artifact-' });
	const text = `${JSON.stringify(publicManifest)}\n`;
	const source = 'export default {};';
	const pageSource =
		'export default { page: { "app/site/home": { body: () => ({ body: "<h1>Site</h1>", head: "", reads: {}, messages: {} }) } } };';
	yield* fs.makeDirectory(path.join(dir, 'client', 'assets'), { recursive: true });
	yield* fs.makeDirectory(path.join(dir, 'client', 'public', 'app', 'site', 'home'), {
		recursive: true
	});
	yield* fs.makeDirectory(path.join(dir, 'server', 'app', 'site'), { recursive: true });
	yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
	yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
	cpSync(prepared.public, path.join(dir, 'migrations'), { recursive: true });
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
		schema: fingerprint(schema_slice(publicManifest)),
		client: { entry: '', css: [] },
		pages: {
			'app/site/home': {
				entry: 'assets/site.js',
				css: ['assets/site.css'],
				server: { file: 'server/app/site/home.mjs', sha256: sha256_hex(pageSource) }
			}
		},
		hashes: {
			manifest: sha256_hex(text),
			guest: sha256_hex(source),
			client: yield* tree_hash(path.join(dir, 'client')),
			server: yield* tree_hash(path.join(dir, 'server'))
		}
	};
	const save = Effect.fnUntraced(function* (value: Omit<ArtifactJson, 'hash'>) {
		yield* fs.writeFileString(
			path.join(dir, 'artifact.json'),
			JSON.stringify({ ...value, hash: yield* artifact_hash(dir, value) })
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
		const artifact = yield* read_artifact(fixture.dir);
		expect(artifact.pages['app/site/home']).toEqual({
			program: { source: fixture.pageSource },
			entry: 'assets/site.js',
			css: ['assets/site.css']
		});
		yield* fs.writeFileString(
			path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs'),
			`${fixture.pageSource}\n// changed`
		);
		expect(yield* read_artifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifact_digest'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('a page that needs sign-in sends a signed-out document request to sign in, and back', () =>
	Effect.gen(function* () {
		const artifact = yield* read_artifact((yield* publicFixture()).dir);
		const res = yield* Effect.flatMap(TestWorkspace, (t) =>
			t.handle(new Request('https://acme.example/app/site/home?x=1', { redirect: 'manual' }))
		).pipe(
			Effect.provide(TestWorkspace.layer({ artifact, host: { public_url: 'https://acme.example' } }))
		);
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(
			'https://acme.example/sign-in?next=%2Fapp%2Fsite%2Fhome%3Fx%3D1'
		);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('a release its host admitted is checked again only for what runs in the cell', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const fixture = yield* publicFixture();
		yield* fs.writeFileString(
			path.join(fixture.dir, 'client', 'assets', 'site.js'),
			'/* changed */'
		);
		expect(yield* read_artifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifact_digest'
		});
		expect(
			(yield* read_artifact(fixture.dir, undefined, 'executed')).pages['app/site/home']?.entry
		).toBe('assets/site.js');
		yield* fs.writeFileString(path.join(fixture.dir, 'guest.mjs'), '// changed');
		expect(yield* read_artifact(fixture.dir, undefined, 'executed').pipe(Effect.flip)).toMatchObject(
			{ code: 'artifact_digest' }
		);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('requires exact public routes and validates each program digest independently', () =>
	Effect.gen(function* () {
		const fixture = yield* publicFixture();
		yield* fixture.save({ ...fixture.body, pages: {} });
		expect(yield* read_artifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifact_digest'
		});
		yield* fixture.save({
			...fixture.body,
			pages: {
				'app/site/home': {
					entry: 'assets/site.js',
					css: ['assets/site.css'],
					server: { file: 'server/app/site/home.mjs', sha256: sha256_hex('different program') }
				}
			}
		});
		expect(yield* read_artifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
			code: 'artifact_digest'
		});
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	'refuses public page paths that escape the artifact; its host port refuses a symlink out of it',
	() =>
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
						server: { file: 'server/app/site/home.mjs', sha256: sha256_hex(fixture.pageSource) }
					}
				}
			});
			expect(yield* read_artifact(fixture.dir).pipe(Effect.flip)).toMatchObject({
				code: 'artifact_digest'
			});
			const outside = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-public-outside-' });
			yield* fs.writeFileString(path.join(outside, 'page.mjs'), fixture.pageSource);
			yield* fs.remove(path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs'));
			yield* fs.symlink(
				path.join(outside, 'page.mjs'),
				path.join(fixture.dir, 'server', 'app', 'site', 'home.mjs')
			);
			const release = artifact_port(fixture.dir);
			expect(
				yield* Effect.flip(
					Port.attempt('artifact', (signal) => release.read('server/app/site/home.mjs', signal))
				)
			).toMatchObject({ kind: 'invalid', message: expect.stringContaining('has no path') });
		}).pipe(Effect.provide(NodeServices.layer))
);
it.live(
	'a release source is copied from inside the workspace it copies, without its builds or tests',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const path = yield* Path.Path;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-release-source-' });
			for (const [file, text] of Object.entries({
				'src/+workspace.ts': 'workspace',
				'src/notes.test.ts': 'test',
				'src/.DS_Store': 'finder',
				'node_modules/x/index.js': 'installed',
				'.norbital/bundle/manifest.json': 'built'
			})) {
				yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
				yield* fs.writeFileString(path.join(root, file), text);
			}
			// `bolt build` writes the source under the workspace's own `.norbital/`
			const out = path.join(root, '.norbital', '.next', 'source');
			const digest = yield* writeSource(root, out);
			expect((yield* fs.readDirectory(out, { recursive: true })).toSorted()).toEqual([
				'src',
				'src/+workspace.ts'
			]);
			expect(digest).toBe(yield* tree_hash(out));
		}).pipe(Effect.provide(NodeServices.layer))
);
it.live('artifact digests depend on bytes and sorted paths, never mtimes', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const root = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-hash-' });
		yield* fs.writeFileString(path.join(root, 'b'), 'second');
		yield* fs.writeFileString(path.join(root, 'a'), 'first');
		const hash = yield* tree_hash(root);
		expect(hash).toBe(sha256_hex(`a\0${sha256_hex('first')}\nb\0${sha256_hex('second')}`));
		yield* fs.utimes(
			path.join(root, 'a'),
			new Date('2000-01-01T00:00:00Z'),
			new Date('2020-01-01T00:00:00Z')
		);
		expect(yield* tree_hash(root)).toBe(hash);
		yield* fs.writeFileString(path.join(root, 'a'), 'changed');
		expect(yield* tree_hash(root)).not.toBe(hash);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('reads lazily, decodes artifact files once and refuses a changed digest', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-read-' });
		const pending = read_artifact(dir);
		const text = `${JSON.stringify(manifest)}\n`;
		const source = 'export default {};';
		yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
		yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
		cpSync(prepared.plain, path.join(dir, 'migrations'), { recursive: true });
		const body: Omit<ArtifactJson, 'hash'> = {
			format: 1,
			contract: CONTRACT,
			handle: 'norbital_fixture',
			name: 'Fixture',
			schema: fingerprint(schema_slice(manifest)),
			client: { entry: '', css: [] },
			pages: {},
			hashes: {
				manifest: sha256_hex(text),
				guest: sha256_hex(source),
				client: yield* tree_hash(path.join(dir, 'client')),
				server: yield* tree_hash(path.join(dir, 'server'))
			}
		};
		const artifact: ArtifactJson = { ...body, hash: yield* artifact_hash(dir, body) };
		yield* fs.writeFileString(path.join(dir, 'artifact.json'), JSON.stringify(artifact));
		expect((yield* pending).manifest).toEqual(manifest);
		yield* fs.writeFileString(path.join(dir, 'guest.mjs'), `${source}\n// tampered`);
		expect(yield* read_artifact(dir).pipe(Effect.flip)).toMatchObject({
			_tag: 'BoltError',
			code: 'artifact_digest'
		});
		yield* fs.writeFileString(path.join(dir, 'artifact.json'), '{}');
		expect(yield* read_artifact(dir).pipe(Effect.flip)).toMatchObject({ _tag: 'ManifestInvalid' });
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live(
	"re-derives only its own contract's schema: a pinned older release keeps its recorded schema",
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-artifact-pinned-' });
			const text = `${JSON.stringify(manifest)}\n`,
				source = 'export default {};';
			yield* fs.writeFileString(path.join(dir, 'manifest.json'), text);
			yield* fs.writeFileString(path.join(dir, 'guest.mjs'), source);
			cpSync(prepared.plain, path.join(dir, 'migrations'), { recursive: true });
			const write = (contract: string) =>
				Effect.gen(function* () {
					const body: Omit<ArtifactJson, 'hash'> = {
						format: 1,
						contract,
						handle: 'pinned',
						name: 'Pinned',
						// an older engine's system layer fingerprints the same manifest differently
						schema: sha256_hex('an older system layer'),
						client: { entry: '', css: [] },
						pages: {},
						hashes: {
							manifest: sha256_hex(text),
							guest: sha256_hex(source),
							client: yield* tree_hash(path.join(dir, 'client')),
							server: yield* tree_hash(path.join(dir, 'server'))
						}
					};
					yield* fs.writeFileString(
						path.join(dir, 'artifact.json'),
						JSON.stringify({ ...body, hash: yield* artifact_hash(dir, body) })
					);
				});
			const older = sha256_hex('@norbital-ai/bolt@0.0.0-older');
			yield* write(older);
			expect((yield* read_artifact(dir, [older])).manifest).toEqual(manifest);
			yield* write(CONTRACT);
			expect(yield* read_artifact(dir).pipe(Effect.flip)).toMatchObject({ code: 'schema_mismatch' });
			const snapshotPath = path.join(dir, 'migrations', 'snapshot.json');
			const lockPath = path.join(dir, 'migrations', 'migrations.lock.json');
			const { schema: snapshot } = yield* read_snapshot(yield* fs.readFileString(snapshotPath));
			const user = snapshot.tables['sys_user'];
			if (user === undefined) throw new Error('fixture has no sys_user');
			// The older system layer did not declare the user search index.
			const olderUser = { ...user };
			delete olderUser.search;
			const olderSnapshot = snapshot_of({
				...snapshot,
				tables: { ...snapshot.tables, sys_user: olderUser }
			});
			const lock = yield* read_lock(yield* fs.readFileString(lockPath));
			yield* fs.writeFileString(snapshotPath, olderSnapshot);
			yield* fs.writeFileString(
				lockPath,
				JSON.stringify({ ...lock, snapshot: sha256_hex(olderSnapshot) })
			);
			yield* write(older);
			expect((yield* read_artifact(dir, [older])).manifest).toEqual(manifest);
			yield* write(CONTRACT);
			expect(yield* read_artifact(dir).pipe(Effect.flip)).toMatchObject({ code: 'schema_moved' });
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
			cpSync(prepared.plain, path.join(dir, 'migrations'), { recursive: true });
			yield* fs.writeFile(path.join(dir, 'guest.snapshot'), bytes);
			const body: Omit<ArtifactJson, 'hash'> = {
				format: 1,
				contract: CONTRACT,
				handle: 'untrusted',
				name: 'Untrusted snapshot',
				schema: fingerprint(schema_slice(manifest)),
				client: { entry: '', css: [] },
				pages: {},
				hashes: {
					manifest: sha256_hex(text),
					guest: sha256_hex(source),
					client: yield* tree_hash(path.join(dir, 'client')),
					server: yield* tree_hash(path.join(dir, 'server'))
				},
				snapshot: { key: 'tenant-authored native bytes', sha: sha256_hex(bytes) }
			};
			const artifact: ArtifactJson = { ...body, hash: yield* artifact_hash(dir, body) };
			yield* fs.writeFileString(path.join(dir, 'artifact.json'), JSON.stringify(artifact));
			const controlled: FileSystem.FileSystem = {
				...fs,
				readFile: (file) =>
					file.endsWith('guest.snapshot')
						? Effect.die(new Error('native snapshot bytes must never be read'))
						: fs.readFile(file)
			};
			const loaded = yield* read_artifact(dir).pipe(
				Effect.provideService(FileSystem.FileSystem, controlled)
			);
			expect(loaded.artifact.snapshot).toEqual(body.snapshot);
			expect(loaded.guest.source).toBe(source);
			expect('snapshot' in loaded.guest).toBe(false);
			yield* fs.remove(path.join(dir, 'guest.snapshot'));
			expect((yield* read_artifact(dir)).guest.source).toBe(source);
			yield* fs.writeFileString(
				path.join(dir, 'artifact.json'),
				JSON.stringify({
					...artifact,
					snapshot: { ...body.snapshot, sha: sha256_hex('rewritten metadata') }
				})
			);
			expect(yield* read_artifact(dir).pipe(Effect.flip)).toMatchObject({ code: 'artifact_digest' });
		}).pipe(Effect.provide(NodeServices.layer))
);
