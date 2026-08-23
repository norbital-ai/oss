/** Consumer-side yalc linking; pnpm must reinstall whenever stamped package signatures differ. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParse } from '@norbital-ai/std/json';
import { Effect } from 'effect';
import { readPublicPackageEntries } from './package-release.mjs';

export const signatureField = 'yalcSignature';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localPackageNames = new Set(readPublicPackageEntries(repositoryRoot).map(({ name }) => name));

export const readJsonIfPresent = (file) => {
	if (!existsSync(file)) return undefined;
	return safeParse(readFileSync(file, 'utf8')) ?? undefined;
};

/** Locally publishable dependencies, whether clean registry pins or existing overlays. */
export const managedPackages = (consumerDirectory) => {
	const manifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const sections = [manifest?.dependencies, manifest?.devDependencies];
	return sections.flatMap((section) =>
		Object.entries(section ?? {}).flatMap(([name]) => (localPackageNames.has(name) ? [name] : []))
	);
};

const manifestSignature = (manifestPath) => readJsonIfPresent(manifestPath)?.[signatureField];

/**
 * What the last push left in `.yalc/<name>` versus what pnpm materialised through the
 * node_modules symlink — the content this consumer is supposed to be running, and the proof.
 * Missing signatures are stale because they provide no evidence that pnpm materialised the push.
 */
export const stalePackages = (consumerDirectory, names) =>
	names.filter((name) => {
		if (!existsSync(path.join(consumerDirectory, '.yalc', ...name.split('/')))) return false;
		const linked = manifestSignature(
			path.join(consumerDirectory, '.yalc', ...name.split('/'), 'package.json')
		);
		const installed = manifestSignature(
			path.join(consumerDirectory, 'node_modules', ...name.split('/'), 'package.json')
		);
		return linked === undefined || linked !== installed;
	});

/** Link consumers without leaving publish-time dependency coordinates in source control. */
export const linkConsumers = ({ consumers, force = false, install, run, yalcBin }) => {
	return Effect.runSync(
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const snapshots = new Map();
				for (const file of new Set(
					consumers.flatMap(({ directory, stateFiles = [] }) => [
						path.join(directory, 'package.json'),
						path.join(directory, 'pnpm-lock.yaml'),
						path.join(directory, 'yalc.lock'),
						...stateFiles
					])
				)) {
					snapshots.set(file, existsSync(file) ? readFileSync(file) : undefined);
				}
				return snapshots;
			}),
			() =>
				Effect.try({
					try: () => {
						const states = consumers.map((consumer) => {
							const packages = managedPackages(consumer.directory);
							const prepared = ensurePureInstallation({
								consumerDirectory: consumer.directory,
								names: packages,
								yalcBin,
								run
							});
							const stale = stalePackages(consumer.directory, packages);
							return { ...consumer, packages, prepared, stale };
						});
						const changed = states.filter(
							({ prepared, stale }) => force || prepared.length > 0 || stale.length > 0
						);
						if (changed.length > 0) install(changed);
						return states;
					},
					catch: (cause) => cause
				}),
			(snapshots) =>
				Effect.sync(() => {
					for (const [file, contents] of snapshots) {
						if (contents === undefined) rmSync(file, { force: true });
						else writeFileSync(file, contents);
					}
				})
		)
	);
};

/** Convert registry pins to pure overlays; pnpm remains the sole owner of node_modules. */
export const ensurePureInstallation = ({ consumerDirectory, names, yalcBin, run }) => {
	const manifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const lockfile = readJsonIfPresent(path.join(consumerDirectory, 'yalc.lock'));
	const unlinked = names.filter(
		(name) =>
			!String(manifest?.dependencies?.[name] ?? manifest?.devDependencies?.[name] ?? '').startsWith(
				'file:.yalc/'
			)
	);
	// A missing lock entry is also an impure/incomplete installation.
	const impure = names.filter((name) => lockfile?.packages?.[name]?.pure !== true);
	if (unlinked.length > 0) {
		// Plain add records the replaced registry pin; the pure pass then yields ownership to pnpm.
		run(yalcBin, ['add', ...unlinked], consumerDirectory);
	}
	const prepared = [...new Set([...unlinked, ...impure])];
	if (prepared.length > 0) run(yalcBin, ['add', '--pure', ...prepared], consumerDirectory);
	for (const name of prepared) {
		// Pure mode must leave neither yalc's directory nor its displaced copy of pnpm's link.
		const segments = name.split('/');
		const parent = path.join(consumerDirectory, 'node_modules', ...segments.slice(0, -1));
		rmSync(path.join(parent, segments.at(-1)), { recursive: true, force: true });
		rmSync(path.join(parent, `.ignored_${segments.at(-1)}`), { recursive: true, force: true });
	}
	const linkedManifest = readJsonIfPresent(path.join(consumerDirectory, 'package.json'));
	const linkedLock = readJsonIfPresent(path.join(consumerDirectory, 'yalc.lock'));
	// Some yalc versions leave `file: true`; the actual tree, not that label, proves purity.
	const missing = names.filter((name) => {
		const specifier =
			linkedManifest?.dependencies?.[name] ?? linkedManifest?.devDependencies?.[name];
		const segments = name.split('/');
		const displaced = path.join(
			consumerDirectory,
			'node_modules',
			...segments.slice(0, -1),
			`.ignored_${segments.at(-1)}`
		);
		const entry = linkedLock?.packages?.[name];
		return (
			!String(specifier ?? '').startsWith('file:.yalc/') ||
			entry === undefined ||
			(entry.pure !== true && existsSync(displaced)) ||
			!existsSync(path.join(consumerDirectory, '.yalc', ...segments))
		);
	});
	if (missing.length > 0) {
		throw new Error(
			`The yalc store has no usable build for ${missing.join(', ')}. Rerun without --only to publish the complete package set.`
		);
	}
	return prepared;
};
