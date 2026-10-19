import { defineConfig } from 'vitest/config';

export default defineConfig({
	// Most of this suite boots a PGlite TestWorkspace or a whole server: bolt's integration budget, not 5 s.
	test: { pool: 'forks', execArgv: ['--no-node-snapshot'], testTimeout: 15_000 }
});
