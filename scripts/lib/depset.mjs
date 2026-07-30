import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const depsetLayoutMarker = '.norbital-depset-layout';
const depsetLayoutVersion = 'host-plus-linux-musl-x64-arm64-v1';

/**
 * Depset materialization — the host half of the mount contract.
 *
 * A depset is `node_modules` for exactly one lockfile, keyed by the hash of that lockfile.
 * The accompanying `pnpm-workspace.yaml` is the supply-chain verification policy: it does not
 * change the installed bytes, but must travel into both pnpm invocations.
 * The host is the only thing with network access: it warms one content-addressed pnpm store
 * (`pnpm fetch`), then links a depset out of it with no network and no credentials
 * (`pnpm install --offline --frozen-lockfile`). Nothing is baked into an image, and no
 * template's dependencies leak into another template's tree.
 *
 * This mirrors `apps/core/src/lib/tenant_workspace/sandbox/toolchain.server.ts`; the two must
 * agree on `lockHash` or a host-materialized depset would not be reusable by Core.
 */

export const defaultRegistry = 'https://npm.pkg.github.com';

/** Content address of a depset: the lockfile bytes alone decide it. */
export function lockHash(lockfile) {
	return createHash('sha256').update(lockfile).digest('hex').slice(0, 32);
}

function requirePnpmWorkspace(pnpmWorkspace) {
	if (!pnpmWorkspace.trim()) {
		throw new Error(
			'A template with pnpm-lock.yaml must also carry the root pnpm-workspace.yaml supply-chain policy.'
		);
	}
	for (const [axis, values] of [
		['os', ['current', 'linux']],
		['cpu', ['current', 'x64', 'arm64']],
		['libc', ['glibc', 'musl']]
	]) {
		const section = new RegExp(`${axis}:\\s*\\n((?:\\s+-\\s+[^\\n]+\\n?)+)`).exec(
			pnpmWorkspace
		)?.[1];
		if (!section || values.some((value) => !new RegExp(`-\\s+${value}(?:\\s|$)`).test(section))) {
			throw new Error(
				`pnpm-workspace.yaml must materialize portable optional dependencies: supportedArchitectures.${axis} requires ${values.join(', ')}`
			);
		}
	}
}

function hasCurrentLayout(directory) {
	try {
		return readFileSync(path.join(directory, depsetLayoutMarker), 'utf8') === depsetLayoutVersion;
	} catch {
		return false;
	}
}

function pnpm(arguments_, cwd) {
	try {
		return execFileSync('pnpm', arguments_, {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
	} catch (cause) {
		const detail = cause?.stderr?.toString().trim() || cause?.stdout?.toString().trim();
		throw new Error(`pnpm ${arguments_.join(' ')} failed${detail ? `:\n${detail}` : '.'}`);
	}
}

function writeRegistryConfiguration(directory, { withCredentials }) {
	const registry = (process.env.NORBITAL_PACKAGE_REGISTRY ?? defaultRegistry).trim();
	const lines = [`@norbital-ai:registry=${registry}`];
	const token = withCredentials ? process.env.NODE_AUTH_TOKEN?.trim() : undefined;
	if (token) lines.push(`//${new URL(registry).host}/:_authToken=${token}`);
	writeFileSync(path.join(directory, '.npmrc'), `${lines.join('\n')}\n`);
}

/**
 * Fetch every package the lockfile names into the shared store. The only step that touches
 * the network, and the only step that needs registry credentials.
 */
export function warmStore({ manifest, lockfile, pnpmWorkspace, storeDirectory }) {
	requirePnpmWorkspace(pnpmWorkspace);
	const scratch = path.join(storeDirectory, '.warm', lockHash(lockfile));
	rmSync(scratch, { recursive: true, force: true });
	mkdirSync(scratch, { recursive: true });
	try {
		writeFileSync(path.join(scratch, 'package.json'), manifest);
		writeFileSync(path.join(scratch, 'pnpm-lock.yaml'), lockfile);
		writeFileSync(path.join(scratch, 'pnpm-workspace.yaml'), pnpmWorkspace);
		writeRegistryConfiguration(scratch, { withCredentials: true });
		pnpm(['fetch', '--frozen-lockfile', '--store-dir', storeDirectory], scratch);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Link a depset out of the warm store with no network and no credentials, then publish it
 * under its lockHash by rename. A partial or failed materialization is discarded rather than
 * left visible, so `node_modules/<lockHash>` is present only when it is complete.
 *
 * Idempotent: an existing depset is a mount, not an install.
 */
export function materialize({ manifest, lockfile, pnpmWorkspace, storeDirectory, depsetRoot }) {
	requirePnpmWorkspace(pnpmWorkspace);
	const hash = lockHash(lockfile);
	const target = path.join(depsetRoot, hash);
	if (hasCurrentLayout(target))
		return { lockHash: hash, path: target, installed: false, elapsedMs: 0 };

	mkdirSync(depsetRoot, { recursive: true });
	const staging = path.join(depsetRoot, `.staging-${hash}-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	const started = process.hrtime.bigint();
	try {
		writeFileSync(path.join(staging, 'package.json'), manifest);
		writeFileSync(path.join(staging, 'pnpm-lock.yaml'), lockfile);
		writeFileSync(path.join(staging, 'pnpm-workspace.yaml'), pnpmWorkspace);
		// No `.npmrc`: an offline install must not be able to reach a registry even if one is
		// configured, and must not have a credential to reach it with.
		pnpm(
			[
				'install',
				'--frozen-lockfile',
				'--offline',
				'--ignore-scripts',
				'--store-dir',
				storeDirectory
			],
			staging
		);
		const produced = path.join(staging, 'node_modules');
		if (!existsSync(produced)) throw new Error(`Materializing ${hash} produced no node_modules.`);
		writeFileSync(path.join(produced, depsetLayoutMarker), depsetLayoutVersion);
		if (hasCurrentLayout(target)) {
			return { lockHash: hash, path: target, installed: false, elapsedMs: 0 };
		}
		let retired;
		if (existsSync(target)) {
			retired = `${target}.retired-${randomUUID()}`;
			renameSync(target, retired);
		}
		try {
			renameSync(produced, target);
		} catch (cause) {
			if (retired && !existsSync(target)) renameSync(retired, target);
			throw cause;
		}
		return {
			lockHash: hash,
			path: target,
			installed: true,
			elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000
		};
	} catch (cause) {
		throw cause;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Warm then materialize, the two-step a Core host performs before a build. Returns the depset
 * to mount read-only at `/workspace/src/node_modules`.
 */
export function prepareDepset({ templateDirectory, storeDirectory, depsetRoot }) {
	const manifest = readFileSync(path.join(templateDirectory, 'package.json'), 'utf8');
	const lockfilePath = path.join(templateDirectory, 'pnpm-lock.yaml');
	if (!existsSync(lockfilePath)) {
		throw new Error(`${templateDirectory} has no pnpm-lock.yaml; run \`pnpm templates:lock\`.`);
	}
	const lockfile = readFileSync(lockfilePath, 'utf8');
	const pnpmWorkspacePath = path.join(templateDirectory, 'pnpm-workspace.yaml');
	if (!existsSync(pnpmWorkspacePath)) {
		throw new Error(
			`${templateDirectory} has no pnpm-workspace.yaml supply-chain policy; add and review it before materializing dependencies.`
		);
	}
	const pnpmWorkspace = readFileSync(pnpmWorkspacePath, 'utf8');
	warmStore({ manifest, lockfile, pnpmWorkspace, storeDirectory });
	return materialize({ manifest, lockfile, pnpmWorkspace, storeDirectory, depsetRoot });
}
