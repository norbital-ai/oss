import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src', import.meta.url))
		},
		conditions: ['svelte', 'browser']
	},
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		exclude: ['build/**', '.norbital/**'],
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		pool: 'forks',
		// Most of this suite provisions a real PGlite database per test file, and each one is a
		// Postgres — memory and CPU, not a mock. Left to spawn one fork per core, the machine
		// saturates and files that pass alone time out at five seconds together: nine failures that
		// change identity between runs and say nothing about the code. A suite whose default run is
		// flaky is worse than a slow one, because every real regression then has to be argued with.
		maxWorkers: 4,
		// The four workers still share a two-core Actions runner. Database boot and an in-process
		// TypeScript program both cross five seconds under that contention even though their focused
		// runs take two to three; give real integration work headroom without leaving a hung test loose.
		testTimeout: 15_000,
		sequence: {
			concurrent: false
		},
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/compiler/cli.ts', 'src/**/*.d.ts'],
			reporter: ['text', 'json-summary']
		}
	},
	server: {
		fs: {
			strict: true,
			allow: [fileURLToPath(new URL('../..', import.meta.url))]
		}
	}
});
