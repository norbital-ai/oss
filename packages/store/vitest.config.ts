import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Half the cores: macOS bills CPU time 2–3× on the slower cores under load.
const defaultWorkers = Math.max(1, Math.floor(availableParallelism() / 2));
const workers = Number(process.env.VITEST_MAX_WORKERS ?? defaultWorkers);
if (!Number.isSafeInteger(workers) || workers < 1)
	throw new Error('VITEST_MAX_WORKERS must be a positive integer');

export default defineConfig({
	test: {
		include: ['tests/*.test.ts'],
		pool: 'forks',
		maxWorkers: Math.min(defaultWorkers, workers),
		testTimeout: 15_000
	}
});
