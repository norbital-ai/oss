/// <reference types="node" />
// `bolt check`'s type stage (compute model §5, "Check: one type service for every tenant"): the type service over the
// workspace on disk, every package (svelte2tsx's shims' `svelte` included) from the workspace's own `node_modules`.
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect } from 'effect';
import { types } from '../src/cli/check.ts';

const SVELTE = realpathSync(fileURLToPath(new URL('../node_modules/svelte', import.meta.url)));
const CONFIG = {
	compilerOptions: {
		target: 'ES2022',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		skipLibCheck: true,
		verbatimModuleSyntax: true,
		types: []
	},
	include: ['src/**/*.ts', 'src/**/*.svelte']
};

it.live(
	"checks .ts files and components against the workspace's own svelte, cached until a file or the config moves",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), 'norbital-types-'))),
				(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
			);
			const write = (file: string, text: string) => {
				mkdirSync(dirname(join(root, file)), { recursive: true });
				writeFileSync(join(root, file), text);
			};
			// a second physical copy of svelte, the workspace's: the shims must type against it, not Bolt's
			const svelte = join(root, 'node_modules', 'svelte');
			cpSync(SVELTE, svelte, {
				recursive: true,
				filter: (from) => !from.startsWith(join(SVELTE, 'node_modules'))
			});
			symlinkSync(join(SVELTE, 'node_modules'), join(svelte, 'node_modules'));
			const diagnostics = () =>
				types(root).pipe(Effect.map((found) => found.map((d) => `${d.path}:${d.line}:${d.code}`)));

			write('tsconfig.json', JSON.stringify(CONFIG));
			write('src/value.ts', 'export const value = 1;\n');
			write('src/main.ts', "import { value } from './value';\nconst n: number = value;\n");
			write(
				'src/Card.svelte',
				'<script lang="ts">\n\timport type { Snippet } from \'svelte\';\n\tlet { children, footer }: { children: Snippet; footer?: Snippet } = $props();\n</script>\n\n{@render children()}\n{@render footer?.()}\n'
			);
			write(
				'src/Page.svelte',
				'<script lang="ts">\n\timport Card from \'./Card.svelte\';\n</script>\n\n<Card>\n\t<p>body</p>\n\t{#snippet footer()}<p>end</p>{/snippet}\n</Card>\n'
			);
			expect(yield* diagnostics()).toEqual([]);

			write('src/value.ts', "export const value = 'changed';\n");
			write(
				'src/Bad.svelte',
				'<script lang="ts">\n\tconst count: number = \'many\';\n</script>\n\n<p>{count}</p>\n'
			);
			const errors = yield* diagnostics();
			expect(errors).toEqual(['src/Bad.svelte:2:types/TS2322', 'src/main.ts:2:types/TS2322']);
			// answered from the cache: the same files, the same verdict
			expect(yield* diagnostics()).toEqual(errors);

			write('src/Bad.svelte', '<p>fine</p>\n');
			write(
				'src/main.ts',
				"import { value } from './value';\nconst n: string = value;\nconst optional: string = null;\n"
			);
			expect(yield* diagnostics()).toEqual(['src/main.ts:3:types/TS2322']);
			write(
				'tsconfig.json',
				JSON.stringify({
					...CONFIG,
					compilerOptions: { ...CONFIG.compilerOptions, strictNullChecks: false }
				})
			);
			expect(yield* diagnostics()).toEqual([]);

			// the Svelte compiler's warnings fail a check too (the type service sees types only)
			write('src/Photo.svelte', '<img src="photo.png" />\n');
			expect(yield* diagnostics()).toEqual(['src/Photo.svelte:1:svelte/a11y_missing_attribute']);
		}).pipe(Effect.provide(NodeServices.layer))
);
