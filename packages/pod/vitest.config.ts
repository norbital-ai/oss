import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const alias = { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) };

// Two projects, because the two halves of this package need opposite environments.
//
// `node` is the server-side runtime. It runs against a real Postgres (see tests/support/pg-harness.ts)
// because the sync-engine safe-watermark and _ops_guard behaviours depend on genuine multi-connection
// concurrency and cannot be exercised on PGlite, and it is serial for the same reason.
//
// `components` mounts Svelte surfaces in happy-dom. That is a DOM, not a browser: it has no layout,
// no paint and no assistive-technology tree, so it can prove what a component renders and does and
// nothing about how it looks. docs/HANDOFF.md records where that line falls.
export default defineConfig({
	test: {
		projects: [
			{
				resolve: { alias },
				test: {
					name: 'node',
					include: ['tests/**/*.test.ts'],
					exclude: [...configDefaults.exclude, 'tests/components/**'],
					environment: 'node',
					testTimeout: 60_000,
					hookTimeout: 120_000,
					fileParallelism: false,
					maxWorkers: 1
				}
			},
			{
				plugins: [svelte()],
				resolve: { alias, conditions: ['browser'] },
				// Vitest transforms these files through Vite's SSR pipeline even in a DOM environment,
				// so without this `svelte` resolves to its server build and `mount` is not a function
				// that exists. `externalConditions` is the half that reaches packages under node_modules.
				ssr: { resolve: { conditions: ['browser'], externalConditions: ['browser'] } },
				test: {
					name: 'components',
					include: ['tests/components/**/*.test.ts'],
					environment: 'happy-dom',
					setupFiles: ['tests/components/setup.ts']
				}
			}
		]
	}
});
