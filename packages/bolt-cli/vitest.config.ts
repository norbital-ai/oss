import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** `@norbital-ai/bolt` and its subpaths as Bolt's source: the suite and this source share one copy of every module. */
const BOLT = Object.entries({
	'': 'index',
	'/artifact': 'engine/artifact/read',
	'/engine': 'engine/index',
	'/errors': 'decl/errors',
	'/facilities': 'facilities/index',
	'/guest-hooks': 'node/guest-hooks',
	'/host-api': 'protocol/host-api',
	'/node': 'node/index',
	'/protocol': 'protocol/index',
	'/tooling': 'tooling/index',
	'/tooling/browser': 'tooling/browser'
}).map(([subpath, file]) => ({
	find: new RegExp(`^@norbital-ai/bolt${subpath}$`),
	replacement: fileURLToPath(new URL(`../bolt/src/${file}.ts`, import.meta.url))
}));

// One Node project, as Bolt's: files share a worker (`isolate: false`) under a minute's hang guard.
export default defineConfig({
	test: {
		projects: [
			{
				extends: false,
				plugins: [svelte()],
				resolve: { conditions: ['svelte', 'browser'], alias: BOLT },
				test: {
					name: 'node',
					environment: 'node',
					// a stubbed global or env var must not reach the next file
					restoreMocks: true,
					unstubEnvs: true,
					unstubGlobals: true,
					include: ['tests/*.test.ts'],
					exclude: ['build/**', '.norbital/**'],
					pool: 'forks',
					isolate: false,
					testTimeout: 60_000,
					hookTimeout: 60_000
				}
			}
		]
	},
	server: { fs: { strict: true, allow: [fileURLToPath(new URL('../..', import.meta.url))] } }
});
