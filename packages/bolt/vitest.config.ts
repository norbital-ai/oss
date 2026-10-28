import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
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
			const middleware = (
				req: { url?: string; method?: string; on(event: string, cb: () => void): void },
				res: {
					writeHead(code: number, headers: Record<string, string>): void;
					write(chunk: string): void;
					end(): void;
				},
				next: () => void
			) => {
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
// browser files follow https://vitest.dev/guide/browser/; every other `*.test.ts` is unit. Each project is
// self-contained (`extends: false`): none inherits the root's plugins or test options.
const integrationSuite = process.env.BOLT_TEST_SUITE === 'integration';
const positiveInteger = (name: string, fallback: number): number => {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer`);
	return value;
};
// The package's worker setting is also bounded by the whole-realm allocation.
const packageWorkers = positiveInteger(
	'BOLT_TEST_MAX_WORKERS',
	Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
);
const workers = Math.min(packageWorkers, positiveInteger('VITEST_MAX_WORKERS', packageWorkers));

export default defineConfig({
	plugins: [liveFixture(), svelte()],
	resolve: { conditions: ['svelte', 'browser'] },
	test: {
		isolate: true,
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
		sequence: { concurrent: false },
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.d.ts'],
			reporter: ['text', 'json-summary']
		},
		projects: integrationSuite
			? [
					{
						extends: false,
						plugins: [svelte()],
						resolve: { conditions: ['svelte', 'browser'] },
						test: {
							name: 'integration',
							include: ['tests/*.integration.test.ts'],
							exclude: ['build/**', '.norbital/**'],
							pool: 'forks',
							execArgv: ['--no-node-snapshot'],
							maxWorkers: workers,
							testTimeout: 15_000
						}
					}
				]
			: [
					{
						extends: false,
						plugins: [svelte()],
						resolve: { conditions: ['svelte', 'browser'] },
						test: {
							name: 'unit',
							environment: 'node',
							// happy-dom 21 loads no stylesheet or iframe unless asked: the shell's asset readiness waits on one, a PDF preview on the other
							environmentOptions: {
								happyDOM: { settings: { enableCSSFileLoading: true, enableIframePageLoading: true } }
							},
							include: ['tests/*.test.ts'],
							exclude: [
								'build/**',
								'.norbital/**',
								'tests/*.integration.test.ts',
								'tests/*.browser.test.ts'
							],
							pool: 'forks',
							execArgv: ['--no-node-snapshot'],
							maxWorkers: workers,
							testTimeout: 5_000,
							sequence: { groupOrder: 0 }
						}
					},
					{
						extends: false,
						plugins: [liveFixture(), svelte(), tailwindcss()],
						optimizeDeps: { include: ['@norbital-ai/ui > leaflet'] },
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
