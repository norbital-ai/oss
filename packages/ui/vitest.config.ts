import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const workers = Number(process.env.VITEST_MAX_WORKERS ?? 2);
if (!Number.isSafeInteger(workers) || workers < 1)
	throw new Error('VITEST_MAX_WORKERS must be a positive integer');

export default defineConfig({
	plugins: [svelte({ compilerOptions: { experimental: { async: true } } })],
	resolve: {
		conditions: ['svelte', 'browser'],
		// PageBolt's package import must use the same edge that the source harness mounts.
		alias: [
			{
				find: /^@norbital-ai\/ui\/effect$/,
				replacement: fileURLToPath(new URL('./src/effect/index.ts', import.meta.url))
			}
		]
	},
	test: {
		include: ['tests/*.test.ts'],
		environment: 'happy-dom',
		// happy-dom 21 no longer loads iframe pages by default; the file previews embed one
		environmentOptions: { happyDOM: { settings: { enableIframePageLoading: true } } },
		pool: 'forks',
		// Node's optional storage globals hide the browser storage supplied by happy-dom.
		execArgv: ['--no-experimental-webstorage'],
		maxWorkers: Math.min(2, workers),
		isolate: true,
		restoreMocks: true,
		unstubGlobals: true,
		sequence: { concurrent: false },
		setupFiles: ['tests/dom.ts']
	}
});
