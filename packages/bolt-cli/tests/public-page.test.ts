import { Context, Effect, FileSystem, Layer, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, it } from '@effect/vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchRoot } from '../../../scripts/lib/scratch.ts';
import { discover } from '../src/compiler/discover.ts';
import { load, manifestErrors } from '../src/compiler/load.ts';
import { buildServerPages } from '../src/compiler/artifact/server.ts';
import { Guest, type CrossCall } from '../../bolt/src/engine/services.ts';
import { fixtureManifest, guestLayer } from '../../bolt/tests/support/guest-fixture.ts';
import { PublicBoot } from '../../bolt/src/protocol/public-page.ts';

const workspace = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped({
		directory: yield* scratchRoot(),
		prefix: 'public-page-'
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
const app = {
	title: 'Site',
	description: 'Site',
	icon: 'x',
	audience: 'external',
	pages: { home: { title: 'Home' } }
} as const;

it.live('compiles a public component and renders its caller query in the isolated program', () =>
	Effect.gen(function* () {
		const root = yield* workspace({
			'src/app/site/+app.ts': `export default ${JSON.stringify(app)};`,
			'src/app/site/+home.page.svelte': `<script>
				let { ctx } = $props();
				const jobs = ctx.query({ jobs: { fields: ['title'] } });
			</script>
			<h1>{jobs.current?.jobs.rows[0]?.title ?? 'Loading'}</h1>`
		});
		const found = yield* discover(root);
		expect(found.errors).toEqual([]);
		const loaded = yield* load(root, found.files);
		expect(loaded.errors).toEqual([]);
		expect(manifestErrors(loaded.manifest)).toEqual([]);
		const manifest = { ...fixtureManifest, apps: { site: app } };
		const pages = yield* buildServerPages(root, found.files, manifest, root);
		expect(Object.keys(pages)).toEqual(['app/site/home']);
		const fs = yield* FileSystem.FileSystem;
		const source = yield* fs.readFileString(join(root, 'server/app/site/home.mjs'));
		const context = yield* Layer.build(
			guestLayer(
				{ source: 'export default {};' },
				{
					lowerRead: () => ({
						kind: 'get',
						model: 'jobs',
						id: 'job',
						select: { fields: ['title'], relations: {} }
					})
				}
			)
		);
		const guest = Context.get(context, Guest);
		const boot: PublicBoot = {
			workspace: { name: 'Site', locale: 'en', tz: 'UTC' },
			actor: null,
			location: { pathname: '/app/site/home', search: '' },
			base: '',
			visitor: null,
			kiosk: null,
			contract: 'test',
			describe: false,
			messages: {},
			catalog: {},
			automations: {}
		};
		const calls: CrossCall[] = [];
		const value = { jobs: { rows: [{ title: 'Admitted row' }], next: null } };
		const result = yield* guest.invokeProgram(
			{ source },
			{
				id: 'page',
				kind: 'page',
				target: 'app/site/home',
				input: { boot: yield* Schema.encodeEffect(Schema.toCodecJson(PublicBoot))(boot) },
				ctx: {
					actor: { kind: 'visitor', app: 'site', visitor: 'guest' },
					now: '2026-01-01T20:00:00.000Z',
					today: '2026-01-01',
					tz: 'UTC',
					seed: 'seed'
				},
				budget: { crossings: 40, readBytes: 1_000_000 }
			},
			{
				cross: (batch) =>
					Effect.sync(() => {
						calls.push(...batch);
						return batch.map(() => ({ ok: true, value }));
					})
			}
		);
		expect(result).toMatchObject({
			kind: 'ok',
			output: {
				body: expect.stringContaining('Admitted row'),
				reads: {
					[JSON.stringify({ m: 'query', a: [{ jobs: { fields: ['title'] } }] })]: value
				}
			}
		});
		expect(calls).toHaveLength(1);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it.live('refuses a retired public-page companion as an unknown source role', () =>
	Effect.gen(function* () {
		const root = yield* workspace({
			'src/app/site/+app.ts': `export default ${JSON.stringify(app)};`,
			'src/app/site/+home.page.svelte': '<p>Home</p>',
			'src/app/site/+home.page.server.ts': 'export default {};'
		});
		const found = yield* discover(root);
		expect(found.errors).toMatchObject([
			{ code: 'discover/unknown-role', path: 'src/app/site/+home.page.server.ts' }
		]);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
