import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const alias = { $lib: fileURLToPath(new URL('./src', import.meta.url)) };

// Three projects, because the three halves of this package need different schedules.
//
// `node` is the fast server-side runtime. Suites that boot a real Postgres do so in their own
// isolated container on a dynamically mapped port (tests/support/pg-harness.ts), so concurrent
// files cannot collide — these run in parallel.
//
// `node-runtime` is the real-runtime integration half: every suite here boots a workspace bundle
// through tests/support/pod-runtime-harness.ts, and those builds serialize on a per-template lock
// whose wait deadline does not survive six workers queueing on it. These run serially, one file at
// a time, and the parallel half never overlaps them.
//
// `components` mounts Svelte surfaces in happy-dom. That is a DOM, not a browser: it has no layout,
// no paint and no assistive-technology tree, so it can prove what a component renders and does and
// nothing about how it looks. Browser-level behaviour belongs in the template suites.
const runtimeHarnessSuites = [
	'tests/standalone/**',
	'tests/**/*e2e*.test.ts',
	'tests/sync-engine/sync-compaction-reset.test.ts',
	'tests/sync-engine/sync-runtime-contract.test.ts',
	'tests/runtime/workspace-settings.test.ts'
] as const;

export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: 'node',
					include: ['tests/**/*.test.ts'],
					exclude: [...configDefaults.exclude, 'tests/components/**', ...runtimeHarnessSuites],
					environment: 'node',
					testTimeout: 60_000,
					hookTimeout: 120_000,
					maxWorkers: 6
				}
			},
			{
				resolve: { alias },
				test: {
					name: 'node-runtime',
					include: [...runtimeHarnessSuites],
					environment: 'node',
					testTimeout: 60_000,
					hookTimeout: 120_000,
					fileParallelism: false,
					maxWorkers: 6
				}
			},
			{
				plugins: [svelte()],
				resolve: {
					alias: {
						...alias,
						// Iconify fetches its glyphs from api.iconify.design at render time. A suite that
						// reaches the network fails when the network does, and no assertion here is about
						// the drawing — see the stub for what it keeps.
						'@iconify/svelte': fileURLToPath(
							new URL('./tests/support/icon-stub.svelte', import.meta.url)
						)
					},
					conditions: ['browser']
				},
				// Vitest transforms these files through Vite's SSR pipeline even in a DOM environment,
				// so without this `svelte` resolves to its server build and `mount` is not a function
				// that exists. `externalConditions` is the half that reaches packages under node_modules.
				ssr: { resolve: { conditions: ['browser'], externalConditions: ['browser'] } },
				test: {
					name: 'components',
					include: ['tests/components/**/*.test.ts'],
					environment: 'happy-dom',
					setupFiles: ['tests/components/setup.ts'],
					maxWorkers: 6
				}
			}
		]
	}
});
