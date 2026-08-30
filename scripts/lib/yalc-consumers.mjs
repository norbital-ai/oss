/** Consumer-side yalc linking; pnpm must reinstall whenever stamped package signatures differ. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeParse } from '@norbital-ai/std/json';
import { Effect } from 'effect';
import { readPublicPackageEntries } from './package-release.mjs';

export const signatureField = 'yalcSignature';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const localPackageNames = new Set(readPublicPackageEntries(repositoryRoot).map(({ name }) => name));

export const tenantSubstrateRootEnvironment = 'NORBITAL_TENANT_SUBSTRATE_ROOT';
const tenantSubstrateSchema = 'norbital-tenant-substrate/v1';
const tenantSubstrateLabelKey = 'io.norbital.tenant-substrate';
const generationPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const microsandboxResourcePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;

const exactResourceNames = (values) =>
	Array.isArray(values) &&
	values.every((value) => typeof value === 'string' && microsandboxResourcePattern.test(value)) &&
	new Set(values).size === values.length;

const exactInstances = (values, root) =>
	Array.isArray(values) &&
	values.every((value) => {
		if (
			value === null ||
			typeof value !== 'object' ||
			!microsandboxResourcePattern.test(String(value.name ?? '')) ||
			typeof value.workspace !== 'string' ||
			!path.isAbsolute(value.workspace) ||
			canonicalPath(value.workspace) !== value.workspace
		) {
			return false;
		}
		const relative = path.relative(path.join(root, 'tenants'), value.workspace);
		const parts = relative.split(path.sep);
		return (
			!relative.startsWith('..') &&
			!path.isAbsolute(relative) &&
			parts.length === 5 &&
			parts[0]?.length > 0 &&
			parts[1] === 'repositories' &&
			parts[2]?.length > 0 &&
			parts[3] === 'worktrees' &&
			parts[4]?.length > 0
		);
	}) &&
	new Set(values.map((value) => value.name)).size === values.length;

const canonicalPath = (input) => {
	let cursor = path.resolve(input);
	const tail = [];
	while (!existsSync(cursor)) {
		const parent = path.dirname(cursor);
		if (parent === cursor) break;
		tail.unshift(path.basename(cursor));
		cursor = parent;
	}
	const physical = existsSync(cursor) ? realpathSync.native(cursor) : path.resolve(cursor);
	return path.join(physical, ...tail);
};

/**
 * The realm has one package-materialisation root. Publishing is an internal `env` phase, so it
 * refuses to recreate or silently claim an unowned root when that phase has not opened it first.
 */
export const resolveTenantSubstrateRoot = ({ environment = process.env } = {}) => {
	const configured = environment[tenantSubstrateRootEnvironment]?.trim();
	const selected = configured || path.resolve(repositoryRoot, '../norbital/.tenant_substrate');
	if (!path.isAbsolute(selected)) {
		throw new Error(`${tenantSubstrateRootEnvironment} must be an absolute path: ${selected}`);
	}
	const root = canonicalPath(selected);
	if (root !== path.resolve(selected)) {
		throw new Error(`tenant substrate root must be canonical, not a symlink alias: ${selected}`);
	}
	const marker = path.join(root, '.owner.json');
	if (!existsSync(marker)) {
		throw new Error(`tenant substrate ownership marker is missing: ${marker}`);
	}
	const markerStat = lstatSync(marker);
	if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
		throw new Error(`tenant substrate ownership marker is not a regular file: ${marker}`);
	}
	const owner = readJsonIfPresent(marker);
	const digest = createHash('sha256').update(root).digest('hex');
	if (
		owner?.schema !== tenantSubstrateSchema ||
		owner.canonicalRootDigest !== digest ||
		owner.target !== 'dev' ||
		!generationPattern.test(owner.generation) ||
		owner.microsandbox?.label !== `${tenantSubstrateLabelKey}=${digest}` ||
		!exactInstances(owner.microsandbox?.instances, root) ||
		!exactResourceNames(owner.microsandbox?.volumes) ||
		!exactResourceNames(owner.microsandbox?.snapshots) ||
		!exactResourceNames(owner.microsandbox?.images)
	) {
		throw new Error(`tenant substrate ownership marker does not own ${root}`);
	}
	return root;
};

/** Refuse a symlinked package subtree before pnpm or yalc can write outside the owned root. */
export const tenantSubstratePackagePaths = (root) => {
	const paths = {
		pnpmStore: path.join(root, 'packages/pnpm-store'),
		pnpmCache: path.join(root, 'packages/pnpm-cache'),
		hostPnpmStore: path.join(root, 'packages/host-pnpm-store'),
		hostPnpmCache: path.join(root, 'packages/host-pnpm-cache'),
		yalcStore: path.join(root, 'packages/local/yalc')
	};
	for (const [name, candidate] of Object.entries(paths)) {
		if (canonicalPath(candidate) !== candidate) {
			throw new Error(`tenant substrate ${name} path escapes through a symlink: ${candidate}`);
		}
	}
	return paths;
};

/** yalc's complete mutable global store, including installations.json, lives under packages/local. */
export const resolveYalcStoreDirectory = (options) => {
	const root = resolveTenantSubstrateRoot(options);
	return tenantSubstratePackagePaths(root).yalcStore;
};

const withYalcStore = (storeDirectory, arguments_) => [
	'--store-folder',
	storeDirectory,
	...arguments_
];

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
export const linkConsumers = ({
	consumers,
	force = false,
	install,
	run,
	yalcBin,
	yalcStoreDirectory = resolveYalcStoreDirectory()
}) => {
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
								yalcStoreDirectory,
								run,
								force
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
export const ensurePureInstallation = ({
	consumerDirectory,
	names,
	yalcBin,
	yalcStoreDirectory = resolveYalcStoreDirectory(),
	run,
	force = false
}) => {
	const linkedPackageManifest = (name) =>
		path.join(consumerDirectory, '.yalc', ...name.split('/'), 'package.json');
	const outdated = names.filter((name) => {
		const linked = readJsonIfPresent(linkedPackageManifest(name));
		const version = linked?.version;
		if (typeof version !== 'string') return false;
		const stored = manifestSignature(
			path.join(yalcStoreDirectory, 'packages', ...name.split('/'), version, 'package.json')
		);
		return stored !== undefined && stored !== linked?.[signatureField];
	});
	// A stamped signature on leftover `.yalc` files is not proof the store was copied.
	// `yalc add --pure` skips the copy when it already sees that stamp, so `--force`
	// and a newer store build must delete the leftover tree before re-adding it.
	if (force || outdated.length > 0) {
		for (const name of force ? names : outdated) {
			rmSync(path.join(consumerDirectory, '.yalc', ...name.split('/')), {
				recursive: true,
				force: true
			});
		}
	}
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
		run(yalcBin, withYalcStore(yalcStoreDirectory, ['add', ...unlinked]), consumerDirectory);
	}
	const prepared = [...new Set([...unlinked, ...impure, ...outdated, ...(force ? names : [])])];
	if (prepared.length > 0)
		run(
			yalcBin,
			withYalcStore(yalcStoreDirectory, ['add', '--pure', ...prepared]),
			consumerDirectory
		);
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
