// File runs' host half (compute model §3, "Running a file", P24): Node's resolution over a tree and the confined
// bundler process — one tenant per process, a cache hit bundles nothing, every error at the author's file and line.
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { resolver } from '../src/node/bundler/resolver.ts';
import { bundler } from '../src/node/bundler/index.ts';
import type { Bundled } from '../src/engine/contracts.ts';
import { treeDigest } from '../src/engine/artifact/read.ts';
import { BROKEN, filesOf, RENDER, REPORT, type Tree } from './support/run-file-trees.ts';

const mounted = (tree: Tree) =>
	new Map(filesOf(tree).map(([path, bytes]) => [`/app/${path}`, bytes] as const));
const request = (tree: Tree, entry: string) => {
	const files = filesOf(tree);
	return { digest: treeDigest(files), entry, files };
};
const errorsOf = (bundled: Bundled) => ('errors' in bundled ? bundled.errors : []);

describe('the file-run resolver', () => {
	it('resolves by Node’s rules inside the tree only', () => {
		const resolve = resolver(
			mounted({
				...REPORT,
				...RENDER,
				'scripts/addon.node': 'x',
				'scripts/data/index.json': '{}'
			})
		);
		const from = '/app/scripts/report.js';
		expect(resolve('./lib/summarize', from, 'require')).toEqual({
			path: '/app/scripts/lib/summarize.js'
		});
		expect(resolve('../../shared', '/app/scripts/lib/summarize.js', 'require')).toEqual({
			path: '/app/shared/index.js'
		});
		expect(resolve('./data', from, 'require')).toEqual({ path: '/app/scripts/data/index.json' });
		expect(resolve('dayjs', from, 'require')).toEqual({
			path: '/app/node_modules/dayjs/dayjs.min.js'
		});
		expect(resolve('mdlite', '/app/scripts/render.mjs', 'import')).toEqual({
			path: '/app/node_modules/mdlite/index.mjs'
		});
		// the ES-module-only package has no require condition
		expect(resolve('mdlite', from, 'require')).toEqual({ error: "Cannot find module 'mdlite'" });
		expect(resolve('node:fs/promises', from, 'import')).toEqual({ builtin: 'fs/promises' });
		expect(resolve('buffer', from, 'require')).toEqual({ builtin: 'buffer' });
		expect(resolve('node:child_process', from, 'import')).toEqual({
			error: "'node:child_process' is not available in run_js"
		});
		expect(resolve('zlib', from, 'require')).toEqual({
			error: "'zlib' is not available in run_js"
		});
		expect(resolve('../../../etc/passwd', from, 'require')).toEqual({
			error: "'../../../etc/passwd' is outside the file's tree"
		});
		expect(resolve('/etc/hosts', from, 'import')).toEqual({
			error: "'/etc/hosts' is outside the file's tree"
		});
		expect(resolve('./addon.node', from, 'require')).toEqual({
			error: "'./addon.node' is a native addon; not available in run_js"
		});
		expect(resolve('left-pad', from, 'require')).toEqual({
			error: "Cannot find module 'left-pad'"
		});
	});
});

describe('the confined bundler', () => {
	it.live(
		'bundles a CommonJS script and an ES module as written, each once per tree, entry and version',
		() =>
			Effect.gen(function* () {
				const billed: string[] = [];
				const host = yield* bundler({ meter: (tenant) => void billed.push(tenant) });
				const port = host.port('acme');
				const report = yield* Effect.promise((signal) =>
					port.bundle(request(REPORT, 'scripts/report.js'), signal)
				);
				expect(errorsOf(report)).toEqual([]);
				if (!('code' in report)) return;
				// one module that imports nothing, mapped to the tree's own paths
				expect(report.code).not.toMatch(/^\s*import\s/m);
				expect(report.code).toMatch(/\.builtin\(["']fs["']\)/);
				expect(JSON.parse(report.map).sources).toEqual(
					expect.arrayContaining([
						'scripts/report.js',
						'scripts/lib/summarize.js',
						'shared/index.js',
						'node_modules/dayjs/dayjs.min.js'
					])
				);
				const render = yield* Effect.promise((signal) =>
					port.bundle(request(RENDER, 'scripts/render.mjs'), signal)
				);
				expect(errorsOf(render)).toEqual([]);
				expect(host.counts()).toMatchObject({ started: 1, built: 2 });
				// a repeat is a cache hit: no bundling
				const again = yield* Effect.promise((signal) =>
					port.bundle(request(REPORT, 'scripts/report.js'), signal)
				);
				expect(again).toEqual(report);
				expect(host.counts()).toMatchObject({ started: 1, built: 2 });
				// its whole CPU went to the one tenant it served
				expect(billed.length).toBeGreaterThan(0);
				expect(new Set(billed)).toEqual(new Set(['acme']));
			})
	);
	it.live(
		'fails a bundle at the author’s file, line and column',
		() =>
			Effect.gen(function* () {
				const port = (yield* bundler()).port('acme');
				const errors = (entry: string) =>
					Effect.promise((signal) => port.bundle(request(BROKEN, entry), signal)).pipe(
						Effect.map((bundled) => errorsOf(bundled)[0] ?? '')
					);
				expect(yield* errors('scripts/broken.mjs')).toMatch(/^scripts\/lib\/bad\.mjs:3:\d+: /);
				expect(yield* errors('scripts/missing.mjs')).toBe(
					"scripts/missing.mjs:2:25: Cannot find module './lib/nowhere.mjs'\n    import { nothing } from './lib/nowhere.mjs';"
				);
				expect(yield* errors('scripts/no-export.mjs')).toMatch(
					/^scripts\/no-export\.mjs:1:\d+: "subtitle" is not exported by "scripts\/lib\/title\.mjs"/
				);
				expect(yield* errors('scripts/escape.mjs')).toBe(
					"scripts/escape.mjs:1:19: '../../../../../etc/hosts' is outside the file's tree\n    import hosts from '../../../../../etc/hosts';"
				);
				expect(yield* errors('scripts/spawn.mjs')).toBe(
					"scripts/spawn.mjs:1:26: 'node:child_process' is not available in run_js\n    import { execSync } from 'node:child_process';"
				);
				expect(yield* errors('scripts/nowhere.js')).toBe("Cannot find module 'scripts/nowhere.js'");
				// a require() that cannot resolve bundles, and throws when it is called
				const os = yield* Effect.promise((signal) =>
					port.bundle(request(BROKEN, 'scripts/os.js'), signal)
				);
				expect('code' in os && os.code).toContain(
					"'os' is not available in run_js (required by scripts/os.js)"
				);
			})
	);
	it.live(
		'serves one tenant per process: another tenant’s bundle, and one past the recycle threshold, start a fresh one',
		() =>
			Effect.gen(function* () {
				const billed = new Map<string, bigint>();
				const host = yield* bundler({
					meter: (tenant, nanos) => billed.set(tenant, (billed.get(tenant) ?? 0n) + nanos)
				});
				const bundle = (tenant: string) =>
					Effect.promise((signal) =>
						host.port(tenant).bundle(request(REPORT, 'scripts/report.js'), signal)
					);
				yield* bundle('acme');
				const first = host.counts().pid;
				// the same tree for another tenant is not its cache hit, and runs in a process of its own
				yield* bundle('globex');
				expect(host.counts()).toMatchObject({ started: 2, built: 2 });
				expect(host.counts().pid).not.toBe(first);
				expect([...billed.keys()].sort()).toEqual(['acme', 'globex']);
				expect([...billed.values()].every((nanos) => nanos > 0n)).toBe(true);
				const tight = yield* bundler({ recycleBytes: 1 });
				for (const entry of ['scripts/report.js', 'scripts/lib/summarize.js'])
					yield* Effect.promise((signal) =>
						tight.port('acme').bundle(request(REPORT, entry), signal)
					);
				expect(tight.counts()).toMatchObject({ started: 2, built: 2, pid: undefined });
			})
	);
});
