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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schema } from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { authorErrors, holdingBuildSlot, watchRebuildOptions } from '../src/cli/build.ts';
import { suiteWorkers, testWorkspace, workers } from '../src/cli/test.ts';
import {
	Ai,
	Convert,
	DatabaseRequest,
	DbError,
	Files,
	Port,
	Render,
	WebRead
} from '../src/test/index.ts';

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

it.live('parallel checkouts with shared dependencies use separate Vitest module caches', () =>
	Effect.gen(function* () {
		const cwd = process.cwd();
		const dir = yield* Effect.acquireRelease(
			Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'bolt-shared-deps-')))),
			(created) =>
				Effect.sync(() => {
					process.chdir(cwd);
					rmSync(created, { force: true, recursive: true });
				})
		);
		const shared = join(dir, 'deps');
		mkdirSync(shared);
		const vitest = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));
		symlinkSync(vitest, join(shared, 'vitest'), 'dir');
		const seen: string[] = [];
		for (const name of ['one', 'two']) {
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
					configResolved(config) { writeFileSync(${JSON.stringify(join(root, 'cache-path'))}, config.test.fsModuleCachePath); }
				}] };
			`
			);
			yield* testWorkspace(root, ['--maxWorkers=1']);
			const cachePath = readFileSync(join(root, 'cache-path'), 'utf8');
			expect(cachePath).toBe(join(root, '.norbital', 'cache', 'vitest'));
			seen.push(cachePath);
		}
		expect(new Set(seen).size).toBe(2);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);

it('watchRebuildOptions always uses migrations verify so steady-state saves never mutate migrations/', () => {
	const log = () => {};
	expect(watchRebuildOptions({ log, spaServed: true }, ['src/a.ts'])).toEqual({
		log,
		changed: ['src/a.ts'],
		migrations: 'verify',
		spaServed: true
	});
});

it('re-exports host port Effect services and types from the public test entry', () => {
	for (const exported of [Ai, Convert, Files, Render, WebRead, Port, DatabaseRequest, DbError])
		expect(exported).toBeDefined();
});

it.live('holdingBuildSlot caps concurrent builds to the configured slot count', () =>
	Effect.gen(function* () {
		const slotsDir = yield* Effect.acquireRelease(
			Effect.sync(() => realpathSync(mkdtempSync(join(tmpdir(), 'bolt-build-slots-')))),
			(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
		);
		const entered: number[] = [];
		const started1 = yield* Deferred.make<void>();
		const started2 = yield* Deferred.make<void>();
		const started3 = yield* Deferred.make<void>();
		const gate1 = yield* Deferred.make<void>();
		const gate2 = yield* Deferred.make<void>();
		const gate3 = yield* Deferred.make<void>();
		const run = (
			id: number,
			started: Deferred.Deferred<void>,
			gate: Deferred.Deferred<void>
		) =>
			holdingBuildSlot(
				Effect.gen(function* () {
					entered.push(id);
					yield* Deferred.succeed(started, undefined);
					yield* Deferred.await(gate);
				}),
				{ dir: slotsDir, slots: 2 }
			);
		const f1 = yield* Effect.forkChild(run(1, started1, gate1));
		const f2 = yield* Effect.forkChild(run(2, started2, gate2));
		yield* Deferred.await(started1);
		yield* Deferred.await(started2);
		const f3 = yield* Effect.forkChild(run(3, started3, gate3));
		yield* Effect.yieldNow;
		expect(entered.toSorted()).toEqual([1, 2]);
		yield* Deferred.succeed(gate1, undefined);
		yield* Fiber.join(f1);
		yield* Deferred.await(started3);
		expect(entered.toSorted()).toEqual([1, 2, 3]);
		yield* Deferred.succeed(gate2, undefined);
		yield* Deferred.succeed(gate3, undefined);
		yield* Fiber.join(f2);
		yield* Fiber.join(f3);
	}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
