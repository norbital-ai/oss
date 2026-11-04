// The platform layer carries one svelte and one ui, the shell's: a workspace import of either resolves to the shell's
// copy; the shell's own imports and every other package resolve as they are.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	SHELL,
	PLATFORM,
	cachedPlatformLayer,
	layerLines,
	preparedLayer,
	shellRuntime,
	type PlatformLayer
} from '../src/compiler/artifact/platform.ts';
import { memoTreeHash, pagesKey } from '../src/compiler/artifact/index.ts';
import { it as effectIt } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { randomUUID } from 'node:crypto';
import { scratchPath } from '../../../scripts/lib/scratch.ts';

const page = '/workspace/src/app/main/+home.page.svelte';

effectIt.live('keys the public pages by the bytes of their graph, and nothing else', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectoryScoped();
			yield* fs.writeFileString(join(root, 'page.svelte'), 'one');
			yield* fs.writeFileString(join(root, 'model.ts'), 'outside the graph');
			const key = () => pagesKey(root, 'client', ['page.svelte', 'gone.svelte']);
			const first = yield* key();
			yield* fs.writeFileString(join(root, 'model.ts'), 'edited');
			expect(yield* key()).toBe(first);
			yield* fs.writeFileString(join(root, 'page.svelte'), 'two');
			expect(yield* key()).not.toBe(first);
			yield* fs.writeFileString(join(root, 'page.svelte'), 'one');
			expect(yield* pagesKey(root, 'other', ['page.svelte', 'gone.svelte'])).not.toBe(first);
		})
	).pipe(Effect.provide(NodeServices.layer))
);

effectIt.live(
	'reuses only a workspace’s SDK layer and invalidates changed or incomplete toolchains',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem;
				const root = yield* scratchPath(`platform-cache-${randomUUID()}`);
				yield* fs.makeDirectory(root, { recursive: true });
				yield* Effect.addFinalizer(() =>
					fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
				);
				const cache = join(root, 'one', 'cache');
				let builds = 0;
				const build = (out: string, code: string) =>
					Effect.gen(function* () {
						builds++;
						yield* fs.makeDirectory(join(out, PLATFORM), { recursive: true });
						yield* fs.writeFileString(join(out, PLATFORM, 'sdk.js'), code);
						return {
							modules: new Map([['svelte', './platform/sdk.js']]),
							chunks: new Map([
								[
									'assets/platform/sdk.js',
									{ fileName: 'assets/platform/sdk.js', imports: [], dynamicImports: [] }
								]
							]),
							css: []
						} satisfies PlatformLayer;
					});
				const first = join(root, 'first'),
					next = join(root, 'next');
				yield* cachedPlatformLayer(cache, 'sdk-v1', first, build(first, 'sdk one'));
				const reused = yield* cachedPlatformLayer(cache, 'sdk-v1', next, build(next, 'wrong'));
				expect(builds).toBe(1);
				expect(reused.modules.get('svelte')).toBe('./platform/sdk.js');
				expect(yield* fs.readFileString(join(next, PLATFORM, 'sdk.js'))).toBe('sdk one');
				yield* cachedPlatformLayer(cache, 'sdk-v2', next, build(next, 'sdk two'));
				expect(builds).toBe(2);
				const other = join(root, 'other');
				yield* cachedPlatformLayer(
					join(other, 'cache'),
					'sdk-v2',
					other,
					build(other, 'private other')
				);
				expect(yield* fs.readFileString(join(cache, 'files', 'sdk.js'))).toBe('sdk two');
				yield* fs.remove(join(cache, 'files'), { recursive: true });
				yield* cachedPlatformLayer(cache, 'sdk-v2', next, build(next, 'repaired'));
				expect(builds).toBe(4);
				// a build over a prepared layer leaves its files out and hashes as if they were there
				const prepared = yield* preparedLayer(cache);
				expect(prepared.layer.modules.get('svelte')).toBe('./platform/sdk.js');
				const whole = join(root, 'whole');
				yield* fs.makeDirectory(join(whole, 'client', PLATFORM), { recursive: true });
				yield* fs.writeFileString(join(whole, 'client', 'entry.js'), 'entry');
				yield* fs.writeFileString(join(whole, 'client', PLATFORM, 'sdk.js'), 'repaired');
				const expected = yield* memoTreeHash(whole);
				yield* fs.remove(join(whole, 'client', PLATFORM), { recursive: true });
				expect(yield* memoTreeHash(whole, layerLines(prepared, 'client'))).toBe(expected);
			})
		).pipe(Effect.provide(NodeServices.layer))
);

describe('shellRuntime', () => {
	it('sends a workspace import of svelte or ui to the shell', () => {
		for (const id of ['svelte', 'svelte/store', '@norbital-ai/ui', '@norbital-ai/ui/layout'])
			expect(shellRuntime(id, page), id).toBe(true);
	});

	it('leaves the shell, entries and other packages alone', () => {
		expect(shellRuntime('svelte', join(SHELL, 'mount.ts'))).toBe(false);
		expect(shellRuntime('svelte', undefined)).toBe(false);
		for (const id of ['effect', 'svelte-check', '@norbital-ai/uikit'])
			expect(shellRuntime(id, page), id).toBe(false);
	});
});

import { clientImportBoundary } from '../src/compiler/artifact/client-boundary.ts';

it('imports the platform runtime without asking workspace-root resolution for another copy', async () => {
	const plugin = clientImportBoundary(
		'/workspace',
		[],
		new Map([['svelte/internal/client', './platform/client.js']])
	);
	const hook = plugin.resolveId;
	if (typeof hook !== 'function') throw new Error('Expected the client resolution hook');
	// No resolver context: a known platform entry must return before consulting Vite's dedupe resolver.
	const resolved = await Reflect.apply(hook, undefined, ['svelte/internal/client', page, {}]);
	expect(resolved).toEqual({ id: './platform/client.js', external: true });
});
