#!/usr/bin/env node
/**
 * Move `pod` and `ui` onto a given version, replacing it in the registry if it already exists.
 *
 * Written for one specific job: getting the sync-engine work published as 0.0.1 rather than 0.0.2.
 * 0.0.1 is already taken by the pre-change code, and registry versions are immutable, so the only
 * way to reuse the number is to delete the published version first.
 *
 * That delete needs `delete:packages` + `read:packages`, which the publish credential does not
 * carry. Grant it once with:
 *
 *   gh auth refresh -s delete:packages,read:packages
 *
 * then run:
 *
 *   node scripts/republish-as.mjs 0.0.1
 *
 * WHY THIS IS SAFE HERE, AND WHEN IT WOULD NOT BE
 * -----------------------------------------------
 * Republishing different bytes under a version that consumers already resolved is normally
 * indefensible: every lockfile pinning it by integrity hash breaks, and there is no way back
 * because the original bytes are gone. It is acceptable in this repository only because the sole
 * consumer is our own tenant build, every template lockfile is regenerated below, and each
 * environment reset wipes the sandbox pnpm-store before rebuilding. Outside those conditions,
 * publish a new version instead.
 *
 * The reset AFTER this is not optional. Until it runs, an environment's existing tenant lockfiles
 * still name the old integrity for this version and any rebuild fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repositoryRoot } from './lib/templates.mjs';

const PACKAGES = ['pod', 'ui'];
const TEMPLATES = ['field-operations', 'construction', 'crm', 'hr-payroll', 'reclamation'];

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
	console.error('Usage: node scripts/republish-as.mjs <version>');
	process.exit(1);
}

function run(command, args, options = {}) {
	return execFileSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: 'utf8',
		stdio: options.quiet ? 'pipe' : 'inherit',
		env: { ...process.env, ...options.env }
	});
}

function readJson(file) {
	return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
	writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`);
}

// 1. Delete the version if the registry already has it. Absent is fine — that is the normal case
//    for a version that has never been published.
for (const pkg of PACKAGES) {
	let versionId = '';
	try {
		versionId = run(
			'gh',
			[
				'api',
				`/orgs/norbital-ai/packages/npm/${pkg}/versions`,
				'--jq',
				`.[] | select(.name=="${version}") | .id`
			],
			{ quiet: true }
		).trim();
	} catch {
		console.log(`  ${pkg}: no published versions to inspect`);
	}
	if (!versionId) {
		console.log(`  ${pkg}@${version}: not published, nothing to delete`);
		continue;
	}
	console.log(`  ${pkg}@${version}: deleting published version ${versionId}`);
	run('gh', ['api', '-X', 'DELETE', `/orgs/norbital-ai/packages/npm/${pkg}/versions/${versionId}`]);
}

// 2. Point the workspace packages at the version.
for (const pkg of PACKAGES) {
	const file = path.join(repositoryRoot, 'packages', pkg, 'package.json');
	const manifest = readJson(file);
	manifest.version = version;
	writeJson(file, manifest);
}

// 3. Build, then publish with pnpm. NOT npm: `npm publish` leaves `workspace:*` in the tarball
//    verbatim, which installs as an unresolvable specifier. pnpm rewrites those to real versions.
run('./node_modules/.bin/turbo', ['build', '--filter=@norbital-ai/pod...']);
for (const pkg of PACKAGES) {
	run('pnpm', ['publish', '--no-git-checks'], { cwd: path.join(repositoryRoot, 'packages', pkg) });
}

// 4. Point every template at it, including the release-age exemption, which is pinned per version.
for (const template of TEMPLATES) {
	const directory = path.join(repositoryRoot, 'template_workspaces', template);
	const file = path.join(directory, 'package.json');
	const manifest = readJson(file);
	for (const pkg of PACKAGES) {
		const name = `@norbital-ai/${pkg}`;
		if (manifest.dependencies?.[name]) manifest.dependencies[name] = version;
	}
	writeJson(file, manifest);

	const policyFile = path.join(directory, 'pnpm-workspace.yaml');
	const policy = readFileSync(policyFile, 'utf8');
	const pinned = policy.replace(
		/ {2}- '@norbital-ai\/(pod|ui)@[^']+'\n/g,
		(line, pkg) => `  - '@norbital-ai/${pkg}@${version}'\n`
	);
	// Collapse the duplicates the replace leaves behind when several versions were pinned.
	const seen = new Set();
	writeFileSync(
		policyFile,
		pinned
			.split('\n')
			.filter((line) => {
				if (!/^ {2}- '@norbital-ai\//.test(line)) return true;
				if (seen.has(line)) return false;
				seen.add(line);
				return true;
			})
			.join('\n')
	);
}

// 5. Both lockfiles. The templates are standalone workspaces AND root workspace projects, so
//    regenerating only one leaves CI's --frozen-lockfile install failing on the other.
run('node', ['scripts/lock-templates.mjs']);
run('pnpm', ['install', '--lockfile-only']);

console.log(`\nDone. pod and ui are now ${version}, templates and both lockfiles updated.`);
console.log('Next: commit, project the templates, then reset staging and production —');
console.log('until a reset runs, existing tenant lockfiles still pin the replaced bytes.');
