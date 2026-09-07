import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { Option, Schema } from 'effect';

const source = fileURLToPath(new URL('./src', import.meta.url));

/**
 * `#lib/*` is this package's own alias for `src`, but it is also the subpath-import prefix every
 * sibling package uses for itself. A plain alias rewrites a sibling's `#lib/i18n` to Bolt's `src/i18n`
 * and breaks any test that mounts a `@norbital-ai/ui` component from its build. For an importer that
 * lives in another package, resolve the specifier through that package's own `imports` map instead,
 * the way Node would.
 */
const PackageImports = Schema.fromJsonString(
	Schema.Struct({ imports: Schema.Record(Schema.String, Schema.String) })
);
const decodePackageImports = Schema.decodeUnknownOption(PackageImports);

const packageImportsOf = (
	importer: string
): { readonly root: string; readonly imports: Record<string, string> } | undefined => {
	let directory = dirname(importer);
	while (directory !== dirname(directory)) {
		const manifest = join(directory, 'package.json');
		if (existsSync(manifest)) {
			const decoded = decodePackageImports(readFileSync(manifest, 'utf8'));
			return Option.isSome(decoded)
				? { root: directory, imports: decoded.value.imports }
				: undefined;
		}
		directory = dirname(directory);
	}
	return undefined;
};

const resolveSiblingSubpath = (specifier: string, importer: string): string | null => {
	const found = packageImportsOf(importer);
	if (found === undefined || found.root === dirname(source)) return null;
	const exact = found.imports[specifier];
	if (exact !== undefined) return join(found.root, exact);
	const patterns = Object.entries(found.imports)
		.filter(([key]) => key.endsWith('/*') && specifier.startsWith(key.slice(0, -1)))
		.sort(([left], [right]) => right.length - left.length);
	const match = patterns[0];
	if (match === undefined) return null;
	const [key, target] = match;
	return join(found.root, target.replace('*', specifier.slice(key.length - 1)));
};

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
// A wall-clock budget cannot be judged while three other forks pin the CPU: the agent-turn gate
// measured 77 ms p95 alone and 116 to 130 ms inside the parallel run. `*.latency.integration.test.ts`
// files therefore run as their own suite, one fork, after the parallel integration pass.
const latencySuite = process.env.BOLT_TEST_SUITE === 'latency';

export default defineConfig({
	plugins: [
		{
			name: 'bolt:sibling-subpath-imports',
			enforce: 'pre',
			// Vite's own alias pass runs before any user plugin, so the specifier arrives already
			// rewritten to this package's `src`; map it back before consulting the sibling's manifest.
			resolveId(specifier, importer) {
				if (importer === undefined) return null;
				const subpath = specifier.startsWith('#lib/')
					? specifier
					: specifier.startsWith(`${source}/`)
						? `#lib${specifier.slice(source.length)}`
						: undefined;
				return subpath === undefined ? null : resolveSiblingSubpath(subpath, importer);
			}
		},
		svelte()
	],
	resolve: {
		alias: {
			$lib: source,
			'#lib': source
		},
		conditions: ['svelte', 'browser']
	},
	test: {
		environment: 'node',
		include: latencySuite
			? ['tests/*.latency.integration.test.ts']
			: integrationSuite
				? ['tests/*.integration.test.ts']
				: ['tests/*.test.ts'],
		exclude: latencySuite
			? ['build/**', '.norbital/**']
			: integrationSuite
				? [
						'build/**',
						'.norbital/**',
						'tests/*.latency.integration.test.ts',
						...(process.env.OPENROUTER_API_KEY ? [] : ['tests/*.live.integration.test.ts'])
					]
				: ['build/**', '.norbital/**', 'tests/*.integration.test.ts'],
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		pool: 'forks',
		// Compiler workers also start TypeScript programs and temporary workspace builds. Reserve half
		// the available CPUs for that work, capped at four forks: a fixed four oversubscribes smaller
		// CI runners and pushes cold Drizzle imports beyond the unchanged unit-test deadline.
		maxWorkers: latencySuite ? 1 : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
		// Compiler workers sharing a small Actions runner push database boot and an in-process TypeScript
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
