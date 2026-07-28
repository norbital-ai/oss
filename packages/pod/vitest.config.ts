import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Server-side unit/integration tests for the pod runtime. These run in Node against a real
// Postgres (see tests/support/pg-harness.ts) — the sync-engine safe-watermark and _ops_guard
// behaviours depend on genuine multi-connection concurrency and cannot be exercised on PGlite.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		testTimeout: 60_000,
		hookTimeout: 120_000,
		fileParallelism: false,
		maxWorkers: 1
	}
});
