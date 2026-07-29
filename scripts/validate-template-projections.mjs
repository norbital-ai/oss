import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { publicPackageDirectories } from './lib/package-release.mjs';
import { discoverTemplates, repositoryRoot } from './lib/templates.mjs';

function run(command, arguments_, options = {}) {
	return execFileSync(command, arguments_, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
		...options
	});
}

function packageArchives(temporaryDirectory) {
	const archives = new Map();
	for (const directory of publicPackageDirectories) {
		const destination = path.join(temporaryDirectory, 'packages', directory);
		mkdirSync(destination, { recursive: true });
		run('pnpm', [
			'--filter',
			`@norbital-ai/${directory}`,
			'pack',
			'--pack-destination',
			destination
		]);
		const files = readdirSync(destination).filter((entry) => entry.endsWith('.tgz'));
		if (files.length !== 1) {
			throw new Error(`Expected one packed archive for @norbital-ai/${directory}.`);
		}
		archives.set(`@norbital-ai/${directory}`, path.join(destination, files[0]));
	}
	return archives;
}

function copyTrackedProjection(template, destination) {
	const sourceRoot = path.join(repositoryRoot, template.path);
	const trackedFiles = run('git', ['ls-files', '--', template.path])
		.trim()
		.split('\n')
		.filter(Boolean);
	if (trackedFiles.length === 0) throw new Error(`Template ${template.key} has no tracked files.`);
	for (const trackedFile of trackedFiles) {
		const source = path.join(repositoryRoot, trackedFile);
		const relative = path.relative(sourceRoot, source);
		const target = path.join(destination, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		copyFileSync(source, target);
	}
}

function workspaceConfiguration(archives) {
	const overrides = [...archives.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, archive]) => `  ${JSON.stringify(name)}: ${JSON.stringify(`file:${archive}`)}`)
		.join('\n');
	return [
		'packages:',
		"  - '.'",
		'autoInstallPeers: false',
		'linkWorkspacePackages: false',
		`storeDir: ${JSON.stringify(path.join(tmpdir(), 'norbital-pnpm-store'))}`,
		'allowBuilds:',
		"  '@tailwindcss/oxide': true",
		'  esbuild: true',
		'  protobufjs: true',
		'overrides:',
		overrides,
		''
	].join('\n');
}

function useLocalPackageArchives(destination, archives) {
	const manifestPath = path.join(destination, 'package.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	// The public versions do not exist before the first registry publication. Supplying the exact
	// locally packed archives here exercises the same standalone package contents without weakening
	// the projected manifest's registry-only dependency contract.
	manifest.devDependencies = {
		...manifest.devDependencies,
		...Object.fromEntries(
			[...archives.entries()].map(([name, archive]) => [name, `file:${archive}`])
		)
	};
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'norbital-template-projections-'));

try {
	const archives = packageArchives(temporaryDirectory);
	for (const template of discoverTemplates()) {
		const destination = path.join(temporaryDirectory, 'templates', template.key);
		mkdirSync(destination, { recursive: true });
		copyTrackedProjection(template, destination);
		// This gate deliberately resolves a different dependency set from the committed one:
		// it swaps the registry `@norbital-ai/*` versions for locally packed archives so a
		// template is validated before its packages are published. The committed lockfile
		// describes the registry set, so it cannot describe this install — drop it rather
		// than leave a lockfile that does not match the manifest being installed.
		// Lockfile freshness and offline installability are owned by `pnpm templates:lock:verify`.
		rmSync(path.join(destination, 'pnpm-lock.yaml'), { force: true });
		writeFileSync(path.join(destination, 'pnpm-workspace.yaml'), workspaceConfiguration(archives));
		useLocalPackageArchives(destination, archives);
		for (const [label, arguments_] of [
			['install', ['install', '--no-frozen-lockfile']],
			['sync', ['sync']],
			['lint', ['lint']],
			['build', ['build']]
		]) {
			try {
				run('pnpm', arguments_, { cwd: destination });
			} catch (cause) {
				const detail = [cause?.stdout, cause?.stderr].filter(Boolean).join('\n').trim();
				throw new Error(
					`${template.key} standalone ${label} failed${detail ? `:\n${detail}` : '.'}`
				);
			}
		}
		console.log(`Validated clean standalone projection: ${template.key}.`);
	}
} finally {
	if (process.env.KEEP_TEMPLATE_PROJECTIONS === '1') {
		console.log(`Kept standalone projections at ${temporaryDirectory}.`);
	} else {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}
