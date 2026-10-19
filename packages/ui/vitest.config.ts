import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [svelte()],
	resolve: { conditions: ['svelte', 'browser'] },
	test: {
		include: ['tests/*.test.ts'],
		environment: 'happy-dom',
		pool: 'forks',
		// Node's optional storage globals hide the browser storage supplied by happy-dom.
		execArgv: ['--no-experimental-webstorage'],
		maxWorkers: 2,
		isolate: true,
		restoreMocks: true,
		unstubGlobals: true,
		sequence: { concurrent: false },
		setupFiles: ['tests/dom.ts']
	}
});
