import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Schema } from 'effect';
import { expect } from 'vitest';
import { scratchRoot } from '../../../scripts/lib/scratch.ts';
import { buildClient } from '../src/compiler/artifact/client.ts';
import { discover } from '../src/compiler/discover.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	customFields: {},
	agent: { skills: {} },
	apps: {
		main: {
			title: 'Main',
			description: 'Members',
			icon: 'lucide:lock',
			pages: { home: { title: 'Home' } }
		}
	}
};
const Initial = Schema.fromJsonString(
	Schema.Struct({ modules: Schema.Array(Schema.String), css: Schema.Array(Schema.String) })
);
/** Two workspaces that share nothing but their Bolt: different code, imports, versions and directories. */
const WORKSPACES = {
	first: {
		version: '7.41.993',
		page: `<script lang="ts">
import { Stack } from '@norbital-ai/ui/layout';
import { Effect } from 'effect';
let count = $state(0);
const label = Effect.runSync(Effect.succeed('FIRST_WORKSPACE_CANARY'));
</script><Stack><button class="top-[137px]" onclick={() => count++}>{label} {count}</button></Stack>`
	},
	second: {
		version: '8.52.117',
		page: `<script lang="ts">
import { writable } from 'svelte/store';
import { isString } from 'effect/Predicate';
import { Cluster } from '@norbital-ai/ui/layout';
const text = writable('SECOND_WORKSPACE_CANARY');
</script><Cluster><p class="bottom-[139px]">{isString($text) ? $text : ''}</p></Cluster>`
	}
} as const;

it.live(
	'builds one platform layer, byte for byte, into every workspace on this Bolt and keeps only workspace code apart',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const parent = yield* fs.realPath(
				yield* fs.makeTempDirectoryScoped({
					directory: yield* scratchRoot(),
					prefix: 'platform-layer-'
				})
			);
			const build = Effect.fnUntraced(function* (name: keyof typeof WORKSPACES) {
				const { version, page } = WORKSPACES[name];
				// at different depths: nothing of where a workspace sits may reach the layer
				const root = name === 'first' ? join(parent, name) : join(parent, 'nested', 'deeper', name);
				for (const [file, source] of Object.entries({
					'package.json': JSON.stringify({ name, version, private: true, type: 'module' }),
					'src/+workspace.ts': 'export default { tz: "UTC", locale: "en" };',
					'src/app/main/+app.ts': 'export default {};',
					'src/app/main/+home.page.svelte': page
				})) {
					yield* fs.makeDirectory(dirname(join(root, file)), { recursive: true });
					yield* fs.writeFileString(join(root, file), source);
				}
				yield* fs.symlink(
					fileURLToPath(new URL('../node_modules', import.meta.url)),
					join(root, 'node_modules')
				);
				const found = yield* discover(root);
				expect(found.errors).toEqual([]);
				const out = join(root, 'artifact', 'client');
				const client = yield* buildClient(root, found.files, manifest, out, name);
				const html = yield* fs.readFileString(join(out, 'index.html'));
				const initial = yield* Schema.decodeUnknownEffect(Initial)(
					/id="bolt-initial-modules">([^<]*)<\/script>/.exec(html)?.[1]
				);
				const read = (dir: string) =>
					fs.readDirectory(join(out, dir), { recursive: true }).pipe(
						Effect.map((files) => files.filter((file) => /\.(?:js|css)$/.test(file)).sort()),
						Effect.flatMap((files) =>
							Effect.forEach(files, (file) =>
								fs
									.readFileString(join(out, dir, file))
									.pipe(Effect.map((text) => [file, text] as const))
							)
						),
						Effect.map((files) => new Map(files))
					);
				const layer = yield* read('assets/platform');
				const own = new Map(
					[...(yield* read('assets'))].filter(([file]) => !file.startsWith('platform/'))
				);
				return {
					client,
					initial,
					layer,
					own,
					entry: yield* fs.readFileString(join(out, client.entry))
				};
			});
			const first = yield* build('first'),
				second = yield* build('second');

			// one layer: the same chunk names, hashes and bytes in both artifacts, so the CAS stores it once
			expect(first.layer.size).toBeGreaterThan(0);
			expect([...second.layer.keys()]).toEqual([...first.layer.keys()]);
			for (const [file, text] of first.layer) expect(second.layer.get(file), file).toBe(text);
			const layerText = [...first.layer.values()].join('\n');
			for (const marker of [
				'FIRST_WORKSPACE_CANARY',
				'SECOND_WORKSPACE_CANARY',
				WORKSPACES.first.version,
				WORKSPACES.second.version,
				'137px',
				'139px'
			])
				expect(layerText).not.toContain(marker);
			// one ui, in the layer: no workspace chunk carries a copy of the views' context module
			const shellContext = 'A view needs the shell: call provideBolt(bolt) above it.';
			expect([...first.layer.values()].filter((text) => text.includes(shellContext))).toHaveLength(
				1
			);

			for (const [{ own, entry, initial, client }, canary] of [
				[first, 'FIRST_WORKSPACE_CANARY'],
				[second, 'SECOND_WORKSPACE_CANARY']
			] as const) {
				const ownJs = [...own].filter(([file]) => file.endsWith('.js')).map(([, text]) => text);
				expect(ownJs.join('\n')).toContain(canary);
				expect(ownJs.some((text) => text.includes(shellContext))).toBe(false);
				// workspace code only: svelte, ui, effect and the shell are imported, not bundled
				expect(ownJs.reduce((bytes, text) => bytes + text.length, 0)).toBeLessThan(64 * 1024);
				expect(entry).toContain('./platform/');
				expect(entry).toContain('globalThis.__BOLT_BUILD__=');
				// the main thread initializes the layer's chunks with the workspace's, and links both stylesheets
				expect(initial.modules.some((file) => file.startsWith('assets/platform/'))).toBe(true);
				for (const file of initial.modules)
					expect(
						file.startsWith('assets/platform/')
							? first.layer.has(file.slice('assets/platform/'.length))
							: own.has(file.slice('assets/'.length)),
						file
					).toBe(true);
				expect(client.css).toEqual(initial.css);
				expect(client.css.some((file) => file.startsWith('assets/platform/'))).toBe(true);
			}
			expect(first.entry).toContain(WORKSPACES.first.version);
			expect(second.entry).toContain(WORKSPACES.second.version);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
	300_000
);
