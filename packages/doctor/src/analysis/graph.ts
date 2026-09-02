/**
 * Module-graph construction: package ownership, specifier resolution, cycles, and test reach.
 *
 * Resolution follows the repository's own declarations rather than a convention table: relative
 * specifiers, nearest ancestor `tsconfig`/`jsconfig` paths, manifest `imports` aliases, sibling
 * package names with their full conditional `exports`, the fixed `$lib/` alias onto `src/lib`, and Vite query or
 * hash suffixes stripped before extension probing. Build output named by an export projects back
 * onto the source that produces it, because the graph holds source files, not artifacts.
 *
 * Type-only edges stay in the architecture picture (coupling and cycles), while test reachability
 * follows value edges only — a type import proves nothing about what a test can execute.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { jsonRecord, readJsonObject, recordField } from '../manifest.js';
import { SOURCE_EXTENSIONS } from './inventory.js';

/** The nearest ancestor directory with a `package.json`, identified for reports. */
export type PackageOwner = Readonly<{
	root: string;
	name: string;
	scanRoot: string;
	id: string;
}>;

/** One compiler-path or manifest-imports alias, ordered for longest-pattern-first matching. */
export type AliasMapping = Readonly<{
	pattern: string;
	targets: ReadonlyArray<string>;
	order: number;
}>;

/** The outcome of resolving one import specifier against the file inventory. */
export type Resolution = Readonly<{ targets: ReadonlyArray<string>; internal: boolean }>;

/** Flatten conditional exports/imports; the graph conservatively includes every source target. */
export function stringTargets(value: unknown): Array<string> {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(stringTargets);
	const boxed = jsonRecord(value);
	if (boxed !== undefined) return Object.values(boxed).flatMap(stringTargets);
	return [];
}

/** Parse package and compiler alias maps once so graph edges follow the repository's declarations. */
export function moduleMappings(owner: PackageOwner): Array<AliasMapping> {
	const aliases: Array<AliasMapping> = [];
	let order = 0;
	const manifestPath = join(owner.root, 'package.json');
	if (existsSync(manifestPath)) {
		// A malformed manifest yields no imports here; ownership elsewhere still survives it.
		const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
		const imports = jsonRecord(parsed)?.['imports'] ?? {};
		for (const [pattern, target] of Object.entries(imports)) {
			// A manifest points an alias at build output; the source that produces it is what the
			// graph holds. `exportedStems` already does this for `exports`, and omitting it here left
			// `#lib/*` -> `./build/*` resolving into a directory the scan never reads, so a
			// package's own hashed imports produced no edges at all.
			const targets = stringTargets(target)
				.map((item) =>
					item
						.replace(/^\.\/(?:build|dist)\//, './src/')
						.replace(/\.d\.(?:ts|mts|cts)$/, '')
						.replace(/\.(?:js|jsx|mjs|cjs)$/, '')
				)
				.map((item) => resolve(owner.root, item));
			if (targets.length > 0) aliases.push({ pattern, targets, order: order++ });
		}
	}
	let configDirectory = owner.root;
	let config: string | undefined;
	while (
		configDirectory === owner.scanRoot ||
		configDirectory.startsWith(`${owner.scanRoot}${sep}`)
	) {
		config = ['tsconfig.json', 'jsconfig.json']
			.map((name) => join(configDirectory, name))
			.find(existsSync);
		if (config || configDirectory === owner.scanRoot) break;
		configDirectory = dirname(configDirectory);
	}
	if (config) {
		const loaded = ts.readConfigFile(config, ts.sys.readFile);
		if (!loaded.error) {
			const parsed = ts.parseJsonConfigFileContent(
				loaded.config,
				ts.sys,
				dirname(config),
				undefined,
				config
			);
			// Either configured root may be absent; a non-string value is treated as unset rather
			// than coerced, matching how the engine would have crashed only on real use.
			const configuredBase: unknown = parsed.options.baseUrl ?? parsed.options.pathsBasePath;
			const base = typeof configuredBase === 'string' ? configuredBase : dirname(config);
			const rawPaths: unknown = parsed.options.paths;
			const pathMap = jsonRecord(rawPaths) ?? {};
			for (const [pattern, targets] of Object.entries(pathMap)) {
				aliases.push({
					pattern,
					targets: [...(Array.isArray(targets) ? targets : [])]
						.filter((target): target is string => typeof target === 'string')
						.map((target) => resolve(base, target)),
					order: order++
				});
			}
		}
	}
	return aliases.sort(
		(a, b) =>
			b.pattern.replace('*', '').length - a.pattern.replace('*', '').length || a.order - b.order
	);
}

/** Apply one exact or single-star subpath pattern. */
export function mappedStems(specifier: string, mapping: AliasMapping): Array<string> {
	const star = mapping.pattern.indexOf('*');
	if (star < 0) return specifier === mapping.pattern ? [...mapping.targets] : [];
	const prefix = mapping.pattern.slice(0, star);
	const suffix = mapping.pattern.slice(star + 1);
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
	const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
	return mapping.targets.map((target) => target.replaceAll('*', captured));
}

/** Select every source target behind a public package export, including conditional branches. */
export function exportedStems(owner: PackageOwner, subpath: string): Array<string> {
	const manifest = join(owner.root, 'package.json');
	if (!existsSync(manifest)) return [];
	const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
	const declared = jsonRecord(parsed)?.['exports'] ?? undefined;
	const request = subpath === '' ? '.' : `./${subpath}`;
	const noDotKeys =
		jsonRecord(declared) !== undefined && !Object.keys(jsonRecord(declared) ?? {}).some((key) => key.startsWith('.'));
	const entries: Array<[string, unknown]> =
		typeof declared === 'string' || Array.isArray(declared)
			? [['.', declared]]
			: noDotKeys
				? [['.', declared]]
				: Object.entries(jsonRecord(declared) ?? {});
	for (const [pattern, value] of entries) {
		const star = pattern.indexOf('*');
		let captured = '';
		if (star < 0) {
			if (pattern !== request) continue;
		} else {
			const prefix = pattern.slice(0, star);
			const suffix = pattern.slice(star + 1);
			if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
			captured = request.slice(prefix.length, request.length - suffix.length);
		}
		return stringTargets(value).map((selected) => {
			const target = selected
				.replaceAll('*', captured)
				.replace(/^\.\/(?:build|dist)\//, './src/')
				.replace(/\.d\.(?:ts|mts|cts)$/, '')
				.replace(/\.(?:js|jsx|mjs|cjs)$/, '');
			return resolve(owner.root, target);
		});
	}
	return [];
}

/** Locate package ownership once per directory and retain names for sibling-package import resolution. */
export function packageFor(
	path: string,
	scanRoot: string,
	rootId: string,
	cache: Map<string, PackageOwner>
): PackageOwner {
	let directory = dirname(path);
	const visited: Array<string> = [];
	while (true) {
		const cached = cache.get(directory);
		if (cached !== undefined) {
			for (const item of visited) cache.set(item, cached);
			return cached;
		}
		visited.push(directory);
		const manifest = join(directory, 'package.json');
		if (existsSync(manifest)) {
			let name = basename(directory);
			try {
				const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
				const declaredName = jsonRecord(parsed)?.['name'] ?? undefined;
				if (declaredName != null) name = typeof declaredName === 'string' ? declaredName : String(declaredName);
			} catch {
				/* ownership survives invalid metadata */
			}
			const packagePath = relative(scanRoot, directory).split(sep).join('/') || '.';
			const found: PackageOwner = {
				root: directory,
				name,
				scanRoot,
				id: `${rootId}/${name}@${packagePath}`
			};
			for (const item of visited) cache.set(item, found);
			return found;
		}
		const parent = dirname(directory);
		if (parent === directory || directory === scanRoot) {
			const found: PackageOwner = {
				root: directory,
				name: basename(directory),
				scanRoot,
				id: `${rootId}/${basename(directory)}@.`
			};
			for (const item of visited) cache.set(item, found);
			return found;
		}
		directory = parent;
	}
}

/** Resolve one possible stem through runtime extensions and source index files. */
export function resolveStem(stem: string, fileSet: ReadonlySet<string>): string | undefined {
	const clean = stem.replace(/[?#].*$/, '');
	const extension = extname(clean);
	const withoutRuntimeExtension = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
		? clean.slice(0, -extension.length)
		: clean;
	const candidates = [
		clean,
		withoutRuntimeExtension,
		...[...SOURCE_EXTENSIONS].map((item) => `${withoutRuntimeExtension}${item}`),
		...[...SOURCE_EXTENSIONS].map((item) => join(withoutRuntimeExtension, `index${item}`))
	];
	return candidates.find((candidate) => fileSet.has(candidate));
}

/** Resolve a source specifier and distinguish unresolved internal edges from external packages. */
export function resolveImport(
	from: string,
	specifier: string,
	fileSet: ReadonlySet<string>,
	packageByName: ReadonlyMap<string, ReadonlyArray<PackageOwner>>,
	owner: PackageOwner,
	aliasesByRoot: ReadonlyMap<string, ReadonlyArray<AliasMapping>>
): Resolution {
	let stems: Array<string> = [];
	let internal = false;
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		internal = true;
		stems = [resolve(dirname(from), specifier)];
	} else {
		for (const mapping of aliasesByRoot.get(owner.root) ?? []) {
			const mapped = mappedStems(specifier, mapping);
			if (mapped.length === 0) continue;
			internal = true;
			stems = mapped;
			break;
		}
	}
	// `#lib/` is not a convention — it is whatever the manifest's `imports` map says, which
	// `moduleMappings` now reads. `$lib/` is a fixed alias onto `src/lib`, so it stays.
	if (stems.length === 0 && specifier.startsWith('#')) internal = true;
	if (stems.length === 0 && specifier.startsWith('$lib/')) {
		internal = true;
		stems = [join(owner.root, 'src', 'lib', specifier.slice(5))];
	}
	if (stems.length === 0) {
		const matched = [...packageByName.keys()]
			.sort((a, b) => b.length - a.length || a.localeCompare(b))
			.find((name) => specifier === name || specifier.startsWith(`${name}/`));
		if (matched) {
			internal = true;
			const owners = packageByName.get(matched) ?? [];
			const localOwners = owners.filter((candidate) => candidate.scanRoot === owner.scanRoot);
			const candidates = localOwners.length > 0 ? localOwners : owners;
			if (candidates.length !== 1)
				throw new Error(
					`ambiguous package name ${matched}: ${candidates.map((item) => item.id).join(', ')}`
				);
			const target = candidates[0];
			if (!target) throw new Error(`ambiguous package name ${matched}`);
			const subpath = specifier === matched ? '' : specifier.slice(matched.length + 1);
			stems = exportedStems(target, subpath);
			if (stems.length === 0) stems = [join(target.root, 'src', subpath || 'index')];
		}
	}
	const targets = [
		...new Set(
			stems
				.map((stem) => resolveStem(stem, fileSet))
				.filter((item): item is string => item !== undefined)
		)
	].sort();
	return { targets, internal };
}

/** Find strongly connected components using a stable Tarjan traversal. */
export function stronglyConnected(
	nodes: ReadonlySet<string>,
	adjacency: ReadonlyMap<string, ReadonlySet<string>>
): Array<Array<string>> {
	let index = 0;
	const stack: Array<string> = [];
	const onStack = new Set<string>();
	const indices = new Map<string, number>();
	const low = new Map<string, number>();
	const components: Array<Array<string>> = [];
	const connect = (node: string): void => {
		indices.set(node, index);
		low.set(node, index);
		index += 1;
		stack.push(node);
		onStack.add(node);
		for (const target of [...(adjacency.get(node) ?? [])].sort()) {
			if (!indices.has(target)) {
				connect(target);
				low.set(node, Math.min(low.get(node) ?? Number.NaN, low.get(target) ?? Number.NaN));
			} else if (onStack.has(target))
				low.set(node, Math.min(low.get(node) ?? Number.NaN, indices.get(target) ?? Number.NaN));
		}
		if ((low.get(node) ?? Number.NaN) === (indices.get(node) ?? Number.NaN)) {
			const component: Array<string> = [];
			let current: string | undefined;
			do {
				current = stack.pop();
				onStack.delete(current ?? '');
				component.push(current ?? '');
			} while (current !== node);
			components.push(component.sort());
		}
	};
	for (const node of [...nodes].sort()) if (!indices.has(node)) connect(node);
	return components
		.filter(
			(component) =>
				component.length > 1 || adjacency.get(component[0] ?? '')?.has(component[0] ?? '') === true
		)
		.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/** Follow production dependencies reachable from every test module. */
export function testReach(
	testFiles: ReadonlySet<string>,
	adjacency: ReadonlyMap<string, ReadonlySet<string>>,
	productionSet: ReadonlySet<string>
): Set<string> {
	const reached = new Set<string>();
	const queue = [...testFiles].sort();
	const seen = new Set(queue);
	while (queue.length > 0) {
		const current = queue.shift() ?? '';
		for (const target of [...(adjacency.get(current) ?? [])].sort()) {
			if (productionSet.has(target)) reached.add(target);
			if (!seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return reached;
}
