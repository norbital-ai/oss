/**
 * Put every consumer on the locally built packages, in one command.
 *
 * The local loop was four steps across three repositories — build, publish, push, then a linker per
 * consumer — and it had a standalone `yalc:push` sitting in the middle of it. That push is the
 * footgun this command removes. `yalc push` writes `node_modules/<name>` itself, as a plain
 * directory link to `.yalc/<name>`; that directory has no `node_modules` of its own, so every
 * dependency the package imports resolves against the consumer root instead of the copy pnpm
 * installed for it, and the first module to want `drizzle-orm` dies with ERR_MODULE_NOT_FOUND.
 * `pnpm install` then says "Already up to date", because nothing about the lockfile changed.
 *
 * The linkers already push *and then* run `yalc add --pure`, which hands `node_modules` back to
 * pnpm — so push inside a linker is fine, and push on its own is what leaves a repository broken.
 * There is no longer a way to do only the first half: this publishes once, then runs each
 * consumer's own linker with `--skip-publish`.
 *
 * The last stage is the point: it *verifies* rather than assumes. Every managed package in every
 * workspace must resolve through pnpm's store and actually import, and the command fails loudly if
 * it does not. A refresh that silently leaves one workspace on a stale or orphaned build is the bug
 * this script exists to stop.
 *
 *   --only=bolt,ui   narrow the build and publish to those packages
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realmRoot = path.resolve(repositoryRoot, '..');

/** Every repository that consumes the packages, and owns its own linker. */
const CONSUMER_REPOSITORIES = ['templates', 'templates_private', 'norbital'];

const { values } = parseArgs({ options: { only: { type: 'string' } }, strict: true });

const run = (command, args, cwd) =>
	execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });

const capture = (command, args, cwd) =>
	execFileSync(command, args, { cwd, encoding: 'utf8', env: process.env }).trim();

/**
 * Workspaces inside a consumer repository.
 *
 * A repository either is one workspace (Colony) or holds several (the template repositories), and
 * the check below has to reach each one — a linker that succeeded for four workspaces and left the
 * fifth orphaned is exactly the failure this verifies away.
 */
const workspacesOf = (repository) => {
	const root = path.join(realmRoot, repository);
	const nested = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
		.map((entry) => path.join(root, entry.name))
		.filter((directory) => existsSync(path.join(directory, 'node_modules', '@norbital-ai')));
	const apps = path.join(root, 'apps');
	const appWorkspaces = existsSync(apps)
		? readdirSync(apps, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(apps, entry.name))
				.filter((directory) => existsSync(path.join(directory, 'node_modules', '@norbital-ai')))
		: [];
	const self = existsSync(path.join(root, 'node_modules', '@norbital-ai')) ? [root] : [];
	return [...self, ...nested, ...appWorkspaces];
};

/**
 * One workspace's verdict: every managed package resolves through pnpm's store, and imports.
 *
 * Resolution is checked on the *real* path rather than the symlink's text, because the failure has
 * two spellings — `node_modules/<name>` pointing straight at `.yalc/<name>`, and pnpm's own entry
 * having been replaced in place — and only the resolved path tells them apart.
 */
const verifyWorkspace = (directory) => {
	const scope = path.join(directory, 'node_modules', '@norbital-ai');
	const failures = [];
	for (const name of readdirSync(scope)) {
		const linked = path.join(scope, name);
		const resolved = realpathSync(linked);
		if (!resolved.includes(`${path.sep}.pnpm${path.sep}`) && resolved.includes(`${path.sep}.yalc${path.sep}`)) {
			failures.push(`@norbital-ai/${name} resolves straight to .yalc, so its dependencies are orphaned`);
			continue;
		}
		const entry = path.join(linked, 'package.json');
		if (!existsSync(entry)) failures.push(`@norbital-ai/${name} has no package.json at ${linked}`);
	}
	return failures;
};

const packagesArg = values.only === undefined ? [] : [`--only=${values.only}`];

console.log('\n[1/3] build + publish to the yalc store');
run('node', [path.join(repositoryRoot, 'scripts', 'yalc-publish.mjs'), ...packagesArg], repositoryRoot);

console.log('\n[2/3] each consumer pulls from the store through its own linker');
for (const repository of CONSUMER_REPOSITORIES) {
	const root = path.join(realmRoot, repository);
	if (!existsSync(path.join(root, 'package.json'))) {
		console.log(`  ${repository}: absent, skipped`);
		continue;
	}
	console.log(`\n  --- ${repository} ---`);
	run('pnpm', ['--dir', root, 'yalc:link', '--skip-publish'], realmRoot);
}

console.log('\n[3/3] verify every workspace resolves through pnpm and imports');
let broken = 0;
for (const repository of CONSUMER_REPOSITORIES) {
	for (const workspace of workspacesOf(repository)) {
		const relative = path.relative(realmRoot, workspace);
		const failures = verifyWorkspace(workspace);
		if (failures.length === 0) {
			// Resolution is necessary but not sufficient: a package can resolve and still fail to load,
			// which is the ERR_MODULE_NOT_FOUND this whole script exists to prevent shipping silently.
			try {
				capture(
					'node',
					['-e', "import('@norbital-ai/bolt/authoring').then(() => process.exit(0)).catch((error) => { console.error(error.code ?? error.message); process.exit(1); })"],
					workspace
				);
				console.log(`  ok      ${relative}`);
			} catch {
				broken += 1;
				console.log(`  BROKEN  ${relative}: @norbital-ai/bolt resolves but does not import`);
			}
			continue;
		}
		broken += 1;
		console.log(`  BROKEN  ${relative}`);
		for (const failure of failures) console.log(`            ${failure}`);
	}
}

if (broken > 0) {
	console.error(`\nyalc:refresh failed — ${broken} workspace(s) are not on the local build.`);
	process.exit(1);
}
console.log('\nyalc:refresh complete — every workspace is on the locally built packages.');
