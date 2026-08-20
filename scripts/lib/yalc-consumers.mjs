/**
 * The consumer half of the yalc loop: deciding whether a checkout's `node_modules` still holds the
 * package content that its `.yalc` directory now has.
 *
 * pnpm resolves `file:.yalc/<name>` through its virtual store — `node_modules/<name>` is a symlink
 * into `.pnpm/<name>@file+…`, whose contents were *copied* at install time. `yalc push` rewrites
 * `.yalc/<name>` and stops there, so a push on its own reaches nothing that imports the package.
 * That is the whole "fixed it, nothing changed" loop: the publish worked, the push worked, and the
 * running code was still the previous build. Only `pnpm install` re-materialises the store copy.
 *
 * Whether that install is needed is answered by `yalcSignature`, which yalc-publish stamps into
 * every manifest it writes. `.yalc/<name>/package.json` carries what was last pushed;
 * `node_modules/<name>/package.json` carries what pnpm last materialised. Equal strings mean there
 * is nothing to do — and unequal ones are the only reliable signal, because the yalc lockfile is
 * updated by the push itself and therefore claims to be current before any consumer has installed.
 *
 * The manifest is used as the carrier rather than yalc's own `yalc.sig` because pnpm packs a
 * `file:` directory dependency through its `files` field, which drops `yalc.sig` and keeps
 * `package.json`. It is the one file guaranteed to make the crossing.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPublicPackageEntries } from './package-release.mjs';

export const signatureField = 'yalcSignature';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localPackageNames = new Set(readPublicPackageEntries(repositoryRoot).map(({ name }) => name));

export const readJsonIfPresent = (file) => {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
};

/**
 * The locally publishable packages this checkout consumes, read from its own manifest.
 *
 * This must include exact registry specifiers as well as existing `file:.yalc/` overlays. Filtering
 * only the latter made `yalc:link` capable of refreshing an old link but incapable of creating one
 * in a clean checkout — the ordinary state where the command is first needed.
 *
 * The producer set comes from `package-release.mjs`, so adding a publishable package cannot make
 * the producer and consumers silently disagree.
 */
export const managedPackages = (consumerDirectory) => {
	const manifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const sections = [manifest?.dependencies, manifest?.devDependencies];
	return sections
		.flatMap((section) => Object.entries(section ?? {}))
		.filter(([name]) => localPackageNames.has(name))
		.map(([name]) => name);
};

const manifestSignature = (manifestPath) => readJsonIfPresent(manifestPath)?.[signatureField];

/** What the last push left in `.yalc/<name>` — the content this consumer is supposed to be running. */
export const linkedSignature = (consumerDirectory, name) =>
	manifestSignature(path.join(consumerDirectory, '.yalc', ...name.split('/'), 'package.json'));

/** What pnpm actually materialised, read through the node_modules symlink. */
export const installedSignature = (consumerDirectory, name) =>
	manifestSignature(
		path.join(consumerDirectory, 'node_modules', ...name.split('/'), 'package.json')
	);

/**
 * The packages this consumer would load a stale build of.
 *
 * A package that is linked but carries no signature is reported stale: it predates the stamp, so
 * there is no evidence either way and one extra install is cheaper than one missed propagation.
 */
export const stalePackages = (consumerDirectory, names) =>
	names.filter((name) => {
		if (!existsSync(path.join(consumerDirectory, '.yalc', ...name.split('/')))) return false;
		const linked = linkedSignature(consumerDirectory, name);
		return linked === undefined || linked !== installedSignature(consumerDirectory, name);
	});

/**
 * Make every managed package in this checkout a *pure* yalc installation and manifest dependency.
 *
 * A non-pure installation is one where yalc writes the package into `node_modules/<name>` itself,
 * replacing pnpm's symlink with a real directory and moving whatever was there to `.ignored_<name>`.
 * Colony was in that state: every push overwrote the link, so `@norbital-ai/ui` no longer sat beside
 * its own dependencies in the virtual store and Colony's vite config had to reconstruct them by
 * hand. Templates were already pure, because yalc turns pure on by default wherever it finds a
 * `pnpm-workspace.yaml` — and Colony, being an app inside the workspace rather than its root, has
 * none.
 *
 * `yalc add --pure` alone is not enough: pure mode copies into `.yalc/` but deliberately leaves an
 * exact registry specifier unchanged. For a package not already addressed as `file:.yalc/`, first
 * add it normally so yalc records the replaced version and rewrites the manifest, then convert that
 * installation to pure. pnpm owns `node_modules`; the caller re-materialises it after this returns.
 */
export const ensurePureInstallation = ({ consumerDirectory, names, yalcBin, run }) => {
	const manifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const lockfile = readJsonIfPresent(path.join(consumerDirectory, 'yalc.lock'));
	const specifierOf = (name) => manifest?.dependencies?.[name] ?? manifest?.devDependencies?.[name];
	const unlinked = names.filter(
		(name) => !String(specifierOf(name) ?? '').startsWith('file:.yalc/')
	);
	const impure = names.filter((name) => {
		const entry = lockfile?.packages?.[name];
		return entry !== undefined && entry.pure !== true;
	});
	if (unlinked.length > 0) {
		// Non-pure add is the only yalc path that writes `file:.yalc/` and remembers the exact
		// specifier it replaced. The pure conversion below immediately removes its node_modules copy.
		run(yalcBin, ['add', ...unlinked], consumerDirectory);
	}
	const prepared = [...new Set([...unlinked, ...impure])];
	if (prepared.length > 0) run(yalcBin, ['add', '--pure', ...prepared], consumerDirectory);
	for (const name of prepared) {
		// The real directory yalc left behind, and the copy of pnpm's link it displaced. Both are
		// dead once the installation is pure; leaving them means two resolutions for one specifier.
		const segments = name.split('/');
		const parent = path.join(consumerDirectory, 'node_modules', ...segments.slice(0, -1));
		rmSync(path.join(parent, segments.at(-1)), { recursive: true, force: true });
		rmSync(path.join(parent, `.ignored_${segments.at(-1)}`), { recursive: true, force: true });
	}
	const linkedManifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const linkedLock = readJsonIfPresent(path.join(consumerDirectory, 'yalc.lock'));
	const missing = names.filter((name) => {
		const specifier =
			linkedManifest?.dependencies?.[name] ?? linkedManifest?.devDependencies?.[name];
		return (
			!String(specifier ?? '').startsWith('file:.yalc/') ||
			linkedLock?.packages?.[name]?.pure !== true ||
			!existsSync(path.join(consumerDirectory, '.yalc', ...name.split('/')))
		);
	});
	if (missing.length > 0) {
		throw new Error(
			`The yalc store has no usable build for ${missing.join(', ')}. Rerun without --only to publish the complete package set.`
		);
	}
	return prepared;
};
