import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { defaultRegistry } from './lib/depset.mjs';
import { discoverTemplates, repositoryRoot } from './lib/templates.mjs';

const lockfileName = 'pnpm-lock.yaml';

function fail(message) {
	throw new Error(message);
}

function readArguments(argv) {
	const options = { check: false, verifyInstall: false, filter: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--check') options.check = true;
		else if (argument === '--verify-install') options.verifyInstall = true;
		else if (argument === '--filter') options.filter = argv[++index];
		else fail(`Unknown argument: ${argument}`);
	}
	if (options.filter === '') fail('--filter requires a template key.');
	return options;
}

/**
 * Resolve one template as a standalone project, outside this pnpm workspace, so the
 * lockfile records the published `@norbital-ai/*` archives a projected template installs
 * rather than the workspace links used for local development.
 *
 * Registry credentials are read from ambient npm configuration; only the scope-to-registry
 * mapping is written, and the temporary directory is always removed.
 */
function resolveLockfile(template) {
	const registry = (process.env.NORBITAL_PACKAGE_REGISTRY ?? defaultRegistry).trim();
	const workingDirectory = mkdtempSync(path.join(tmpdir(), `norbital-lock-${template.key}-`));
	const storeDirectory = path.join(workingDirectory, '.pnpm-store');
	const cacheDirectory = path.join(workingDirectory, '.pnpm-cache');
	try {
		copyFileSync(
			path.join(template.directory, 'package.json'),
			path.join(workingDirectory, 'package.json')
		);
		const npmrc = [`@norbital-ai:registry=${registry}`];
		const token = process.env.NODE_AUTH_TOKEN?.trim();
		if (token) npmrc.push(`//${new URL(registry).host}/:_authToken=${token}`);
		writeFileSync(path.join(workingDirectory, '.npmrc'), `${npmrc.join('\n')}\n`);
		try {
			execFileSync(
				'pnpm',
				[
					'install',
					'--lockfile-only',
					'--ignore-workspace',
					'--force',
					'--store-dir',
					storeDirectory,
					'--cache-dir',
					cacheDirectory
				],
				{
					cwd: workingDirectory,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe']
				}
			);
		} catch (cause) {
			const detail = cause?.stderr?.toString().trim() || cause?.stdout?.toString().trim();
			fail(`Resolving ${template.key} failed${detail ? `:\n${detail}` : ''}`);
		}
		const resolved = path.join(workingDirectory, lockfileName);
		if (!existsSync(resolved)) fail(`Resolving ${template.key} produced no ${lockfileName}.`);
		return readFileSync(resolved, 'utf8');
	} finally {
		rmSync(workingDirectory, { recursive: true, force: true });
	}
}

/**
 * Prove the committed lockfile is what a Core host actually installs: warm one shared
 * content-addressed store over the network, then install with no network and no registry
 * credentials. A shared store across templates also exercises cross-template package reuse.
 */
function verifyOfflineInstall(template, lockfile, storeDirectory) {
	const registry = (process.env.NORBITAL_PACKAGE_REGISTRY ?? defaultRegistry).trim();
	const workingDirectory = mkdtempSync(path.join(tmpdir(), `norbital-verify-${template.key}-`));
	try {
		copyFileSync(
			path.join(template.directory, 'package.json'),
			path.join(workingDirectory, 'package.json')
		);
		writeFileSync(path.join(workingDirectory, lockfileName), lockfile);
		const npmrc = [`@norbital-ai:registry=${registry}`];
		const token = process.env.NODE_AUTH_TOKEN?.trim();
		if (token) npmrc.push(`//${new URL(registry).host}/:_authToken=${token}`);
		const npmrcPath = path.join(workingDirectory, '.npmrc');
		writeFileSync(npmrcPath, `${npmrc.join('\n')}\n`);

		const pnpm = (arguments_) =>
			execFileSync('pnpm', arguments_, {
				cwd: workingDirectory,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
		try {
			pnpm(['fetch', '--frozen-lockfile', '--store-dir', storeDirectory]);
		} catch (cause) {
			const detail = cause?.stderr?.toString().trim() || cause?.stdout?.toString().trim();
			fail(`Warming the store for ${template.key} failed${detail ? `:\n${detail}` : ''}`);
		}
		// Removing credentials before the offline install proves the sandbox needs neither
		// network egress nor registry access once the host store is warm.
		rmSync(npmrcPath, { force: true });
		const started = Date.now();
		try {
			pnpm([
				'install',
				'--frozen-lockfile',
				'--offline',
				'--ignore-scripts',
				'--store-dir',
				storeDirectory
			]);
		} catch (cause) {
			const detail = cause?.stderr?.toString().trim() || cause?.stdout?.toString().trim();
			fail(`Offline install for ${template.key} failed${detail ? `:\n${detail}` : ''}`);
		}
		return Date.now() - started;
	} finally {
		rmSync(workingDirectory, { recursive: true, force: true });
	}
}

const options = readArguments(process.argv.slice(2));
const templates = discoverTemplates(options.filter);
const drifted = [];
const verifyStore = options.verifyInstall
	? mkdtempSync(path.join(tmpdir(), 'norbital-verify-store-'))
	: undefined;

for (const template of templates) {
	const committedPath = path.join(template.directory, lockfileName);
	const resolved = resolveLockfile(template);
	const committed = existsSync(committedPath) ? readFileSync(committedPath, 'utf8') : undefined;

	if (options.check) {
		if (committed === undefined) {
			drifted.push(`${template.key}: missing ${lockfileName}`);
		} else if (committed !== resolved) {
			drifted.push(`${template.key}: ${lockfileName} does not match resolved dependencies`);
		} else {
			console.log(`${template.key}: up to date`);
		}
	} else if (committed === resolved) {
		console.log(`${template.key}: unchanged`);
	} else {
		writeFileSync(committedPath, resolved);
		console.log(`${template.key}: wrote ${path.relative(repositoryRoot, committedPath)}`);
	}

	if (verifyStore) {
		const elapsed = verifyOfflineInstall(template, resolved, verifyStore);
		console.log(`${template.key}: offline install from a warm store in ${elapsed} ms`);
	}
}

if (verifyStore) rmSync(verifyStore, { recursive: true, force: true });

if (drifted.length > 0) {
	fail(`Template lockfiles are stale. Run \`pnpm templates:lock\`.\n  ${drifted.join('\n  ')}`);
}
