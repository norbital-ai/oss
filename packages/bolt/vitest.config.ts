import { svelte } from '@sveltejs/vite-plugin-svelte';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two suites, one config, split by filename: a `*.integration.test.ts` file provisions a real PGlite database and runs
// with `BOLT_TEST_SUITE=integration`; every other `*.test.ts` is the unit suite on the merge path.
const integrationSuite = process.env.BOLT_TEST_SUITE === 'integration';

export default defineConfig({
	plugins: [svelte()],
	resolve: { conditions: ['svelte', 'browser'] },
	test: {
		environment: 'node',
		include: integrationSuite ? ['tests/*.integration.test.ts'] : ['tests/*.test.ts'],
		exclude: integrationSuite ? ['build/**', '.norbital/**'] : ['build/**', '.norbital/**', 'tests/*.integration.test.ts'],
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		pool: 'forks',
		maxWorkers: Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2))),
		testTimeout: integrationSuite ? 15_000 : 5_000,
		sequence: { concurrent: false },
		coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.d.ts'], reporter: ['text', 'json-summary'] }
	},
	server: { fs: { strict: true, allow: [fileURLToPath(new URL('../..', import.meta.url))] } }
});
