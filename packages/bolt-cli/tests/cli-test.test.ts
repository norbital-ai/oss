/// <reference types="node" />
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { authorErrors } from '../src/cli/build.ts';
import { suiteWorkers, testWorkspace, workers } from '../src/cli/test.ts';

it('a failed build names its first diagnostic, never only a count', () => {
	expect(
		authorErrors([{ code: 'E1', path: 'src/a.ts', message: 'amount is not a decimal' }]).message
	).toBe('1 error: amount is not a decimal');
	expect(authorErrors([]).message).toBe('The workspace could not be built.');
});

it('a suite forks a worker per free core, and only 4 on a busy machine', () => {
	expect(suiteWorkers(0)).toBe(workers);
	expect(suiteWorkers(80)).toBe(Math.min(workers, 4));
	expect(suiteWorkers(workers - 6)).toBe(Math.min(workers, 6));
});

it.live('bolt test generates the fresh checkout config before loading Vitest', () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'bolt-test-fresh-')))),
			(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
		);
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fresh-test-fixture', type: 'module' })
		);
		writeFileSync(
			join(root, 'tsconfig.json'),
			JSON.stringify({ extends: './.norbital/tsconfig.json' })
		);
		mkdirSync(join(root, 'node_modules/vitest'), { recursive: true });
		writeFileSync(
			join(root, 'node_modules/vitest/package.json'),
			JSON.stringify({ name: 'vitest', exports: { './node': null } })
		);
		const generated = join(root, '.norbital', 'tsconfig.json');
		expect(existsSync(generated)).toBe(false);
		// An unavailable runner must not prevent the preflight; block parent/global package resolution too.
		expect(yield* testWorkspace(root, []).pipe(Effect.flip)).toMatchObject({
			_tag: 'ToolFailure',
			message: 'bolt test: vitest is not installed'
		});
		expect(
			Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
				readFileSync(generated, 'utf8')
			)
		).toHaveProperty('compilerOptions');
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it('parallel checkouts with shared dependencies use separate Vitest module caches', async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bolt-shared-deps-')));
	try {
		const shared = join(dir, 'deps');
		mkdirSync(shared);
		const vitest = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
		symlinkSync(vitest, join(shared, 'vitest'), 'dir');
		const cli = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
		const runs = ['one', 'two'].map(async (name) => {
			const root = join(dir, name);
			mkdirSync(root);
			symlinkSync(shared, join(root, 'node_modules'), 'dir');
			writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
			// Record the effective cache path after the real runner applies the workspace plugins.
			writeFileSync(
				join(root, 'vitest.config.mjs'),
				`
				import { writeFileSync } from 'node:fs';
				export default { plugins: [{
					name: 'record-cache',
					configResolved(config) { writeFileSync('cache-path', config.test.fsModuleCachePath); }
				}] };
			`
			);
			await promisify(execFile)(process.execPath, [cli, 'test', root, '--maxWorkers=1'], {
				cwd: root
			});
			expect(readFileSync(join(root, 'cache-path'), 'utf8')).toBe(
				join(root, '.norbital', 'cache', 'vitest')
			);
		});
		const settled = await Promise.allSettled(runs);
		for (const run of settled) if (run.status === 'rejected') throw run.reason;
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});
