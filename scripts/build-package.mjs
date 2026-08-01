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
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const [command, ...commandArguments] = process.argv.slice(2);
if (!command) {
	console.error('usage: build-package.mjs <command> [...args]   # `{}` expands to the staging dir');
	process.exit(1);
}

const packageRoot = process.cwd();
const output = path.join(packageRoot, 'build');
const staging = path.join(packageRoot, 'build.staging');
const retired = path.join(packageRoot, 'build.retired');

rmSync(staging, { recursive: true, force: true });
rmSync(retired, { recursive: true, force: true });

// `{}` is the staging directory: `-o {}` for a packager, or a tsconfig `outDir` override.
const resolved = commandArguments.map((argument) => argument.replaceAll('{}', staging));

try {
	execFileSync(command, resolved, { cwd: packageRoot, stdio: 'inherit' });
} catch (cause) {
	rmSync(staging, { recursive: true, force: true });
	process.exit(typeof cause?.status === 'number' ? cause.status : 1);
}

if (!existsSync(staging)) {
	console.error(`[build] ${command} produced no output at ${path.relative(packageRoot, staging)}`);
	process.exit(1);
}

// Two renames. The old output is moved aside rather than deleted first, so a failure between them
// leaves something recoverable rather than nothing at all.
if (existsSync(output)) renameSync(output, retired);
renameSync(staging, output);
rmSync(retired, { recursive: true, force: true });
