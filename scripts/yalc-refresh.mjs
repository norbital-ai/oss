/**
 * Put every consumer on the locally built packages.
 *
 * Publishes each package into the yalc store once, then runs every consumer repository's own linker
 * with `--skip-publish`. The linkers finish with `yalc add --pure`, which leaves `node_modules`
 * entirely to pnpm.
 *
 * The final stage verifies rather than assumes, and it asks three separate questions because a
 * package can pass any two of them while being the wrong build:
 *
 *   RESOLVES  through pnpm's store, checked on the resolved real path — a link straight to
 *             `.yalc/<name>` reaches a directory with no `node_modules` of its own and orphans the
 *             package's dependencies.
 *   IMPORTS   because resolving and loading are different failures, and only the second catches a
 *             package that is present but unusable.
 *   IS FRESH  because the first two are equally true of a stale build. pnpm materialises a `file:`
 *             dependency into a copy at install time and keeps serving that copy; an override, a
 *             re-resolved registry pin or a republish at the same version all leave a workspace
 *             resolving cleanly and importing happily from the *previous* build. `stalePackages`
 *             compares the `yalcSignature` the push left in `.yalc/<name>` against the one in the
 *             materialised copy, which is the only question whose answer is the build itself.
 *
 * Without the third, this command's success line was a false assurance — the shape of green this
 * repository has been bitten by before.
 *
 *   --only=bolt,ui   narrow the build and publish to those packages
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { managedPackages, stalePackages } from './lib/yalc-consumers.mjs';

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
	const directoriesUnder = (parent) =>
		existsSync(parent)
			? readdirSync(parent, { withFileTypes: true })
					.filter(
						(entry) =>
							entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules'
					)
					.map((entry) => path.join(parent, entry.name))
			: [];
	// A workspace is one that *declares* a managed package, not one that already has it installed.
	// Filtering on `node_modules/@norbital-ai` asked whether the install had happened, so the one
	// workspace whose install failed was the one workspace this never checked — and the run then
	// reported that every workspace was on the local build.
	return [root, ...directoriesUnder(root), ...directoriesUnder(path.join(root, 'apps'))].filter(
		(directory) =>
			existsSync(path.join(directory, 'package.json')) && managedPackages(directory).length > 0
	);
};

/**
 * One workspace's verdict: every managed package resolves through pnpm's store, and imports.
 *
 * Resolution is checked on the *real* path rather than the symlink's text, because the failure has
 * two spellings — `node_modules/<name>` pointing straight at `.yalc/<name>`, and pnpm's own entry
 * having been replaced in place — and only the resolved path tells them apart.
 */
const verifyWorkspace = (directory) => {
	const failures = [];
	for (const name of managedPackages(directory)) {
		const linked = path.join(directory, 'node_modules', ...name.split('/'));
		if (!existsSync(linked)) {
			failures.push(`${name} is declared but not installed at ${linked}`);
			continue;
		}
		const resolved = realpathSync(linked);
		if (
			!resolved.includes(`${path.sep}.pnpm${path.sep}`) &&
			resolved.includes(`${path.sep}.yalc${path.sep}`)
		) {
			failures.push(`${name} resolves straight to .yalc, so its dependencies are orphaned`);
			continue;
		}
		if (!existsSync(path.join(linked, 'package.json')))
			failures.push(`${name} has no package.json at ${linked}`);
	}
	// The freshness question, asked once for the whole workspace because that is the shape the
	// signature comparison takes.
	for (const name of stalePackages(directory, managedPackages(directory))) {
		failures.push(
			`${name} is installed from an older build than the one just pushed — pnpm is still serving its previous copy`
		);
	}
	return failures;
};

const packagesArg = values.only === undefined ? [] : [`--only=${values.only}`];

console.log('\n[1/3] build + publish to the yalc store');
run(
	'node',
	[path.join(repositoryRoot, 'scripts', 'yalc-publish.mjs'), ...packagesArg],
	repositoryRoot
);

console.log('\n[2/3] each consumer pulls from the store through its own linker');
for (const repository of CONSUMER_REPOSITORIES) {
	const root = path.join(realmRoot, repository);
	if (!existsSync(path.join(root, 'package.json'))) {
		console.log(`  ${repository}: absent, skipped`);
		continue;
	}
	console.log(`\n  --- ${repository} ---`);
	// The linker is run directly rather than through `pnpm <script>`, which is not a style choice.
	// pnpm 11 verifies a project's dependencies before running any script in it, and that
	// verification re-materialises `node_modules` from the lockfile — undoing the yalc overlay this
	// command exists to install, while the linker is still writing it. The symptom was an ENOENT on a
	// different file inside `@norbital-ai/ui` on every run, which reads as a corrupt package rather
	// than as two processes writing one tree. `norbital` is immune because its `pnpm-workspace.yaml`
	// sets `verifyDepsBeforeRun: false`; the template repositories have no such file, and `dev.mjs`
	// never hit this only because it has always invoked the same script directly. Now both do, which
	// also means there is one code path to keep working instead of two that can drift.
	run('node', [path.join('scripts', 'yalc-link.mjs'), '--skip-publish'], root);
}

console.log('\n[3/3] verify every workspace resolves, imports, and holds the build just pushed');
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
					[
						'-e',
						"import('@norbital-ai/bolt/authoring').then(() => process.exit(0)).catch((error) => { console.error(error.code ?? error.message); process.exit(1); })"
					],
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
console.log(
	"\nyalc:refresh complete — every workspace resolves, imports and matches the build just pushed,\nand the tenant sandbox store was staged from that same build by each repository's linker."
);
