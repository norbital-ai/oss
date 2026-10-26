import { defineConfig } from 'vitest/config';

const workers =
	process.env.VITEST_MAX_WORKERS === undefined ? undefined : Number(process.env.VITEST_MAX_WORKERS);
if (workers !== undefined && (!Number.isSafeInteger(workers) || workers < 1))
	throw new Error('VITEST_MAX_WORKERS must be a positive integer');

export default defineConfig({
	// Most of this suite boots a PGlite TestWorkspace or a whole server: bolt's integration budget, not 5 s.
	test: {
		pool: 'forks',
		execArgv: ['--no-node-snapshot'],
		testTimeout: 15_000,
		...(workers === undefined ? {} : { maxWorkers: workers })
	}
});
