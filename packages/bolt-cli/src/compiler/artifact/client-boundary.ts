import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Result } from 'effect';
import type { Plugin } from 'vite';
import type { Discovered } from '../discover.ts';
import type { Role } from '@norbital-ai/bolt/tooling';

/** These roles supply browser modules; every other authored declaration stays on the compiler/server side. */
const CLIENT_ROLES: ReadonlySet<Role> = new Set([
	'page',
	'kiosk_page',
	'session',
	'representation',
	'renderer',
	'integration_setup',
	'messages',
	'locale'
]);

/** Vite queries describe how to load a file; they never grant access to the file's source. */
const modulePath = (id: string, importer?: string): string | undefined => {
	if (id.includes('\0')) return undefined;
	const path = id.split(/[?#]/, 1)[0]!;
	if (path.startsWith('file:')) return resolve(fileURLToPath(path));
	const decoded = Result.getOrElse(
		Result.try(() => decodeURIComponent(path)),
		() => path
	);
	const absolute = decoded.startsWith('/@fs/') ? decoded.slice('/@fs'.length) : decoded;
	if (isAbsolute(absolute)) return resolve(absolute);
	if (absolute.startsWith('.') && importer !== undefined) {
		const from = modulePath(importer);
		if (from !== undefined) return resolve(dirname(from), absolute);
	}
	return undefined;
};
const environmentFile = (path: string): boolean => /^\.env(?:\.|$)/i.test(basename(path));
const convention = (root: string, path: string): boolean => {
	const within = relative(root, path);
	const parts = within.split(sep);
	// These are authored workspace conventions. Dependency package exports may legitimately use server/ utilities.
	if (isAbsolute(within) || parts[0] === '..' || parts.includes('node_modules')) return false;
	return (
		/(?:^|[.+])server(?:\.|$)/i.test(basename(path)) ||
		parts.some((part) => part.toLowerCase() === 'server')
	);
};

/**
 * Guard the actual transitive browser graph, before raw/url loaders can expose source bytes.
 * Canonicalize only discovered role files and modules Vite actually resolves; there is no directory scan.
 * Type-only imports are erased by Vite/Svelte before graph resolution and remain valid.
 * A module the platform layer exposes (`platform`: resolved id → its import) is imported from the layer, never bundled
 * again; the mapping sits here because this hook sees every import's final resolution.
 */
export const clientImportBoundary = (
	root: string,
	files: readonly Discovered[],
	platform: ReadonlyMap<string, string> = new Map()
): Plugin => {
	const canonical = new Map<string, Promise<string>>();
	const canonicalPath = (path: string) => {
		let pending = canonical.get(path);
		if (pending === undefined) {
			pending = realpath(path).catch((cause: unknown) => {
				if (
					cause !== null &&
					typeof cause === 'object' &&
					'code' in cause &&
					(cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
				)
					return path;
				throw cause;
			});
			canonical.set(path, pending);
		}
		return pending;
	};
	const authored = new Set(
		files.filter((file) => !CLIENT_ROLES.has(file.role)).map((file) => resolve(root, file.path))
	);
	let realAuthored: Promise<Set<string>> | undefined;
	// repository-health:allow EFF3 -- Called only by Vite's asynchronous resolution/loading boundary.
	const guard = async (id: string, importer?: string) => {
		const path = modulePath(id, importer);
		if (path === undefined) return;
		realAuthored ??= Promise.all([...authored].map(canonicalPath)).then((paths) => new Set(paths));
		const forbidden = await realAuthored;
		const actual = await canonicalPath(path);
		const realRoot = await canonicalPath(resolve(root));
		if (
			authored.has(path) ||
			forbidden.has(actual) ||
			environmentFile(path) ||
			environmentFile(actual) ||
			convention(resolve(root), path) ||
			convention(realRoot, actual)
		)
			throw new Error(
				`Server-only module cannot be imported by the client: ${relative(root, path)}. Move shared browser values to an ordinary src/lib module, or use an import type.`
			);
	};
	return {
		name: 'bolt:client-import-boundary',
		apply: 'build',
		enforce: 'pre',
		// repository-health:allow EFF3 -- Vite resolves and loads through its Promise plugin ABI.
		async resolveId(id, importer, options) {
			await guard(id, importer);
			const resolved = await this.resolve(id, importer, { ...options, skipSelf: true });
			if (resolved === null) return resolved;
			await guard(resolved.id);
			const shared = resolved.external ? undefined : platform.get(resolved.id);
			if (shared === undefined) return resolved;
			return { id: shared, external: true };
		},
		// repository-health:allow EFF3 -- Guard resolved IDs before Vite's raw/url loaders read their bytes.
		async load(id) {
			await guard(id);
			return null;
		}
	};
};
