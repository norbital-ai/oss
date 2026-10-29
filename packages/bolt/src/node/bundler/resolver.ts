// Node's resolution over a file run's tree (compute model §3, "Running a file", P24): extensions, `index` files,
// `package.json` `exports`, `module` and `main`, and the tree's own `node_modules`, inside `/app` only. It runs in the
// bundler process beside rolldown, over the bytes the kernel sent: nothing on disk is consulted, so a link, a host path
// or a path out of the tree never resolves. Self-contained: the confined process may read nothing but its own code.
import { posix } from 'node:path';

/** The tree's mount: every id the bundler sees is a path under it. */
export const APP = '/app';
/** The built-ins a run provides (the guest's virtual Node); every other one fails by name. */
export const BUILTINS: ReadonlySet<string> = new Set([
	'fs',
	'fs/promises',
	'path',
	'buffer',
	'process',
	'util'
]);
const CORE: ReadonlySet<string> = new Set([
	'assert',
	'async_hooks',
	'child_process',
	'cluster',
	'console',
	'constants',
	'crypto',
	'dgram',
	'diagnostics_channel',
	'dns',
	'domain',
	'events',
	'http',
	'http2',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'perf_hooks',
	'punycode',
	'querystring',
	'readline',
	'repl',
	'stream',
	'string_decoder',
	'sys',
	'timers',
	'tls',
	'trace_events',
	'tty',
	'url',
	'v8',
	'vm',
	'wasi',
	'worker_threads',
	'zlib'
]);

export type Resolved =
	{ readonly builtin: string } | { readonly path: string } | { readonly error: string };
type Mode = 'import' | 'require';
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// package manifests and rolldown's errors arrive as anything: the bundler process's guards (it loads no Effect)
export const array = (value: unknown): value is readonly unknown[] => Array.isArray(value);
export const record = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === 'object' && value !== null && !array(value);

/** `exports`' target for `mode`: a string, the first of an array that has one, or the first matching condition. */
const target = (value: unknown, mode: Mode): string | undefined => {
	if (typeof value === 'string') return value;
	if (array(value)) {
		for (const each of value) {
			const found = target(each, mode);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!record(value)) return undefined;
	for (const condition of [mode, 'node', 'default'])
		if (condition in value) {
			const found = target(value[condition], mode);
			if (found !== undefined) return found;
		}
	return undefined;
};

/** A resolver over `files` (mount path → bytes): `(specifier, importer, mode)` → a built-in, a path, or why not. */
export function resolver(files: ReadonlyMap<string, Uint8Array>) {
	const has = (p: string) => files.has(p);
	const asFile = (p: string) =>
		[p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, `${p}.json`, `${p}.node`].find(has);
	const asIndex = (p: string) =>
		[`${p}/index.js`, `${p}/index.mjs`, `${p}/index.cjs`, `${p}/index.json`].find(has);
	const manifest = (dir: string): { readonly [key: string]: unknown } | undefined => {
		const bytes = files.get(`${dir}/package.json`);
		if (bytes === undefined) return undefined;
		try {
			const parsed: unknown = JSON.parse(decode(bytes));
			return record(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	};
	const at = (dir: string, entry: string) =>
		asFile(posix.join(dir, entry)) ?? asIndex(posix.join(dir, entry));
	/** A package's `sub` path (`''` for its root): `exports` first, then `module` (for import) and `main`. */
	const asPackage = (dir: string, sub: string, mode: Mode): string | undefined => {
		const json = manifest(dir);
		const exports = json?.['exports'];
		if (exports !== undefined && exports !== null) {
			const keyed = record(exports) && Object.keys(exports).some((k) => k.startsWith('.'));
			const entry = keyed
				? target(exports[sub === '' ? '.' : `./${sub}`], mode)
				: sub === ''
					? target(exports, mode)
					: undefined;
			if (entry !== undefined) return at(dir, entry);
			if (keyed || sub === '') return undefined;
		}
		if (sub !== '')
			return asFile(posix.join(dir, sub)) ?? asPackage(posix.join(dir, sub), '', mode);
		const main =
			(mode === 'import' && typeof json?.['module'] === 'string' ? json['module'] : undefined) ??
			(typeof json?.['main'] === 'string' ? json['main'] : undefined);
		return (main === undefined ? undefined : at(dir, main)) ?? asIndex(dir);
	};
	return (specifier: string, importer: string, mode: Mode): Resolved => {
		const name = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
		if (BUILTINS.has(name)) return { builtin: name };
		if (specifier.startsWith('node:') || CORE.has(name.split('/')[0] ?? name))
			return { error: `'${specifier}' is not available in run_js` };
		let path: string | undefined;
		if (/^\.{0,2}\//.test(specifier)) {
			const resolved = posix.resolve(posix.dirname(importer), specifier);
			if (resolved !== APP && !resolved.startsWith(`${APP}/`))
				return { error: `'${specifier}' is outside the file's tree` };
			path = asFile(resolved) ?? asPackage(resolved, '', mode);
		} else {
			const parts = specifier.split('/'),
				scoped = specifier.startsWith('@'),
				pkg = parts.slice(0, scoped ? 2 : 1).join('/'),
				sub = parts.slice(scoped ? 2 : 1).join('/');
			for (let dir = posix.dirname(importer); ; dir = posix.dirname(dir)) {
				const base = `${dir}/node_modules/${pkg}`;
				if (has(`${base}/package.json`)) {
					path = asPackage(base, sub, mode);
					break;
				}
				if (dir === APP || dir === '/') break;
			}
		}
		if (path === undefined) return { error: `Cannot find module '${specifier}'` };
		if (path.endsWith('.node'))
			return { error: `'${specifier}' is a native addon; not available in run_js` };
		return { path };
	};
}
