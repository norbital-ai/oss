/**
 * Module-path facts the matcher can ask about: does this specifier name the current file,
 * does a declared path alias already cover this relative import, and does this file import a
 * package?
 *
 * These are host facts, not pack rules. YAML states the claim with `selfModule` / `aliasCovered`
 * / `importsFrom`; this module answers them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { readJsonObject, recordField, stringField } from './manifest.js';

const aliasCache = new Map<string, ReadonlyArray<Readonly<{ prefix: string; target: string }>>>();

function stripJsonComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');
}

type RecordAlias = (prefix: string, target: string, base: string) => void;

function tsconfigAliases(root: string, directory: string, name: string, record: RecordAlias): void {
	const file = join(root, directory === '.' ? name : `${directory}/${name}`);
	if (!existsSync(file)) return;
	const parsed = readJsonObject(stripJsonComments(readFileSync(file, 'utf8')));
	if (parsed === undefined) return;
	const compilerOptions = recordField(parsed, 'compilerOptions');
	const base = join(directory, stringField(compilerOptions, 'baseUrl') ?? '.');
	for (const [prefix, targets] of Object.entries(recordField(compilerOptions, 'paths')))
		for (const target of Array.isArray(targets) ? targets : [])
			if (typeof target === 'string') record(prefix, target, base);
}

function manifestAliases(root: string, directory: string, record: RecordAlias): void {
	const file = join(root, directory === '.' ? 'package.json' : `${directory}/package.json`);
	if (!existsSync(file)) return;
	const parsed = readJsonObject(readFileSync(file, 'utf8'));
	if (parsed === undefined) return;
	for (const [prefix, target] of Object.entries(recordField(parsed, 'imports')))
		if (typeof target === 'string') record(prefix, target, directory);
}

function aliasesFor(
	root: string,
	directory: string
): ReadonlyArray<Readonly<{ prefix: string; target: string }>> {
	const key = `${root}\u0000${directory}`;
	const cached = aliasCache.get(key);
	if (cached !== undefined) return cached;
	const found: Array<Readonly<{ prefix: string; target: string }>> = [];
	const record: RecordAlias = (prefix, target, base) => {
		const absolute = resolve(root, base, target.replace(/^\.\//, '').replace(/\*.*$/, ''));
		found.push({
			prefix: prefix.replace(/\*.*$/, ''),
			target: relative(root, absolute).split('\\').join('/')
		});
	};
	for (const name of ['tsconfig.json', 'jsconfig.json'])
		tsconfigAliases(root, directory, name, record);
	manifestAliases(root, directory, record);
	aliasCache.set(key, found);
	return found;
}

const withoutModuleExtension = (path: string): string => path.replace(/\.(?:[cm]?[jt]sx?)$/, '');

/** The alias prefix that already covers a deep relative import, if a repository declares one. */
export function aliasCovering(root: string, file: string, specifier: string): string | undefined {
	const target = join(dirname(file), specifier)
		.split('\\')
		.join('/')
		.replace(/\.[cm]?[jt]sx?$/, '');
	for (let directory = dirname(file); ; directory = dirname(directory)) {
		for (const alias of aliasesFor(root, directory))
			if (alias.target !== '' && target.startsWith(`${alias.target}/`)) return alias.prefix;
		if (directory === '.' || directory === '' || directory === '/') return undefined;
	}
}

/** Whether a relative specifier resolves to the file that contains it. */
export function resolvesToDeclaringModule(file: string, root: string, specifier: string): boolean {
	if (!specifier.startsWith('.')) return false;
	const current = withoutModuleExtension(resolve(root, file));
	const target = withoutModuleExtension(resolve(root, dirname(file), specifier));
	return current === target || current === join(target, 'index');
}

const importedSpecifiers = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Specifiers on static `import` declarations in this file, the same set `importsFrom` uses. */
function specifiersImportedBy(source: ts.SourceFile): ReadonlySet<string> {
	const cached = importedSpecifiers.get(source);
	if (cached !== undefined) return cached;
	const found = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
			continue;
		found.add(statement.moduleSpecifier.text);
	}
	importedSpecifiers.set(source, found);
	return found;
}

/** True when the file imports `specifier` or a subpath of it. */
export function sourceImportsFrom(source: ts.SourceFile, specifier: string): boolean {
	for (const key of specifiersImportedBy(source))
		if (key === specifier || key.startsWith(`${specifier}/`)) return true;
	return false;
}

/** The string module specifier on an import, export, `import()`, or `require()`. */
export function moduleSpecifierOf(node: ts.Node): string | undefined {
	if (
		(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
		node.moduleSpecifier !== undefined &&
		ts.isStringLiteral(node.moduleSpecifier)
	)
		return node.moduleSpecifier.text;
	if (
		ts.isImportEqualsDeclaration(node) &&
		ts.isExternalModuleReference(node.moduleReference) &&
		node.moduleReference.expression !== undefined &&
		ts.isStringLiteral(node.moduleReference.expression)
	)
		return node.moduleReference.expression.text;
	if (
		ts.isCallExpression(node) &&
		node.arguments.length === 1 &&
		ts.isStringLiteral(node.arguments[0]!)
	) {
		if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return node.arguments[0].text;
		if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
			return node.arguments[0].text;
	}
	return undefined;
}
