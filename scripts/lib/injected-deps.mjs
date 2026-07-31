import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether a template can still resolve the first-party packages it depends on.
 *
 * This is deliberately separate from refreshing the injected copies. Refreshing rewrites the
 * `build/` *inside* an entry that already exists; it never creates the entry. So once
 * `template_workspaces/<name>/node_modules/@norbital-ai/` is gone, a refresh has nothing to walk
 * and reports the same success it reports for a healthy tree — the numbers are identical and the
 * template is broken. Auditing what the template can resolve is the only signal that separates
 * the two.
 */

export const packageScope = '@norbital-ai';

/**
 * The first-party packages a template promises to resolve.
 *
 * Read from the template's own manifest rather than a list maintained here, so the expected set
 * cannot drift from what the template actually declares. `config` is linked at the repository root
 * only — no template depends on it, which is why it correctly never appears in a template's
 * `node_modules/@norbital-ai/`.
 */
export function declaredPackages(templateDirectory) {
	const manifest = JSON.parse(readFileSync(path.join(templateDirectory, 'package.json'), 'utf8'));
	const names = new Set();
	for (const field of ['dependencies', 'devDependencies']) {
		for (const dependency of Object.keys(manifest[field] ?? {})) {
			if (dependency.startsWith(`${packageScope}/`)) {
				names.add(dependency.slice(packageScope.length + 1));
			}
		}
	}
	return [...names].sort();
}

/**
 * Two distinct failures, because they need two different fixes.
 *
 * `missing` means the entry is absent — the tree was pruned, and only a fresh install puts it
 * back. `unbuilt` means the entry resolves but carries no build output, which is the one case a
 * `pnpm packages:build` fixes. Conflating them is what made the old `refreshed === 0` heuristic
 * report "build the packages first" for a template that had simply never been installed.
 *
 * `existsSync` follows symlinks, so a dangling link counts as missing — which is what it is.
 */
export function auditTemplate(templateDirectory) {
	const missing = [];
	const unbuilt = [];
	for (const name of declaredPackages(templateDirectory)) {
		const entry = path.join(templateDirectory, 'node_modules', packageScope, name);
		if (!existsSync(entry)) missing.push(name);
		else if (!existsSync(path.join(entry, 'build'))) unbuilt.push(name);
	}
	return { missing, unbuilt };
}

/**
 * Put a pruned entry back, as the relative symlink into `packages/` that every healthy template
 * already carries.
 *
 * Restoring rather than documenting a command is deliberate: `pnpm install` does not repair this.
 * With the lockfile unchanged pnpm considers the workspace already installed and answers "Already
 * up to date" — `--force` included — so the pruned template stays pruned and the only recovery on
 * offer is tribal knowledge about deleting `node_modules` and reinstalling over the network.
 *
 * A link is the shape the refresh pass already treats as healthy ("a symlink back into `packages/`
 * already sees every rebuild"), so a restored entry needs no follow-up refresh and cannot go stale.
 */
export function restoreTemplate(templateDirectory, packagesRoot) {
	const restored = [];
	const unavailable = [];
	for (const name of auditTemplate(templateDirectory).missing) {
		const source = path.join(packagesRoot, name);
		if (!existsSync(source)) {
			unavailable.push(name);
			continue;
		}
		const entry = path.join(templateDirectory, 'node_modules', packageScope, name);
		mkdirSync(path.dirname(entry), { recursive: true });
		// `force` clears a dangling link, which `existsSync` reported as absent.
		rmSync(entry, { force: true, recursive: true });
		symlinkSync(path.relative(path.dirname(entry), source), entry);
		restored.push(name);
	}
	return { restored, unavailable };
}
