import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Same-origin SSE for Chromium `EventSource` tests — not a second live server. */
function liveFixture(): Plugin {
	const hello = JSON.stringify({ t: 'hello', conn: 'browser', v: 0 });
	const patch = JSON.stringify({ t: 'patch', view: 'orders', v: 1, ops: [] });
	return {
		name: 'bolt:live-fixture',
		configureServer(server) {
			const middleware = (req: { url?: string; method?: string; on(event: string, cb: () => void): void }, res: { writeHead(code: number, headers: Record<string, string>): void; write(chunk: string): void; end(): void }, next: () => void) => {
				const path = (req.url ?? '').split('?')[0];
				if (path !== '/__bolt/live' || req.method !== 'GET') {
					next();
					return;
				}
				res.writeHead(200, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					'Access-Control-Allow-Origin': '*'
				});
				res.write(`data: ${hello}\n\n`);
				res.write(`data: ${patch}\n\n`);
				const beat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
				req.on('close', () => {
					clearInterval(beat);
					res.end();
				});
			};
			server.middlewares.use(middleware);
		}
	};
}

// Suites split by filename: `*.integration.test.ts` needs PGlite (`BOLT_TEST_SUITE=integration`);
// browser files follow https://vitest.dev/guide/browser/; every other `*.test.ts` is unit.
const integrationSuite = process.env.BOLT_TEST_SUITE === 'integration';
const workers = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));

export default defineConfig({
	plugins: [liveFixture(), svelte()],
	resolve: { conditions: ['svelte', 'browser'] },
	test: {
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		sequence: { concurrent: false },
		coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.d.ts'], reporter: ['text', 'json-summary'] },
		projects: integrationSuite
			? [
					{
						plugins: [svelte()],
						resolve: { conditions: ['svelte', 'browser'] },
						test: {
							name: 'integration',
							include: ['tests/*.integration.test.ts'],
							exclude: ['build/**', '.norbital/**'],
							pool: 'forks',
							maxWorkers: workers,
							testTimeout: 15_000
						}
					}
				]
			: [
					{
						plugins: [svelte()],
						resolve: { conditions: ['svelte', 'browser'] },
						test: {
							name: 'unit',
							environment: 'node',
							include: ['tests/*.test.ts'],
							exclude: ['build/**', '.norbital/**', 'tests/*.integration.test.ts', 'tests/*.browser.test.ts'],
							pool: 'forks',
							maxWorkers: workers,
							testTimeout: 5_000,
							sequence: { groupOrder: 0 }
						}
					},
					{
						plugins: [liveFixture(), svelte()],
						test: {
							name: 'browser',
							include: ['tests/**/*.browser.{test,spec}.ts'],
							exclude: ['build/**', '.norbital/**'],
							testTimeout: 30_000,
							sequence: { groupOrder: 1 },
							browser: {
								enabled: true,
								provider: playwright(),
								instances: [{ browser: 'chromium' }],
								headless: process.env['PLAYWRIGHT_HEADED'] !== '1'
							}
						}
					}
				]
	},
	optimizeDeps: {
		include: [
			'runed',
			'@codemirror/lang-javascript',
			'@codemirror/lang-json',
			'@codemirror/language',
			'@codemirror/state',
			'@codemirror/view',
			'@iconify/svelte',
			'@internationalized/date',
			'@lezer/highlight',
			'@xyflow/svelte',
			'bits-ui',
			'codemirror',
			'layerchart',
			'leaflet',
			'marked',
			'qrcode',
			'tailwind-merge',
			'tailwind-variants'
		]
	},
	server: { fs: { strict: true, allow: [fileURLToPath(new URL('../..', import.meta.url))] } }
});
