import { Effect, FileSystem, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from '../../../scripts/lib/scratch.ts';
import { pageServer } from '../src/index.ts';
import { install } from '../src/decl/runtime/guest.ts';
import { pageServerMetadata } from '../src/decl/runtime/page.ts';
import { discover, sourcePath } from '../src/compiler/discover.ts';
import { load, manifestErrors } from '../src/compiler/load.ts';
import { namesIndex } from '../src/compiler/names.ts';
import { check } from '../src/compiler/check/index.ts';

install();

const workspace = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped({
		directory: yield* scratchRoot(),
		prefix: 'page-server-'
	});
	yield* fs.symlink(
		fileURLToPath(new URL('../node_modules', import.meta.url)),
		join(root, 'node_modules')
	);
	for (const [path, text] of Object.entries({
		'src/+workspace.ts': "export default { tz: 'UTC', locale: 'en' };",
		...files
	})) {
		yield* fs.makeDirectory(dirname(join(root, path)), { recursive: true });
		yield* fs.writeFileString(join(root, path), text);
	}
	return root;
});

describe('read-only page server authoring', () => {
	it.live(
		'attaches a generator without running it and validates one canonical metadata shape',
		() =>
			Effect.gen(function* () {
				let calls = 0;
				const Data = Schema.Struct({ title: Schema.String });
				const declaration = pageServer({
					data: Data,
					load: function* () {
						calls++;
						return { title: 'Loaded' };
					}
				});
				expect(declaration.data).toBe(Data);
				expect(pageServerMetadata(declaration, Data)).toEqual({ data: true, load: true });
				expect(calls).toBe(0);
				expect(() =>
					pageServerMetadata(declaration, Schema.Struct({ title: Schema.String }))
				).toThrow('must use');
				expect(() => pageServerMetadata({ data: {}, load: function* () {} }, Data)).toThrow(
					'shared data codec'
				);
				expect(() =>
					pageServerMetadata({ data: Data, load: () => ({ title: 'Invalid' }) }, Data)
				).toThrow('generator');
			}).pipe(Effect.provide(NodeServices.layer))
	);

	it.live(
		'discovers flat app and kiosk companions with independent identities and data helpers',
		() =>
			Effect.gen(function* () {
				const root = yield* workspace({
					'src/app/catalogue/+app.ts': 'export default {};',
					'src/app/catalogue/+home.page.svelte': '<p>Home</p>',
					'src/app/catalogue/+home.page.server.ts': 'export default {};',
					'src/app/catalogue/home.page.data.ts': 'export default {};',
					'src/kiosk/catalogue/+kiosk.ts': 'export default {};',
					'src/kiosk/catalogue/+home.page.svelte': '<p>Home</p>',
					'src/kiosk/catalogue/+home.page.server.ts': 'export default {};',
					'src/kiosk/catalogue/home.page.data.ts': 'export default {};'
				});
				const found = yield* discover(root);
				expect(found.errors).toEqual([]);
				for (const role of ['page_server', 'kiosk_page_server'] as const)
					expect(found.files).toContainEqual({
						role,
						name: 'catalogue/home',
						path: sourcePath(role, 'catalogue/home')
					});
				const metadata = yield* load(root, []);
				const names = namesIndex(found.files, metadata.manifest);
				expect(names).toContain(
					'pageServers: { "catalogue/home": typeof import("../src/app/catalogue/+home.page.server.ts").default };'
				);
				expect(names).toContain(
					'kioskPageServers: { "catalogue/home": typeof import("../src/kiosk/catalogue/+home.page.server.ts").default };'
				);
				yield* (yield* FileSystem.FileSystem).remove(
					join(root, 'src/app/catalogue/+home.page.svelte')
				);
				yield* (yield* FileSystem.FileSystem).remove(
					join(root, 'src/kiosk/catalogue/home.page.data.ts')
				);
				expect((yield* discover(root)).errors.map((error) => error.code)).toEqual([
					'discover/server-without-page',
					'discover/page-data-missing'
				]);
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);

	it.live('requires loaders for externally reachable pages while member portals stay SPA', () =>
		Effect.gen(function* () {
			for (const audience of ['members', 'external', 'all', { public: ['visitor'] }] as const) {
				const root = yield* workspace({
					'src/app/site/+app.ts': `export default ${JSON.stringify({
						name: 'site',
						spec: {
							title: 'Site',
							description: 'Site',
							icon: 'x',
							audience,
							pages: { home: { title: 'Home', portal: true } }
						}
					})};`,
					'src/app/site/+home.page.svelte': '<p>Home</p>'
				});
				const found = yield* discover(root);
				const loaded = yield* load(root, found.files);
				expect(loaded.errors).toEqual([]);
				expect(manifestErrors(loaded.manifest).map((error) => error.code)).toEqual(
					audience === 'members' ? [] : ['app/page-server-required']
				);
			}
			for (const auth of ['members', 'none', 'external', 'all'] as const) {
				const root = yield* workspace({
					'src/kiosk/site/+kiosk.ts': `export default ${JSON.stringify({
						name: 'site',
						spec: {
							title: 'Site',
							description: 'Site',
							icon: 'x',
							auth,
							policies: ['visitor'],
							pages: { home: { title: 'Home' } }
						}
					})};`,
					'src/kiosk/site/+home.page.svelte': '<p>Home</p>'
				});
				const found = yield* discover(root);
				const loaded = yield* load(root, found.files);
				expect(manifestErrors(loaded.manifest).map((error) => error.code)).toEqual(
					auth === 'members' ? [] : ['app/page-server-required']
				);
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);

	it.live(
		'evaluates loader metadata without executing the body and retains the real runtime loader',
		() =>
			Effect.gen(function* () {
				const root = yield* workspace({
					'src/app/site/+app.ts': `export default { name: 'site', spec: { title: 'Site', description: 'Site', icon: 'x', audience: 'all', pages: { home: { title: 'Home' } } } };`,
					'src/app/site/+home.page.svelte': '<p>Home</p>',
					'src/app/site/home.page.data.ts': `import { Schema } from 'effect'; export default Schema.Struct({ title: Schema.String });`,
					'src/app/site/+home.page.server.ts': `import { pageServer } from '@norbital-ai/bolt'; import Data from './home.page.data.ts'; export default pageServer({ data: Data, load: function* () { throw new Error('loader executes only on a request'); } });`
				});
				const result = yield* check(root);
				expect(result.errors).toEqual([]);
				expect(result.guest?.source).toContain('loader executes only on a request');
				expect(result.guest?.source).not.toContain('__pageServerMetadata');
			}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
