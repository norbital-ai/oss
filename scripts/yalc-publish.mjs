/**
 * Build the Bolt packages and put them in the yalc store, then push them into every checkout that
 * has already added them.
 *
 * This is the producer half of the local loop. It ends at `.yalc/<name>` in each consumer; getting
 * from there into a consumer's `node_modules` is `pnpm install`, which the linkers own — see
 * `lib/yalc-consumers.mjs` for why that second step cannot be skipped.
 *
 *   --only=bolt,ui   narrow to those packages (and, through turbo, whatever they build on)
 *   --push           push to installations as well as publishing to the store
 *   --force          push even where every installation already holds this exact build
 *   --report=<file>  write what happened as JSON, so a caller does not have to re-derive it
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './lib/package-release.mjs';
import { readJsonIfPresent, signatureField } from './lib/yalc-consumers.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allPackages = [
	{ name: '@norbital-ai/bolt-protocol', directory: 'packages/bolt-protocol' },
	{ name: '@norbital-ai/config', directory: 'packages/config' },
	{ name: '@norbital-ai/std', directory: 'packages/std' },
	{ name: '@norbital-ai/ui', directory: 'packages/ui' },
	{ name: '@norbital-ai/bolt', directory: 'packages/bolt' },
	{ name: '@norbital-ai/bolt-server', directory: 'packages/bolt-server' }
];

const argumentValue = (flag) =>
	process.argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1);

/**
 * `--only=bolt,ui` narrows the run to those packages. Accepts the bare directory name or the full
 * `@norbital-ai/` specifier.
 *
 * It narrows far less than it used to. Builds went one `pnpm --dir <package> build` at a time, all
 * of them, before anything was published — so one sibling mid-refactor blocked the push for all
 * five, and `--only` was the way out. The build is now a single turbo run, which rebuilds only what
 * actually changed and orders dependencies itself; a package that does not compile still blocks the
 * packages that import it, and nothing else.
 */
const requested = (() => {
	const only = argumentValue('--only');
	if (only === undefined) return undefined;
	const names = new Set(
		only.split(',').flatMap((entry) => {
			const trimmed = entry.trim();
			if (trimmed.length === 0) return [];
			return [trimmed.startsWith('@norbital-ai/') ? trimmed : `@norbital-ai/${trimmed}`];
		})
	);
	const known = new Set(allPackages.map((entry) => entry.name));
	for (const name of names) {
		if (!known.has(name)) throw new Error(`--only names an unknown package: ${name}`);
	}
	return names;
})();
const packages =
	requested === undefined ? allPackages : allPackages.filter((entry) => requested.has(entry.name));

const push = process.argv.includes('--push');
const force = process.argv.includes('--force');
const reportPath = argumentValue('--report');

const run = (command, args, cwd = repositoryRoot) => {
	execFileSync(command, args, { cwd, stdio: 'inherit' });
};

const workspaceVersions = Object.fromEntries(
	['bolt-protocol', 'bolt', 'bolt-server', 'std', 'ui', 'config'].flatMap((directory) => {
		const manifestPath = path.join(repositoryRoot, 'packages', directory, 'package.json');
		if (!existsSync(manifestPath)) return [];
		const manifest = readManifest(manifestPath);
		return typeof manifest.name === 'string' && typeof manifest.version === 'string'
			? [[manifest.name, manifest.version]]
			: [];
	})
);

/**
 * The workspace catalog, read from its declaration rather than copied.
 *
 * A hand-maintained duplicate drifts silently: the copy pinned svelte ^5.56.7 long after the
 * workspace moved on, and a stale pin here reaches every linked consumer as a real dependency.
 */
const readCatalog = () => {
	const source = readFileSync(path.join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
	const body = source.split(/^catalog:\s*$/m)[1];
	if (body === undefined) throw new Error('pnpm-workspace.yaml declares no catalog.');
	const entries = {};
	for (const line of body.split('\n')) {
		if (/^\S/.test(line)) break;
		const match = line.match(/^\s+'?([^':\s]+)'?:\s*(.+?)\s*$/);
		if (match === null || line.trim().startsWith('#')) continue;
		entries[match[1]] = match[2].replace(/^'|'$/g, '');
	}
	return entries;
};
const catalog = readCatalog();

const yalcSibling = (name) => {
	if (!name.startsWith('@norbital-ai/')) return undefined;
	return `file:../${name.slice('@norbital-ai/'.length)}`;
};

const rewriteSpecifier = (name, specifier) => {
	if (
		specifier.startsWith('workspace:') ||
		(specifier === '*' && workspaceVersions[name] !== undefined) ||
		workspaceVersions[name] === specifier
	) {
		const sibling = yalcSibling(name);
		if (sibling !== undefined) return sibling;
		const version = workspaceVersions[name];
		if (typeof version !== 'string') {
			throw new Error(`Cannot rewrite ${name} ${specifier}: workspace package version is missing.`);
		}
		return version;
	}
	if (specifier === 'catalog:') {
		const version = catalog[name];
		if (typeof version !== 'string') {
			throw new Error(`Cannot rewrite ${name} catalog: pin is missing.`);
		}
		return version;
	}
	return specifier;
};

const rewriteDependencyMap = (dependencies) => {
	if (dependencies === undefined) return undefined;
	return Object.fromEntries(
		Object.entries(dependencies).map(([name, specifier]) => [
			name,
			rewriteSpecifier(name, specifier)
		])
	);
};

/**
 * A manifest as a consumer must see it: no `workspace:` or `catalog:` specifiers, and stamped with
 * the signature of the build it belongs to.
 *
 * The rewrite is not cosmetic. pnpm refuses `catalog:` outright ("isn't supported by any available
 * resolver"), which is what once made these packages appear to link while actually resolving to the
 * published registry build. The stamp is what lets a consumer tell a materialised install from a
 * pushed one without hashing a directory tree.
 */
const consumerManifest = (manifest, signature) => ({
	...manifest,
	dependencies: rewriteDependencyMap(manifest.dependencies),
	peerDependencies: rewriteDependencyMap(manifest.peerDependencies),
	[signatureField]: signature
});

const writeManifest = (manifestPath, manifest) => {
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
};

if (!existsSync(path.join(repositoryRoot, 'node_modules/.bin/yalc'))) {
	run('pnpm', ['exec', 'yalc', '--version']);
}

/**
 * One turbo run for every package at once, rather than a build command per package.
 *
 * turbo hashes each package's inputs and replays the cache for anything unchanged, so the common
 * case — one package edited — compiles one package instead of five, and a second linker invoked
 * straight after the first compiles nothing at all. `--concurrency=1` matches `pnpm build`: several
 * of these are svelte-package runs and they contend badly.
 */
const buildable = packages.filter(
	({ directory }) =>
		readManifest(path.join(repositoryRoot, directory, 'package.json')).scripts?.build
);
if (buildable.length > 0) {
	run('pnpm', [
		'exec',
		'turbo',
		'run',
		'build',
		'--concurrency=1',
		...buildable.map(({ name }) => `--filter=${name}`)
	]);
}

/** Where yalc has pushed this package, so the rewrite can follow it. */
const installationsOf = (name) => {
	const installations = readJsonIfPresent(path.join(os.homedir(), '.yalc/installations.json'))?.[
		name
	];
	return Array.isArray(installations) ? installations : [];
};

const report = { packages: {} };

for (const { directory, name } of packages) {
	const packageRoot = path.join(repositoryRoot, directory);
	run('pnpm', ['exec', 'yalc', 'publish', '--private', '--no-scripts'], packageRoot);

	const { version } = readManifest(path.join(packageRoot, 'package.json'));
	const storeDirectory = path.join(os.homedir(), '.yalc/packages', name, version);
	const storeManifestPath = path.join(storeDirectory, 'package.json');
	// yalc's own content hash of what it just stored. Reused rather than recomputed: it is the same
	// string yalc records in every consumer's lockfile, which is what makes the comparison below
	// exact rather than a guess.
	const signature = readFileSync(path.join(storeDirectory, 'yalc.sig'), 'utf8').trim();
	const manifest = consumerManifest(readManifest(storeManifestPath), signature);
	writeManifest(storeManifestPath, manifest);

	// Which checkouts are not already holding this build. Read before the push, because the push is
	// what updates the lockfiles it is being decided from.
	const installations = installationsOf(name);
	const stale = installations.filter(
		(installation) =>
			readJsonIfPresent(path.join(installation, 'yalc.lock'))?.packages?.[name]?.signature !==
				signature || !existsSync(path.join(installation, '.yalc', ...name.split('/')))
	);

	const pushed = push && (force || stale.length > 0);
	if (pushed) {
		// `--private` is required on the push as well as the publish: without it yalc refuses private
		// packages with "Will not publish package with `private: true`" and exits 0, so bolt/bolt-server
		// changes silently never reached their installations. Only a later `yalc add` refreshed them.
		run('pnpm', ['exec', 'yalc', 'push', '--replace', '--private'], packageRoot);
		// The push republishes from source, overwriting the manifest rewritten above.
		writeManifest(storeManifestPath, manifest);
	}

	// Every installation's copy, stamped and rewritten whether or not this run pushed — a checkout
	// linked before the stamp existed is otherwise indistinguishable from an up-to-date one.
	for (const installation of installations) {
		const installedManifestPath = path.join(
			installation,
			'.yalc',
			...name.split('/'),
			'package.json'
		);
		if (!existsSync(installedManifestPath)) continue;
		writeManifest(
			installedManifestPath,
			consumerManifest(readManifest(installedManifestPath), signature)
		);
	}

	report.packages[name] = { version, signature, pushed, stale };
	console.log(
		`yalc ${pushed ? 'pushed' : 'published'} ${name}@${version}` +
			(push && !pushed ? ' (every installation already holds this build)' : '')
	);
}

if (reportPath !== undefined) {
	mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
	writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, '\t')}\n`);
}
