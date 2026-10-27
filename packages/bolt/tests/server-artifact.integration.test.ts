import { it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem } from 'effect';
import { expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, readdir, realpath, symlink } from 'node:fs/promises';
import { scratchRoot } from '../../../scripts/lib/scratch.ts';
import { buildServerPages } from '../src/compiler/artifact/server.ts';
import { discover } from '../src/compiler/discover.ts';
import { sha256Hex } from '@norbital-ai/store';
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
		site: {
			title: 'Site',
			description: 'Public site',
			icon: 'lucide:globe',
			audience: 'external',
			pages: { home: { title: 'Home' } }
		}
	}
};
const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
/** A workspace root with its own copy of Svelte at another path, as a template's own install has. */
const separateSvelte = (root: string) =>
	Effect.promise(async () => {
		await cp(
			dirname(await realpath(join(modules, 'svelte'))),
			join(root, 'node_modules', '.svelte-copy', 'node_modules'),
			{
				recursive: true,
				dereference: true
			}
		);
		for (const name of await readdir(modules))
			await symlink(
				name === 'svelte'
					? join(root, 'node_modules', '.svelte-copy', 'node_modules', 'svelte')
					: join(modules, name),
				join(root, 'node_modules', name)
			);
	});
const fixture = Effect.fnUntraced(function* (loader: string, ownSvelte = false) {
	const fs = yield* FileSystem.FileSystem;
	const root = yield* fs.makeTempDirectoryScoped({
		directory: yield* scratchRoot(),
		prefix: 'server-artifact-'
	});
	if (ownSvelte) {
		yield* fs.makeDirectory(join(root, 'node_modules'));
		yield* separateSvelte(root);
	} else yield* fs.symlink(modules, join(root, 'node_modules'));
	for (const [file, text] of Object.entries({
		'src/+workspace.ts': "export default { tz: 'UTC', locale: 'en' };",
		'src/app/site/+app.ts': 'export default {};',
		'src/app/site/+home.page.svelte':
			'<script lang="ts">import { bolt } from "$bolt"; let { data }: { data: { title: string } } = $props();</script><svelte:head><title>{data.title}</title></svelte:head><h1>{data.title}</h1><p>{bolt.org.name}</p>',
		'src/app/site/home.page.data.ts':
			'import { Schema } from "effect"; export default Schema.Struct({ title: Schema.String });',
		'src/app/site/+home.page.server.ts': loader
	})) {
		yield* fs.makeDirectory(dirname(join(root, file)), { recursive: true });
		yield* fs.writeFileString(join(root, file), text);
	}
	const found = yield* discover(root);
	expect(found.errors).toEqual([]);
	return { root, files: found.files, out: join(root, 'artifact') };
});

const dependency = Effect.fnUntraced(function* () {
	const fs = yield* FileSystem.FileSystem;
	const directory = yield* fs.makeTempDirectoryScoped({
		directory: yield* scratchRoot(),
		prefix: 'server-dependency-'
	});
	yield* fs.writeFileString(
		join(directory, 'package.json'),
		JSON.stringify({ type: 'module', sideEffects: false })
	);
	yield* fs.writeFileString(
		join(directory, 'index.ts'),
		'export { nodeTitle } from "./node.ts"; export const title = "Dependency title";'
	);
	yield* fs.writeFileString(
		join(directory, 'node.ts'),
		'import { readFileSync } from "node:fs"; export const nodeTitle = () => readFileSync("/private", "utf8");'
	);
	return join(directory, 'index.ts');
});

it.live('compiles a private standalone public renderer without executing its loader', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const entry = yield* dependency();
		const input = yield* fixture(
			`import { pageServer } from "@norbital-ai/bolt"; import { title } from ${JSON.stringify(entry)}; import Data from "./home.page.data.ts"; export default pageServer({ data: Data, load: function* () { if (title === "Dependency title") throw new Error("loader remains request-bound"); return { title }; } });`
		);
		const pages = yield* buildServerPages(input.root, input.files, manifest, input.out);
		const page = pages['app/site/home'];
		if (page === undefined) throw new Error('public program missing');
		expect(page.file).toBe('server/app/site/home.mjs');
		const source = yield* fs.readFileString(join(input.out, page.file));
		expect(source).toContain('loader remains request-bound');
		expect(source).not.toContain('node:fs');
		expect(source).not.toContain('node:module');
		expect(source).not.toContain('readFileSync');
		expect(page.sha256).toBe(sha256Hex(source));
		expect(yield* fs.exists(join(input.out, 'client'))).toBe(false);
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('refuses a dependency Node capability retained after tree shaking', () =>
	Effect.gen(function* () {
		const entry = yield* dependency();
		const input = yield* fixture(
			`import { pageServer } from "@norbital-ai/bolt"; import { nodeTitle } from ${JSON.stringify(entry)}; import Data from "./home.page.data.ts"; export default pageServer({ data: Data, load: function* () { return { title: nodeTitle() }; } });`
		);
		const failure = yield* buildServerPages(input.root, input.files, manifest, input.out).pipe(
			Effect.flip
		);
		if (failure._tag !== 'BuildError') throw new Error('Expected a server compiler refusal');
		expect(String(failure.cause)).toContain('node:fs');
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('refuses Node dependencies in a public server loader', () =>
	Effect.gen(function* () {
		const input = yield* fixture(
			'import { pageServer } from "@norbital-ai/bolt"; import { readFileSync } from "node:fs"; import Data from "./home.page.data.ts"; export default pageServer({ data: Data, load: function* () { return { title: readFileSync("/private", "utf8") }; } });'
		);
		const failure = yield* buildServerPages(input.root, input.files, manifest, input.out).pipe(
			Effect.flip
		);
		expect(failure).toMatchObject({ _tag: 'BuildError' });
	}).pipe(Effect.provide(NodeServices.layer))
);

it.live('bundles the root’s own Svelte runtime when the workspace installs a separate copy', () =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const input = yield* fixture(
			'import { pageServer } from "@norbital-ai/bolt"; import Data from "./home.page.data.ts"; export default pageServer({ data: Data, load: function* () { return { title: "Own Svelte" }; } });',
			true
		);
		const pages = yield* buildServerPages(input.root, input.files, manifest, input.out);
		const page = pages['app/site/home'];
		if (page === undefined) throw new Error('public program missing');
		expect(yield* fs.readFileString(join(input.out, page.file))).not.toMatch(/from ['"]node:/);
	}).pipe(Effect.provide(NodeServices.layer))
);
