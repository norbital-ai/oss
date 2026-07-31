#!/usr/bin/env node
/**
 * Refresh the injected copies of the workspace packages.
 *
 * `pnpm-workspace.yaml` sets `injectWorkspacePackages: true`, so a template does not symlink back to
 * `packages/<name>`; it gets a hard copy under `node_modules/.pnpm/@norbital-ai+<name>@<version>_<peers>/`.
 * That is deliberate — it makes a template resolve these packages the way a published consumer does,
 * instead of reaching into monorepo sources and peer dependencies that are not in the tarball.
 *
 * The cost is that a copy goes stale the moment a package is rebuilt, and the failure is silent and
 * inverted: correct code looks broken, and broken code can look fine. `syncInjectedDepsAfterScripts`
 * only fires for a build pnpm itself ran in that invocation, so building through turbo — or building
 * one package and then testing another — leaves the copies behind. Any `pnpm install` anywhere in
 * the repo restores them from the store, undoing a refresh that had already happened.
 *
 * The walk is over `.pnpm` rather than over the top-level `node_modules/@norbital-ai/*` entries,
 * because a package can reach a template transitively with no top-level entry of its own —
 * `platform-utils` arrives through `pod`. One physical copy exists per (package, peer-resolution),
 * and every direct and nested link points at it, so refreshing the store directory covers them all.
 *
 * Only the version a template actually pins is touched. `.pnpm` accumulates a directory for every
 * version ever resolved there, and writing a rebuilt package into a copy of an older release would
 * be a lie about what that version contains.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file) {
	return JSON.parse(readFileSync(file, 'utf8'));
}

/** Workspace packages that publish a `build/` directory, with the version they currently carry. */
const packages = readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => existsSync(path.join(repoRoot, 'packages', name, 'build')))
	.map((name) => ({
		name,
		build: path.join(repoRoot, 'packages', name, 'build'),
		version: readJson(path.join(repoRoot, 'packages', name, 'package.json')).version
	}));

const templates = readdirSync(path.join(repoRoot, 'template_workspaces'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.join(repoRoot, 'template_workspaces', entry.name));

let refreshed = 0;
const missing = [];

for (const template of templates) {
	const store = path.join(template, 'node_modules', '.pnpm');
	if (!existsSync(store)) continue;
	const entries = readdirSync(store);
	for (const pkg of packages) {
		// `@norbital-ai+pod@0.0.12_<peer hash>` — the version is delimited, so `0.0.1` cannot match
		// `0.0.12`.
		const prefix = `@norbital-ai+${pkg.name}@${pkg.version}`;
		const matches = entries.filter((entry) => entry === prefix || entry.startsWith(`${prefix}_`));
		if (matches.length === 0) {
			missing.push(`${path.basename(template)}/${pkg.name}@${pkg.version}`);
			continue;
		}
		for (const match of matches) {
			const copy = path.join(store, match, 'node_modules', '@norbital-ai', pkg.name);
			// A symlink here means this template is not injecting the package; leave it alone.
			if (!existsSync(copy) || lstatSync(copy).isSymbolicLink()) continue;
			execFileSync('rsync', ['-a', '--delete', `${pkg.build}/`, `${path.join(copy, 'build')}/`]);
			refreshed += 1;
		}
	}
}

console.log(
	`[deps:sync] refreshed ${refreshed} injected copies of ${packages.length} packages across ${templates.length} templates`
);
if (missing.length > 0) {
	// Not fatal: a template may legitimately not depend on every package. Named rather than silent,
	// because "no copy found" and "copy refreshed" are indistinguishable from a count alone.
	console.log(`[deps:sync] no injected copy found for: ${missing.join(', ')}`);
}
