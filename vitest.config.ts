import { defineConfig } from 'vitest/config';

// oss's one suite: every package is a project of this one Vitest, so one worker pool and one transform cache serve them
// all. Forks, no per-file isolation, and a minute's hang guard (a test waiting that long is stuck, never slow): a fork
// returns its native memory to the OS when its project ends, while a thread's worker keeps it in the main process (the
// providers chat files grew one thread to 4.9 GB; the same files in a fork peak at 0.4 GB).

export default defineConfig({
	test: {
		pool: 'forks',
		isolate: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
		projects: [
			'packages/{bolt,bolt-cli,bolt-server,store,ui}/vitest.config.ts',
			...['app-shell', 'host-api', 'providers'].map((name) => ({
				extends: true,
				test: { name, root: `packages/${name}`, include: ['tests/**/*.test.ts'] }
			})),
			{ extends: true, test: { name: 'scripts', include: ['scripts/tests/*.test.ts'] } }
		]
	}
});
