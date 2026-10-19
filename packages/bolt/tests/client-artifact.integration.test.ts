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

const Manifest = Schema.Record(
	Schema.String,
	Schema.Struct({
		file: Schema.String,
		isEntry: Schema.optionalKey(Schema.Boolean),
		imports: Schema.optionalKey(Schema.Array(Schema.String)),
		dynamicImports: Schema.optionalKey(Schema.Array(Schema.String)),
		css: Schema.optionalKey(Schema.Array(Schema.String))
	})
);
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
	customFields: {},
	agent: { skills: {} },
	apps: {
		site: {
			title: 'Site',
			description: 'Public site',
			icon: 'lucide:globe',
			audience: 'external',
			pages: { first: { title: 'First' }, second: { title: 'Second' } }
		},
		internal: {
			title: 'Internal',
			description: 'Members',
			icon: 'lucide:lock',
			pages: { home: { title: 'Home' } }
		}
	}
};

it.live(
	'shares public chunks while keeping each route CSS, lazy imports and private graph separate',
	() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const temporary = yield* fs.makeTempDirectoryScoped({
				directory: yield* scratchRoot(),
				prefix: 'client-artifact-'
			});
			const parent = yield* fs.realPath(temporary);
			yield* fs.makeDirectory(join(parent, 'workspace'));
			const root = join(parent, 'workspace-alias');
			yield* fs.symlink(join(parent, 'workspace'), root);
			yield* fs.symlink(
				fileURLToPath(new URL('../node_modules', import.meta.url)),
				join(root, 'node_modules')
			);
			const codec =
				'import { Schema } from "effect"; export default Schema.Struct({ title: Schema.String });';
			const loader = 'export default "SSR_DEFINITION_PRIVATE_CANARY";';
			for (const [file, source] of Object.entries({
				'package.json': JSON.stringify({
					name: 'client-artifact-fixture',
					version: '1.0.0',
					private: true,
					type: 'module'
				}),
				'src/+workspace.ts': 'export default { tz: "UTC", locale: "en" };',
				'src/app/site/+app.ts': 'export default {};',
				'src/app/site/+first.page.svelte': `<script lang="ts">
import Shared from '../../lib/Shared.svelte';
import First from '../../lib/First.svelte';
let { data }: { data: { title: string } } = $props();
let extra = $state('');
const more = async () => { extra = (await import('../../lib/lazy.ts')).value; };
</script><h1>{data.title} FIRST_PUBLIC_PAGE_CANARY</h1><Shared /><First /><button onclick={more}>More</button><p>{extra}</p>`,
				'src/app/site/first.page.data.ts': codec,
				'src/app/site/+first.page.server.ts': loader,
				'src/app/site/+second.page.svelte': `<script lang="ts">
import Shared from '../../lib/Shared.svelte';
import Second from '../../lib/Second.svelte';
let { data }: { data: { title: string } } = $props();
</script><h1>{data.title} SECOND_PUBLIC_PAGE_CANARY</h1><Shared /><Second />`,
				'src/app/site/second.page.data.ts': codec,
				'src/app/site/+second.page.server.ts': loader,
				'src/lib/Shared.svelte':
					'<span class="shared">SHARED_PUBLIC_RUNTIME_CANARY</span><style>.shared { --shared-public-css: 1; }</style>',
				'src/lib/First.svelte':
					'<p class="first top-[137px]">First component</p><style>.first { --first-page-css: 1; }</style>',
				'src/lib/Second.svelte':
					'<p class="second bottom-[139px]">Second component</p><style>.second { --second-page-css: 1; }</style>',
				'src/lib/lazy.ts': 'import "./lazy.css"; export const value = "LAZY_PUBLIC_CANARY";',
				'src/lib/lazy.css': '.lazy-only { --lazy-public-css: 1; }',
				'src/lib/internal-worker.ts': 'postMessage("INTERNAL_WORKER_CANARY");',
				'src/app/internal/+app.ts': 'export default {};',
				'src/app/internal/+home.page.svelte': `<script lang="ts">
const worker = () => new Worker(new URL('../../lib/internal-worker.ts', import.meta.url), { type: 'module' });
</script><button onclick={worker}>PRIVATE_SPA_ONLY_CANARY</button>`,
				'src/agent/+agent.md': 'PRIVATE_AGENT_PROMPT_CANARY'
			})) {
				yield* fs.makeDirectory(dirname(join(root, file)), { recursive: true });
				yield* fs.writeFileString(join(root, file), source);
			}
			const found = yield* discover(root);
			expect(found.errors).toEqual([]);
			const out = join(root, 'artifact', 'client');
			const client = yield* buildClient(root, found.files, manifest, out, 'Public sharing');
			const first = client.pages['app/site/first'],
				second = client.pages['app/site/second'];
			if (first === undefined || second === undefined)
				throw new Error('public client projections missing');
			const graph = yield* fs
				.readFileString(join(out, 'public/.vite/manifest.json'))
				.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))));
			// Native manifest keys can include the canonical path relative to this aliased workspace root.
			const firstKey = Object.keys(graph).find(
				(name) => graph[name]?.isEntry === true && `public/${graph[name]?.file}` === first.entry
			);
			const secondKey = Object.keys(graph).find(
				(name) => graph[name]?.isEntry === true && `public/${graph[name]?.file}` === second.entry
			);
			if (firstKey === undefined || secondKey === undefined)
				throw new Error('native manifest projections missing');
			const reached = (entry: string): string[] => {
				const seen = new Set<string>();
				const visit = (name: string): void => {
					if (seen.has(name)) return;
					const chunk = graph[name];
					if (chunk === undefined) throw new Error(`missing native manifest chunk ${name}`);
					seen.add(name);
					for (const imported of chunk.imports ?? []) visit(imported);
				};
				visit(entry);
				return [...seen];
			};
			const code = (names: readonly string[]) =>
				Effect.forEach(names, (name) => {
					const chunk = graph[name];
					if (chunk === undefined) throw new Error(`missing native manifest chunk ${name}`);
					return fs.readFileString(join(out, 'public', chunk.file));
				}).pipe(Effect.map((sources) => sources.join('\n')));
			const firstReached = reached(firstKey),
				secondReached = reached(secondKey);
			const shared = firstReached.filter((name) => secondReached.includes(name));
			expect(shared.length).toBeGreaterThan(0);
			expect(yield* code(shared)).toContain('SHARED_PUBLIC_RUNTIME_CANARY');
			const firstCode = yield* code(firstReached),
				secondCode = yield* code(secondReached);
			expect(firstCode).toContain('FIRST_PUBLIC_PAGE_CANARY');
			expect(firstCode).not.toContain('SECOND_PUBLIC_PAGE_CANARY');
			expect(secondCode).toContain('SECOND_PUBLIC_PAGE_CANARY');
			expect(secondCode).not.toContain('FIRST_PUBLIC_PAGE_CANARY');
			for (const source of [firstCode, secondCode]) {
				expect(source).not.toContain('PRIVATE_SPA_ONLY_CANARY');
				expect(source).not.toContain('LAZY_PUBLIC_CANARY');
			}
			const allJs = [
				...new Set(
					Object.values(graph)
						.map((chunk) => chunk.file)
						.filter((file) => file.endsWith('.js'))
				)
			];
			const publicSources = yield* Effect.forEach(allJs, (file) =>
				fs.readFileString(join(out, 'public', file))
			);
			expect(
				publicSources.filter((source) => source.includes('SHARED_PUBLIC_RUNTIME_CANARY'))
			).toHaveLength(1);
			for (const privateMarker of [
				'PRIVATE_SPA_ONLY_CANARY',
				'SSR_DEFINITION_PRIVATE_CANARY',
				'PRIVATE_AGENT_PROMPT_CANARY'
			])
				expect(publicSources.join('\n')).not.toContain(privateMarker);
			const styles = (files: readonly string[]) =>
				Effect.forEach(files, (file) => fs.readFileString(join(out, file))).pipe(
					Effect.map((sources) => sources.join('\n'))
				);
			const firstCss = yield* styles(first.css),
				secondCss = yield* styles(second.css);
			expect(firstCss).toContain('--first-page-css');
			expect(firstCss).not.toContain('--second-page-css');
			expect(firstCss).toMatch(/top:\s*137px/);
			expect(firstCss).not.toMatch(/bottom:\s*139px/);
			expect(secondCss).toContain('--second-page-css');
			expect(secondCss).not.toContain('--first-page-css');
			expect(secondCss).toMatch(/bottom:\s*139px/);
			expect(secondCss).not.toMatch(/top:\s*137px/);
			// Vite emits and owns the lazy boundary; its stylesheet stays out of both initial documents.
			const dynamic = [
				...new Set(firstReached.flatMap((name) => graph[name]?.dynamicImports ?? []))
			];
			expect(dynamic.length).toBeGreaterThan(0);
			expect(yield* code(dynamic)).toContain('LAZY_PUBLIC_CANARY');
			expect(firstCode).toContain('import(');
			expect(firstCss).not.toContain('--lazy-public-css');
			expect(secondCss).not.toContain('--lazy-public-css');
			const lazyCss = dynamic
				.flatMap((name) => graph[name]?.css ?? [])
				.map((file) => `public/${file}`);
			expect(yield* styles(lazyCss)).toContain('--lazy-public-css');
			for (const [route, page] of Object.entries(client.pages)) {
				const html = yield* fs.readFileString(join(out, 'public', route, 'index.html'));
				expect(html).toContain(`src="/${page.entry}"`);
				for (const css of page.css) expect(html).toContain(`href="/${css}"`);
				for (const css of lazyCss) expect(html).not.toContain(`href="/${css}"`);
			}
			// The existing internal admission list still excludes separately emitted worker programs.
			const internalHtml = yield* fs.readFileString(join(out, 'index.html'));
			const readyText =
				/<script type="application\/json" id="bolt-initial-modules">([^<]*)<\/script>/.exec(
					internalHtml
				)?.[1];
			if (readyText === undefined)
				throw new Error('internal module initialization metadata missing');
			const ready = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Struct({ modules: Schema.Array(Schema.String), css: Schema.Array(Schema.String) })
				)
			)(readyText);
			const scripts = (yield* fs.readDirectory(out, { recursive: true })).filter((file) =>
				file.endsWith('.js')
			);
			const workerFiles = yield* Effect.filter(scripts, (file) =>
				fs
					.readFileString(join(out, file))
					.pipe(Effect.map((source) => source.includes('INTERNAL_WORKER_CANARY')))
			);
			expect(workerFiles).toHaveLength(1);
			for (const worker of workerFiles) expect(ready.modules).not.toContain(worker);
			const clientSources = (yield* Effect.forEach(scripts, (file) =>
				fs.readFileString(join(out, file))
			)).join('\n');
			for (const privateMarker of ['SSR_DEFINITION_PRIVATE_CANARY', 'PRIVATE_AGENT_PROMPT_CANARY'])
				expect(clientSources).not.toContain(privateMarker);
		}).pipe(Effect.provide(NodeServices.layer)),
	120_000
);
