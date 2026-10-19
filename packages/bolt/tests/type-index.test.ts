/// <reference types="node" />
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

it.live(
	'indexes component props when the workspace checker bundles its converter instead of installing it',
	() =>
		Effect.sync(() => {
			const root = mkdtempSync(join(tmpdir(), 'norbital-component-types-'));
			const write = (file: string, content: string) => {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, file), content);
			};
			try {
				write(
					'node_modules/svelte-check/package.json',
					JSON.stringify({ name: 'svelte-check', version: '4.7.6' })
				);
				const svelte = dirname(createRequire(import.meta.url).resolve('svelte/package.json'));
				write(
					'tsconfig.json',
					JSON.stringify({
						compilerOptions: {
							module: 'ESNext',
							moduleResolution: 'Bundler',
							target: 'ES2024',
							types: [],
							skipLibCheck: true,
							paths: {
								'@norbital-ai/bolt': [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
								svelte: [join(svelte, 'types/index.d.ts')],
								'svelte/*': [join(svelte, '*')]
							}
						},
						include: ['src/**/*']
					})
				);
				write(
					'src/lib/panel.svelte',
					'<script lang="ts">let { title, count = 0 }: { title: string; count?: number } = $props();</script><h1>{title} {count}</h1>'
				);
				// pnpm's test shim exposes transitive dependencies through NODE_PATH; published consumers have no such fallback.
				const code = `import { typeIndex } from ${JSON.stringify(new URL('../src/compiler/artifact/types.ts', import.meta.url).href)};
import { manifest } from ${JSON.stringify(new URL('./engine-fixture.ts', import.meta.url).href)};
import { Effect, Console } from 'effect';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
NodeRuntime.runMain(typeIndex(${JSON.stringify(root)}, { ...manifest, models: {}, collections: {}, customFields: {} }).pipe(Effect.flatMap(value => Console.log(JSON.stringify(value)))));`;
				const run = spawnSync(process.execPath, ['--input-type=module', '--eval', code], {
					encoding: 'utf8',
					env: { ...process.env, NODE_PATH: '' }
				});
				expect(run.stderr).toBe('');
				expect(run.status).toBe(0);
				const result = Schema.decodeUnknownSync(
					Schema.fromJsonString(
						Schema.Struct({
							entries: Schema.Record(
								Schema.String,
								Schema.Struct({
									type: Schema.String,
									docs: Schema.optionalKey(Schema.String),
									source: Schema.optionalKey(Schema.String)
								})
							),
							errors: Schema.Array(Schema.String)
						})
					)
				)(run.stdout);
				expect(result.errors).toEqual([]);
				expect(result.entries['components.lib/panel']?.type).toContain('title: string');
				expect(result.entries['components.lib/panel']?.type).toContain('count?: number');
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}),
	30_000
);
