/**
 * Build a package's `build/` directory without ever leaving it missing.
 *
 * Deleting `build/` and recompiling leaves a multi-second hole: anything reading the package then
 * fails as if a dependency were missing, and Turbo's ordering cannot close it once a consumer's
 * pinned version stops matching the workspace version. So the build compiles into a staging
 * directory and swaps it in with two renames; a reader can still lose the race, but the window is
 * two syscalls rather than a whole compile.
 *
 * The two checks bracketing the compile guard the opposite failure — a build that succeeds against
 * a hole someone else left. A compiler handed an unbuilt workspace dependency does not stop; it
 * infers `any` and emits it, exit 0. So the dependency's `build/` is required before the compiler
 * starts, and the emitted declarations are read back before the swap. Both are a few milliseconds
 * against a multi-second compile, which is what lets them run on every build rather than only in
 * CI — including the `prepack` build that produces a publishable tarball.
 *
 * The staging directory is a scoped resource and the compiler a child of a nested scope. An
 * interrupted build (SIGINT or SIGTERM, through `runMain`) kills the compiler, waits for it to
 * exit, and only then removes the staging directory, so no `build.staging-*` outlives its build.
 *
 * Usage: `node build-package.ts <command> [...args]`; `{}` in an argument expands to the staging
 * directory.
 */
import path from 'node:path';
import process from 'node:process';
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Console, Effect, FileSystem, Runtime, Schema } from 'effect';
import { ChildProcess } from 'effect/process';
import { assertDeclarationEmit } from './lib/declaration-emit.ts';

/** A refusal this program reports itself, as one `[build]` message. */
class BuildFailed extends Schema.TaggedError<BuildFailed>()('BuildFailed', {
	message: Schema.String
}) {
	readonly [Runtime.errorReported] = false;
}

const StringMap = Schema.optional(Schema.Record(Schema.String, Schema.String));

/** The package manifest fields a build reads. */
const Manifest = Schema.Struct({
	name: Schema.String,
	bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
	scripts: StringMap,
	dependencies: StringMap,
	devDependencies: StringMap,
	peerDependencies: StringMap
});

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const readManifest = Effect.fn('buildPackage.readManifest')(function* (file: string) {
	const fs = yield* FileSystem.FileSystem;
	const text = yield* fs.readFileString(file);
	return yield* decodeManifest(text).pipe(
		Effect.mapError((error) => new BuildFailed({ message: `${file}: ${error.message}` }))
	);
});

/**
 * Refuse to compile against a workspace dependency that has not been built.
 *
 * pnpm links a `workspace:` dependency as a symlink to the real package directory, so the check is
 * a `realpath` and a `readdir` per edge. A dependency with no `build` script has nothing to wait
 * for; one that has a build script but no output is the exact condition that poisons the emit.
 */
const assertDependenciesBuilt = Effect.fn('buildPackage.assertDependenciesBuilt')(function* (
	packageRoot: string,
	manifest: typeof Manifest.Type
) {
	const fs = yield* FileSystem.FileSystem;
	const names = new Set(
		[manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
			.flatMap((section) => Object.entries(section ?? {}))
			.filter(([, specifier]) => specifier.startsWith('workspace:'))
			.map(([name]) => name)
	);
	for (const name of [...names].sort()) {
		const link = path.join(packageRoot, 'node_modules', name);
		if (!(yield* fs.exists(link)))
			return yield* new BuildFailed({
				message:
					`${manifest.name} declares ${name} but it is not installed. ` +
					'Run `pnpm install` before building.'
			});
		const dependencyRoot = yield* fs.realPath(link);
		const dependency = yield* readManifest(path.join(dependencyRoot, 'package.json'));
		if (!dependency.scripts?.build) continue;
		const dependencyOutput = path.join(dependencyRoot, 'build');
		if (
			(yield* fs.exists(dependencyOutput)) &&
			(yield* fs.readDirectory(dependencyOutput)).length > 0
		)
			continue;
		return yield* new BuildFailed({
			message:
				`${manifest.name} cannot compile: ${name} has no build output at ` +
				`${path.relative(packageRoot, dependencyOutput)}.\n` +
				'Compiling anyway would resolve its exports to `any` and emit that as this ' +
				"package's public types, with exit 0.\n" +
				'Build dependencies first: `pnpm packages:build`.'
		});
	}
});

const program = Effect.gen(function* () {
	const [command, ...commandArguments] = process.argv.slice(2);
	if (command === undefined)
		return yield* new BuildFailed({
			message: 'usage: build-package.ts <command> [...args]   # `{}` expands to the staging dir'
		});
	const fs = yield* FileSystem.FileSystem;
	const packageRoot = process.cwd();
	const output = path.join(packageRoot, 'build');
	const manifest = yield* readManifest(path.join(packageRoot, 'package.json'));
	yield* assertDependenciesBuilt(packageRoot, manifest);

	// Released on success, failure and interruption alike; the compiler's scope closes first.
	const staging = yield* Effect.acquireRelease(
		fs.makeTempDirectory({ directory: packageRoot, prefix: 'build.staging-' }),
		(directory) => Effect.orDie(fs.remove(directory, { recursive: true, force: true }))
	);
	// `{}` is this invocation's staging directory, never another compiler's output.
	const code = yield* Effect.scoped(
		Effect.flatMap(
			ChildProcess.make(
				command,
				commandArguments.map((argument) => argument.replaceAll('{}', staging)),
				{ cwd: packageRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
			),
			(compiler) => compiler.exitCode
		)
	);
	if (code !== 0)
		return yield* new BuildFailed({ message: `${command} exited with code ${code}.` });
	if ((yield* fs.readDirectory(staging)).length === 0)
		return yield* new BuildFailed({
			message: `${command} produced no output at ${path.relative(packageRoot, staging)}`
		});

	// Refuse poisoned declarations before swapping or packing the output.
	yield* assertDeclarationEmit({
		declarationRoot: staging,
		packageDirectory: path.basename(packageRoot),
		label: `${manifest.name} build output`,
		resolveImports: true
	}).pipe(Effect.mapError((cause) => new BuildFailed({ message: cause.message })));

	// npm rejects a bin target without executable mode, even when its source had a shebang.
	const binTargets =
		typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
	for (const target of binTargets) {
		const relativeTarget = path.relative('build', target.replace(/^\.\//, ''));
		if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) continue;
		const stagedTarget = path.join(staging, relativeTarget);
		if (!(yield* fs.exists(stagedTarget)))
			return yield* new BuildFailed({ message: `declared binary was not generated: ${target}` });
		yield* fs.chmod(stagedTarget, 0o755);
	}

	// Preserve recoverable retired output if either rename fails; only staging is always released.
	const retired = `${staging}.retired`;
	if (yield* fs.exists(output)) yield* fs.rename(output, retired);
	yield* fs.rename(staging, output);
	yield* fs.remove(retired, { recursive: true, force: true });
}).pipe(Effect.scoped);

NodeRuntime.runMain(
	program.pipe(
		Effect.tapErrorTag('BuildFailed', (error) => Console.error(`[build] ${error.message}`)),
		Effect.provide(NodeServices.layer)
	)
);
