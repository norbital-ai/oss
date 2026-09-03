import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Two suites, one config, split by filename.
//
// A `*.integration.test.ts` file provisions a real PGlite database — a Postgres process, not a
// mock. Seventy-four of them cost about twenty-five minutes of CPU, which is 93% of this package's
// test time for 43% of its files. Gating every merge and every release on that meant the same nine
// minutes ran twice per push to main and nobody could ship without waiting for it, so the
// integration suite moved off the merge path onto its own schedule.
//
// The suffix is enforced, not a convention: `tests/architecture-test-suite-split.test.ts` fails if
// a file reaches PGlite without carrying it. Renaming a file is how you move it between suites.
const integrationSuite = process.env.BOLT_TEST_SUITE === 'integration';

export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src', import.meta.url)),
			'#lib': fileURLToPath(new URL('./src', import.meta.url))
		},
		conditions: ['svelte', 'browser']
	},
	test: {
		environment: 'node',
		include: integrationSuite ? ['tests/*.integration.test.ts'] : ['tests/*.test.ts'],
		exclude: integrationSuite
			? [
					'build/**',
					'.norbital/**',
					...(process.env.OPENROUTER_API_KEY ? [] : ['tests/*.live.integration.test.ts'])
				]
			: ['build/**', '.norbital/**', 'tests/*.integration.test.ts'],
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		pool: 'forks',
		// Both suites include compiler-heavy files. Letting Vitest spawn one fork per core makes their
		// TypeScript programs and temporary workspace builds compete for the same CPU and filesystem;
		// on an 18-core host the otherwise-green unit suite reproducibly times out nine files at five
		// seconds. Four workers keep useful parallelism while the same suite remains inside its real
		// timeout budget. The integration suite also provisions a PGlite database per file, so it uses
		// the same bound for memory as well as CPU.
		maxWorkers: 4,
		// Four workers sharing a small Actions runner push database boot and an in-process TypeScript
		// program past five seconds even though their focused runs take two to three. Integration work
		// gets that headroom; a unit test that needs more than five seconds is a unit test in the
		// wrong suite.
		testTimeout: integrationSuite ? 15_000 : 5_000,
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
