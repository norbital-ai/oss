import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	// run from the oss root's projects, Vite's root would be oss/: the Svelte plugin crawls this package's dependencies
	// for the Svelte libraries to inline (bits-ui, runed), and finds none from there
	root: fileURLToPath(new URL('.', import.meta.url)),
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
		pool: 'threads',
		isolate: false,
		restoreMocks: true,
		unstubGlobals: true,
		sequence: { concurrent: false },
		testTimeout: 60_000,
		hookTimeout: 60_000,
		setupFiles: ['tests/dom.ts']
	}
});
