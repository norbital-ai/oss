import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const SOURCE_EXTENSIONS = [
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mts',
	'.mjs',
	'.cts',
	'.cjs',
	'.svelte'
] as const;

const SKIP_DIRECTORIES = new Set([
	'.git',
	'.norbital',
	'.svelte-kit',
	'.turbo',
	'build',
	'coverage',
	'dist',
	'node_modules'
]);

export type ImportRecord = Readonly<{
	readonly file: string;
	readonly specifier: string;
}>;

const endsWithExtension = (path: string, extensions: readonly string[]): boolean =>
	extensions.some((extension) => path.endsWith(extension));

/**
 * Lists source files under `root`. Skips install and emit directories so a walker pointed at a
 * package tree does not report another package's imports as this owner's.
 */
export function listFiles(
	root: string,
	extensions: readonly string[] = SOURCE_EXTENSIONS
): readonly string[] {
	// repository-health:allow IO1 -- source-tree scanner with a deliberately synchronous public API; it runs in test/analysis tooling, not request runtime.
	return readdirSync(root).flatMap((entry) => {
		const path = join(root, entry);
		if (SKIP_DIRECTORIES.has(entry)) return [];
		// repository-health:allow IO1 -- same synchronous scanner contract; a per-step directory-vs-file probe.
		if (statSync(path).isDirectory()) {
			return listFiles(path, extensions);
		}
		return endsWithExtension(path, extensions) ? [path] : [];
	});
}

const scriptBodies = (source: string): string =>
	[...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
		.map((match) => match[1] ?? '')
		.join('\n');

const typescriptText = (file: string, source: string): string =>
	file.endsWith('.svelte') ? scriptBodies(source) : source;

/**
 * Collects module specifiers from import, export-from, dynamic import, and require. Comments and
 * ordinary string literals are not specifiers.
 */
export function specifiersInSource(file: string, source: string): readonly string[] {
	const parsed = ts.createSourceFile(
		file.endsWith('.svelte') ? `${file}.ts` : file,
		typescriptText(file, source),
		ts.ScriptTarget.Latest,
		true
	);
	const specifiers: Array<string> = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier.text);
		}
		if (ts.isCallExpression(node)) {
			const argument = node.arguments[0];
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
			if (
				(isDynamicImport || isRequire) &&
				argument !== undefined &&
				ts.isStringLiteral(argument)
			) {
				specifiers.push(argument.text);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed);
	return specifiers;
}

export function walkImportSpecifiers(
	root: string,
	extensions: readonly string[] = SOURCE_EXTENSIONS
): readonly ImportRecord[] {
	// repository-health:allow IO1 -- same synchronous scanner contract; the source reads back the walkers' public sync API.
	return listFiles(root, extensions).flatMap((file) =>
		specifiersInSource(file, readFileSync(file, 'utf8')).map((specifier) => ({ file, specifier })) // repository-health:allow IO1 -- same synchronous scanner contract.
	);
}

const normalizePath = (value: string): string => value.replaceAll('\\', '/');

/**
 * True when `fragment` appears as a path prefix or as consecutive path segments inside `specifier`.
 */
export function specifierContainsPath(specifier: string, fragment: string): boolean {
	const spec = normalizePath(specifier);
	const frag = normalizePath(fragment).replace(/^\/+|\/+$/g, '');
	if (frag === '') return false;
	if (spec === frag) return true;
	if (spec.startsWith(`${frag}/`)) return true;
	if (spec.includes(`/${frag}/`)) return true;
	return spec.endsWith(`/${frag}`);
}

export function importsMatching(
	records: readonly ImportRecord[],
	fragments: readonly string[]
): readonly ImportRecord[] {
	return records.filter((record) =>
		fragments.some((fragment) => specifierContainsPath(record.specifier, fragment))
	);
}
