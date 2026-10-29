import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { expect, layer } from '@effect/vitest';
import { Effect, Fiber, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess, type ChildProcessSpawner } from 'effect/process';

const buildScript = fileURLToPath(new URL('../build-package.ts', import.meta.url));

/** Compiler source that writes `files` (staged path → contents) into the staging directory. */
const emitting = (
	files: Record<string, string>
) => `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const output = process.argv[2];
for (const [relative, contents] of ${JSON.stringify(Object.entries(files))}) {
	mkdirSync(path.join(output, path.dirname(relative)), { recursive: true });
	writeFileSync(path.join(output, relative), contents);
}
`;

/** A scoped package directory declaring `manifest`; its compiler `emit.mjs` runs `emitter`. */
const scaffold = (manifest: object, emitter: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const packageRoot = yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-build-package-' });
		yield* fs.writeFileString(path.join(packageRoot, 'package.json'), JSON.stringify(manifest));
		yield* fs.writeFileString(path.join(packageRoot, 'emit.mjs'), emitter);
		return packageRoot;
	});

/** Start the build wrapper in `packageRoot` with `emit.mjs`; `extra` follows the staging dir. */
const start = (packageRoot: string, ...extra: Array<string>) =>
	ChildProcess.make(process.execPath, [buildScript, process.execPath, 'emit.mjs', '{}', ...extra], {
		cwd: packageRoot
	});

/** Run the build wrapper to completion: its exit code and combined output. */
const build = (packageRoot: string, ...extra: Array<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* start(packageRoot, ...extra);
			const [output, code] = yield* Effect.all(
				[Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
				{ concurrency: 2 }
			);
			return { code, output };
		})
	);

/** Wait until the compiler prints `staged`: its staging directory holds output. */
const staged = (handle: ChildProcessSpawner.ChildProcessHandle) =>
	Stream.decodeText(handle.stdout).pipe(
		Stream.splitLines,
		Stream.takeUntil((line) => line === 'staged'),
		Stream.runDrain
	);

const stagingDirectories = (packageRoot: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const names = yield* fs.readDirectory(packageRoot);
		return names.filter((name) => name.startsWith('build.staging'));
	});

const hasBuild = (packageRoot: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		return yield* fs.exists(path.join(packageRoot, 'build'));
	});

layer(NodeServices.layer, { excludeTestServices: true })('build-package', (it) => {
	it.effect('turbo hashes the build script and every module it imports', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const ossRoot = path.resolve(path.dirname(buildScript), '..');
			const turbo = yield* fs.readFileString(path.join(ossRoot, 'turbo.json'));
			const { globalDependencies } = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(Schema.Struct({ globalDependencies: Schema.Array(Schema.String) }))
			)(turbo.replace(/^\s*\/\/.*$/gm, ''));
			// without them turbo replays a build from before an edit to the script or its checks
			const pending = [buildScript];
			for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
				expect(globalDependencies).toContain(path.relative(ossRoot, file));
				for (const [, relative] of (yield* fs.readFileString(file)).matchAll(
					/from '(\.\.?\/[^']+)'/g
				))
					if (relative !== undefined) pending.push(path.resolve(path.dirname(file), relative));
			}
		})
	);
	it.effect('keeps a generated package binary executable for npm publication', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const packageRoot = yield* scaffold(
				{ name: 'probe', bin: { probe: './build/bin/probe.js' } },
				emitting({ 'bin/probe.js': '#!/usr/bin/env node\n' })
			);

			const { code, output } = yield* build(packageRoot);
			expect(code, output).toBe(0);

			const binary = path.join(packageRoot, 'build/bin/probe.js');
			expect(yield* fs.readFileString(binary)).toBe('#!/usr/bin/env node\n');
			expect((yield* fs.stat(binary)).mode & 0o111).not.toBe(0);
		})
	);

	it.effect('refuses to compile against a workspace dependency that has not been built', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dependencyRoot = yield* fs.makeTempDirectoryScoped({
				prefix: 'norbital-build-dependency-'
			});
			yield* fs.writeFileString(
				path.join(dependencyRoot, 'package.json'),
				JSON.stringify({ name: '@probe/dep', scripts: { build: 'noop' } })
			);
			const packageRoot = yield* scaffold(
				{ name: 'probe', dependencies: { '@probe/dep': 'workspace:*' } },
				emitting({ 'index.js': 'export {};\n' })
			);
			yield* fs.makeDirectory(path.join(packageRoot, 'node_modules/@probe'), { recursive: true });
			yield* fs.symlink(dependencyRoot, path.join(packageRoot, 'node_modules/@probe/dep'));

			const failed = yield* build(packageRoot);
			expect(failed.code).toBe(1);
			expect(failed.output).toMatch(/@probe\/dep has no build output/);
			expect(yield* hasBuild(packageRoot)).toBe(false);

			// The same build succeeds the moment the dependency has output to compile against.
			yield* fs.makeDirectory(path.join(dependencyRoot, 'build'), { recursive: true });
			yield* fs.writeFileString(path.join(dependencyRoot, 'build/index.js'), 'export {};\n');
			expect((yield* build(packageRoot)).code).toBe(0);
		})
	);

	it.effect('discards a build whose declarations degraded to `any`', () =>
		Effect.gen(function* () {
			const packageRoot = yield* scaffold(
				{ name: 'probe' },
				emitting({ 'index.d.ts': 'export declare const schema: any;\n' })
			);

			const failed = yield* build(packageRoot);
			expect(failed.code).toBe(1);
			expect(failed.output).toMatch(/index\.d\.ts:1/);
			// Nothing is swapped in, so a poisoned emit can never be packed or published.
			expect(yield* hasBuild(packageRoot)).toBe(false);
			expect(yield* stagingDirectories(packageRoot)).toEqual([]);
		})
	);

	it.effect('discards a build whose declarations name a module a consumer cannot resolve', () =>
		Effect.gen(function* () {
			// The shape that typed every custom column `any`: a deep import of a module the installed
			// dependency does not ship. Comments, side-effect imports and node builtins are not modules.
			const packageRoot = yield* scaffold(
				{ name: 'probe' },
				emitting({
					'index.d.ts': [
						"import type { Missing } from 'no-such-package/Missing';",
						"import 'no-such-package/style.css';",
						"import type { Resolver } from 'node:dns';",
						"/** Rejects anything from 'unreadable' input. */",
						'export declare const value: Missing;',
						'export declare const resolver: Resolver;'
					].join('\n')
				})
			);

			const failed = yield* build(packageRoot);
			expect(failed.code).toBe(1);
			expect(failed.output).toMatch(/cannot resolve/);
			expect(failed.output).toMatch(/index\.d\.ts: no-such-package\/Missing/);
			expect(failed.output).not.toMatch(/style\.css|node:dns|unreadable/);
			expect(yield* hasBuild(packageRoot)).toBe(false);
		})
	);

	it.effect('reads `any` in a doc comment as prose rather than a degraded type', () =>
		Effect.gen(function* () {
			const packageRoot = yield* scaffold(
				{ name: 'probe' },
				emitting({
					'index.d.ts':
						'/** Rejects any payload the host did not sign. */\nexport declare const guard: (value: string) => boolean;\n'
				})
			);
			expect((yield* build(packageRoot)).code).toBe(0);
		})
	);

	it.effect('accepts `any` as a declared property name while still rejecting the any type', () =>
		Effect.gen(function* () {
			const valid = yield* scaffold(
				{ name: 'probe' },
				emitting({
					'index.d.ts':
						'export interface MatcherSet { any: ReadonlyArray<string>; }\nexport declare const set: MatcherSet;\n'
				})
			);
			expect((yield* build(valid)).code).toBe(0);

			const invalid = yield* scaffold(
				{ name: 'probe' },
				emitting({ 'index.d.ts': 'export interface MatcherSet { any: ReadonlyArray<any>; }\n' })
			);
			const failed = yield* build(invalid);
			expect(failed.code).toBe(1);
			expect(failed.output).toMatch(/index\.d\.ts:1/);
		})
	);

	it.effect('a second build of the package waits for the first, then swaps in its own output', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const packageRoot = yield* scaffold(
				{ name: 'probe' },
				`import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const output = process.argv[2], mode = process.argv[3];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'index.js'), mode);
if (mode === 'first') {
	process.stdout.write('staged\\n');
	await new Promise((resolve) => process.stdin.once('data', resolve));
	if (readFileSync(path.join(output, 'index.js'), 'utf8') !== mode) throw new Error('foreign staging output');
}
`
			);
			const first = yield* start(packageRoot, 'first');
			yield* staged(first);

			const second = yield* build(packageRoot, 'second').pipe(Effect.forkChild);
			yield* Effect.sleep('1 second');
			expect(second.pollUnsafe(), 'the second build waits on .building').toBeUndefined();

			yield* Stream.run(Stream.encodeText(Stream.make('continue')), first.stdin);
			expect(yield* first.exitCode).toBe(0);
			const done = yield* Fiber.join(second);
			expect(done.code, done.output).toBe(0);
			expect(yield* fs.readFileString(path.join(packageRoot, 'build/index.js'))).toBe('second');
		})
	);

	it.effect('a missing declared binary releases only this build’s staging directory', () =>
		Effect.gen(function* () {
			const packageRoot = yield* scaffold(
				{ name: 'probe', bin: { probe: 'build/bin/cli.js' } },
				emitting({ 'index.js': 'export {};\n' })
			);

			const failed = yield* build(packageRoot);
			expect(failed.code).toBe(1);
			expect(failed.output).toMatch(/declared binary was not generated/);
			expect(yield* hasBuild(packageRoot)).toBe(false);
			expect(yield* stagingDirectories(packageRoot)).toEqual([]);
		})
	);

	it.effect('SIGINT kills the compiler and removes its staging directory', () =>
		Effect.gen(function* () {
			// The compiler stages output, then runs until it is killed (or its stdin closes).
			const packageRoot = yield* scaffold(
				{ name: 'probe' },
				`${emitting({ 'index.js': 'export {};\n' })}process.stdout.write('staged\\n');
for await (const _ of process.stdin);
`
			);
			const interrupted = yield* start(packageRoot);
			yield* staged(interrupted);
			expect(yield* stagingDirectories(packageRoot)).toHaveLength(1);

			yield* interrupted.kill({ killSignal: 'SIGINT' });
			expect(yield* interrupted.exitCode).toBe(130);
			expect(yield* stagingDirectories(packageRoot)).toEqual([]);
			expect(yield* hasBuild(packageRoot)).toBe(false);
		})
	);
});
