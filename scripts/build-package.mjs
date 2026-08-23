#!/usr/bin/env node
/**
 * Build a package's `build/` directory without ever leaving it missing.
 *
 * Every package used to build with `rm -rf build && <compiler> -o build`, which deletes the output
 * and then takes seconds to regenerate it. Anything reading that package during the gap fails, and
 * it fails in a way that reads like a missing dependency rather than a race:
 * `Cannot find module '@norbital-ai/ui/collection-kanban'`.
 *
 * Turbo normally orders builds ahead of their consumers, so the gap is invisible — until the
 * dependency edge disappears. It disappears exactly when a template's pinned version stops matching
 * the workspace version, which is every release: bump `packages/ui` to the next version and turbo no
 * longer believes the templates depend on it. The same race deleted the binary `turbo test` was
 * executing, from a suite that shells out to `build/bin/`.
 *
 * So the fix is not more ordering. It is to stop publishing a hole: compile into a staging
 * directory, then swap it in with two renames. A reader can still lose the race, but the window is
 * two syscalls rather than a whole compile.
 *
 * The two checks bracketing the compile guard the opposite failure — a build that succeeds against
 * a hole someone else left. A compiler handed an unbuilt workspace dependency does not stop; it
 * infers `any` and emits it, exit 0. So the dependency's `build/` is required before the compiler
 * starts, and the emitted declarations are read back before the swap. Both are a few milliseconds
 * against a multi-second compile, which is what lets them run on every build rather than only in
 * CI — including the `prepack` build that produces a publishable tarball.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Effect } from 'effect';
import { assertDeclarationEmit } from './lib/declaration-emit.mjs';
import { readManifest } from './lib/package-release.mjs';

const [command, ...commandArguments] = process.argv.slice(2);
if (!command) {
	console.error('usage: build-package.mjs <command> [...args]   # `{}` expands to the staging dir');
	process.exit(1);
}

const packageRoot = process.cwd();
const output = path.join(packageRoot, 'build');
const staging = path.join(packageRoot, 'build.staging');
const retired = path.join(packageRoot, 'build.retired');
const manifest = readManifest(path.join(packageRoot, 'package.json'));

/**
 * Refuse to compile against a workspace dependency that has not been built.
 *
 * pnpm links a `workspace:` dependency as a symlink to the real package directory, so the check is
 * a `realpath` and a `readdir` per edge. A dependency with no `build` script has nothing to wait
 * for; one that has a build script but no output is the exact condition that poisons the emit.
 */
function assertWorkspaceDependenciesBuilt() {
	const sections = ['dependencies', 'devDependencies', 'peerDependencies'];
	const dependencyNames = new Set(
		sections.flatMap((section) =>
			Object.entries(manifest[section] ?? {})
				.filter(([, specifier]) => String(specifier).startsWith('workspace:'))
				.map(([name]) => name)
		)
	);
	for (const name of [...dependencyNames].sort()) {
		const link = path.join(packageRoot, 'node_modules', name);
		if (!existsSync(link)) {
			console.error(`[build] ${manifest.name} declares ${name} but it is not installed.`);
			console.error('[build] Run `pnpm install` before building.');
			process.exit(1);
		}
		const dependencyRoot = realpathSync(link);
		const dependencyManifest = readManifest(path.join(dependencyRoot, 'package.json'));
		if (!dependencyManifest.scripts?.build) continue;
		const dependencyOutput = path.join(dependencyRoot, 'build');
		if (existsSync(dependencyOutput) && readdirSync(dependencyOutput).length > 0) continue;
		console.error(
			`[build] ${manifest.name} cannot compile: ${name} has no build output at ` +
				`${path.relative(packageRoot, dependencyOutput)}.`
		);
		console.error(
			'[build] Compiling anyway would resolve its exports to `any` and emit that as this ' +
				"package's public types, with exit 0."
		);
		console.error('[build] Build dependencies first: `pnpm packages:build`.');
		process.exit(1);
	}
}

assertWorkspaceDependenciesBuilt();

rmSync(staging, { recursive: true, force: true });
rmSync(retired, { recursive: true, force: true });

// `{}` is the staging directory: `-o {}` for a packager, or a tsconfig `outDir` override.
const resolved = commandArguments.map((argument) => argument.replaceAll('{}', staging));

const buildResult = Effect.runSync(
	Effect.result(
		Effect.try({
			try: () => execFileSync(command, resolved, { cwd: packageRoot, stdio: 'inherit' }),
			catch: (cause) => cause
		})
	)
);
if (buildResult._tag === 'Failure') {
	const cause = buildResult.failure;
	rmSync(staging, { recursive: true, force: true });
	process.exit(typeof cause?.status === 'number' ? cause.status : 1);
}

if (!existsSync(staging)) {
	console.error(`[build] ${command} produced no output at ${path.relative(packageRoot, staging)}`);
	process.exit(1);
}

// Read the declarations back before they become `build/`. The precondition above rules out the
// cause we know of, but it only covers workspace edges; anything else that degrades an inferred
// type still exits 0, and this is the last point where the output can be discarded instead of
// swapped in, packed, and published.
const declarationResult = Effect.runSync(
	Effect.result(
		Effect.try({
			try: () =>
				assertDeclarationEmit({
					declarationRoot: staging,
					packageDirectory: path.basename(packageRoot),
					label: `${manifest.name} build output`
				}),
			catch: (cause) => cause
		})
	)
);
if (declarationResult._tag === 'Failure') {
	const cause = declarationResult.failure;
	console.error(`[build] ${cause.message}`);
	rmSync(staging, { recursive: true, force: true });
	process.exit(1);
}

// Packagers create files with ordinary 0644 modes even when the source carried a shebang. npm 11
// rejects such a target as an invalid `bin` entry and silently removes the command from the
// published manifest. Restore executable mode from package.json while the output is still staged.
const binTargets =
	typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
for (const target of binTargets) {
	if (typeof target !== 'string') continue;
	const relativeTarget = path.relative('build', target.replace(/^\.\//, ''));
	if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) continue;
	const stagedTarget = path.join(staging, relativeTarget);
	if (!existsSync(stagedTarget)) {
		console.error(`[build] declared binary was not generated: ${target}`);
		process.exit(1);
	}
	chmodSync(stagedTarget, 0o755);
}

// Two renames. The old output is moved aside rather than deleted first, so a failure between them
// leaves something recoverable rather than nothing at all.
if (existsSync(output)) renameSync(output, retired);
renameSync(staging, output);
rmSync(retired, { recursive: true, force: true });
