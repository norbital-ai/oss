import { defineConfig } from 'vitest/config';

// oss's one suite: every package is a project of this one Vitest, so one worker pool and one transform cache serve them
// all. Threads, no per-file isolation, and a minute's hang guard (a test waiting that long is stuck, never slow).

export default defineConfig({
	test: {
		pool: 'threads',
		isolate: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
		projects: [
			'packages/{bolt,bolt-server,store,ui}/vitest.config.ts',
			...['app-shell', 'doctor', 'providers', 'std'].map((name) => ({
				extends: true,
				test: { name, root: `packages/${name}`, include: ['tests/**/*.test.ts'] }
			})),
			{ extends: true, test: { name: 'scripts', include: ['scripts/tests/*.test.ts'] } }
		]
	}
});
