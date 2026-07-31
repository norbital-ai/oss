#!/usr/bin/env node
/**
 * Refresh the injected copies of the workspace packages.
 *
 * `pnpm-workspace.yaml` sets `injectWorkspacePackages: true`, so a template does not symlink back to
 * `packages/<name>`; it gets a hard copy under `node_modules/.pnpm/@norbital-ai+<name>@<version>_<peers>/`.
 * That is deliberate — it makes a template resolve these packages the way a published consumer does,
 * instead of reaching into monorepo sources and peer dependencies that are not in the tarball.
 *
 * The cost is that a copy goes stale the moment a package is rebuilt. `syncInjectedDepsAfterScripts`
 * only fires for a build pnpm itself ran in that invocation, so building through turbo, or building
 * one package and then testing another, leaves the copies behind — and stale copies make correct
 * code look broken. This is the one command that puts them back in step.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.filter((name) => existsSync(path.join(repoRoot, 'packages', name, 'build')));

const consumers = readdirSync(path.join(repoRoot, 'template_workspaces'), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.join(repoRoot, 'template_workspaces', entry.name));

let synced = 0;
for (const consumer of consumers) {
	for (const name of packages) {
		const link = path.join(consumer, 'node_modules', '@norbital-ai', name);
		if (!existsSync(link)) continue;
		const target = realpathSync(link);
		// A symlink straight back into packages/<name> is not an injected copy; leave it alone.
		if (target === path.join(repoRoot, 'packages', name)) continue;
		execFileSync('rsync', [
			'-a',
			'--delete',
			`${path.join(repoRoot, 'packages', name, 'build')}/`,
			`${path.join(target, 'build')}/`
		]);
		synced += 1;
	}
}
console.log(`[deps:sync] refreshed ${synced} injected package copies across ${consumers.length} templates`);
