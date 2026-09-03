import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { registerFact, type FactContext } from './facts.js';
import {
	LANGUAGE_HEALTH_PROFILE,
	compileHealthProfile,
	matchesAny,
	type HealthProfile
} from './health-profile.js';
import type { Finding } from './index.js';
import { jsonRecord, readJsonObject, recordField } from './manifest.js';
import { loadPackDirectory } from './patterns-yaml.js';
import type { Rule } from './rules.js';
import { runRules } from './runner.js';

type Parsed = Readonly<{ file: string; source: string; sourceFile: ts.SourceFile }>;

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.svelte'];

function resolveRelative(
	from: string,
	specifier: string,
	known: ReadonlySet<string>
): string | undefined {
	if (!specifier.startsWith('.')) return undefined;
	const bare = specifier.split('?')[0] ?? specifier;
	const base = join(dirname(from), bare).split('\\').join('/');
	const stripped = base.replace(/\.(?:js|mjs|cjs|jsx)$/, '');
	const candidates = [
		base,
		...EXTENSIONS.map((extension) => `${stripped}${extension}`),
		...EXTENSIONS.map((extension) => `${stripped}/index${extension}`)
	];
	return candidates.find((candidate) => known.has(candidate));
}

const OUTPUT = /^(?:build|dist|lib|out)\//;

function sourceCandidates(target: string): ReadonlyArray<string> {
	const bare = target.replace(/^\.\//, '');
	const fromSource = bare.replace(OUTPUT, 'src/');
	const stripped = [bare, fromSource].map((candidate) =>
		candidate.replace(/\.(?:js|mjs|cjs|jsx)$/, '')
	);
	return [
		bare,
		fromSource,
		...stripped.flatMap((base) => EXTENSIONS.map((extension) => `${base}${extension}`)),
		...stripped.flatMap((base) => EXTENSIONS.map((extension) => `${base}/index${extension}`))
	];
}

function readManifest(absolute: string): Readonly<Record<string, unknown>> {
	if (!existsSync(absolute)) return {};
	return readJsonObject(readFileSync(absolute, 'utf8')) ?? {};
}

const packageRoots = new Map<string, string>();

function packageRootOf(root: string, file: string): string {
	const key = `${root}\0${file}`;
	const cached = packageRoots.get(key);
	if (cached !== undefined) return cached;
	let directory = dirname(file);
	for (;;) {
		if (existsSync(join(root, directory, 'package.json'))) break;
		const parent = dirname(directory);
		if (parent === directory || directory === '.') {
			directory = '.';
			break;
		}
		directory = parent;
	}
	packageRoots.set(key, directory);
	return directory;
}

function manifestsAbove(from: string): ReadonlyArray<string> {
	const found: Array<string> = [];
	let directory = dirname(from);
	for (;;) {
		const atRoot = directory === '' || directory === '.';
		found.push(atRoot ? 'package.json' : `${directory}/package.json`);
		if (atRoot) return found;
		directory = dirname(directory);
	}
}

function substitute(key: string, target: string, specifier: string): string | undefined {
	const star = key.indexOf('*');
	if (star === -1) return key === specifier ? target : undefined;
	const head = key.slice(0, star);
	const tail = key.slice(star + 1);
	if (!specifier.startsWith(head) || !specifier.endsWith(tail)) return undefined;
	return target.replace('*', specifier.slice(head.length, specifier.length - tail.length));
}

function firstKnown(base: string, target: string, known: ReadonlySet<string>): string | undefined {
	for (const candidate of sourceCandidates(target))
		if (known.has(`${base}${candidate}`)) return `${base}${candidate}`;
	return undefined;
}

function resolveSubpath(
	root: string,
	from: string,
	specifier: string,
	known: ReadonlySet<string>
): string | undefined {
	if (!specifier.startsWith('#')) return undefined;
	for (const manifest of manifestsAbove(from)) {
		const imports = readManifest(join(root, manifest))['imports'];
		if (imports === null || typeof imports !== 'object') continue;
		const directory = dirname(manifest);
		const base = directory === '' || directory === '.' ? '' : `${directory}/`;
		for (const [key, value] of Object.entries(imports)) {
			if (typeof value !== 'string') continue;
			const substituted = substitute(key, value, specifier);
			if (substituted === undefined) continue;
			const found = firstKnown(base, substituted, known);
			if (found !== undefined) return found;
		}
	}
	return undefined;
}

function specifiersOf(parsed: Parsed): ReadonlyArray<string> {
	const found: Array<string> = [];
	const visit = (node: ts.Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			found.push(node.moduleSpecifier.text);
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const [first] = node.arguments;
			if (first !== undefined && ts.isStringLiteral(first)) found.push(first.text);
		}
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'URL'
		) {
			const [first] = node.arguments ?? [];
			if (first !== undefined && ts.isStringLiteral(first)) found.push(first.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(parsed.sourceFile);
	return found;
}

function variableExports(
	statement: ts.VariableStatement
): ReadonlyArray<Readonly<{ name: string; node: ts.Node }>> {
	const found: Array<Readonly<{ name: string; node: ts.Node }>> = [];
	for (const declaration of statement.declarationList.declarations)
		if (ts.isIdentifier(declaration.name))
			found.push({ name: declaration.name.text, node: declaration });
	return found;
}

function exportsOf(parsed: Parsed): ReadonlyArray<Readonly<{ name: string; node: ts.Node }>> {
	const found: Array<{ name: string; node: ts.Node }> = [];
	for (const statement of parsed.sourceFile.statements) {
		const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
		if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
		if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
			found.push({ name: 'default', node: statement });
			continue;
		}
		if (ts.isVariableStatement(statement)) {
			found.push(...variableExports(statement));
			continue;
		}
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name !== undefined
		)
			found.push({ name: statement.name.text, node: statement });
	}
	return found;
}

function identifiersOf(parsed: Parsed): ReadonlySet<string> {
	const names = new Set<string>();
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) names.add(node.text);
		ts.forEachChild(node, visit);
	};
	visit(parsed.sourceFile);
	return names;
}

function declaredEntries(
	manifest: string,
	value: unknown,
	files: ReadonlySet<string>,
	roots: Set<string>
): void {
	if (typeof value === 'string' && value.startsWith('.')) {
		const resolved = resolveRelative(manifest, value, files);
		if (resolved !== undefined) roots.add(resolved);
		const source = value.replace(/^\.\/build\//, './src/').replace(/\.js$/, '.ts');
		const fromSource = resolveRelative(manifest, source, files);
		if (fromSource !== undefined) roots.add(fromSource);
		return;
	}
	const nested = Array.isArray(value) ? value : jsonRecord(value) ? Object.values(jsonRecord(value) ?? {}) : [];
	for (const entry of nested) declaredEntries(manifest, entry, files, roots);
}

function scriptEntries(
	manifest: string,
	scripts: Readonly<Record<string, unknown>>,
	files: ReadonlySet<string>,
	roots: Set<string>
): void {
	for (const command of Object.values(scripts)) {
		if (typeof command !== 'string') continue;
		for (const token of command.split(/[\s'"=]+/)) {
			if (!/\.[cm]?[jt]sx?$/.test(token) || token.startsWith('-')) continue;
			const named = token.startsWith('.') ? token : `./${token}`;
			const resolved = resolveRelative(manifest, named, files);
			if (resolved !== undefined) roots.add(resolved);
		}
	}
}

function entrypoints(
	root: string,
	files: ReadonlySet<string>,
	entries: ReadonlyArray<RegExp>
): ReadonlySet<string> {
	const roots = new Set<string>();
	const manifests = [...files].flatMap((file) => manifestsAbove(file)).concat('package.json');
	for (const manifest of new Set(manifests)) {
		const parsed = readManifest(join(root, manifest));
		for (const field of ['main', 'module', 'types', 'bin', 'exports'])
			declaredEntries(manifest, parsed[field], files, roots);
		scriptEntries(manifest, recordField(parsed, 'scripts'), files, roots);
	}
	for (const file of files) if (matchesAny(file, entries)) roots.add(file);
	return roots;
}

export type CrossFileOptions = Readonly<{
	readonly root: string;
	readonly files: ReadonlyArray<Parsed>;
	readonly consumers?: ReadonlyArray<Parsed> | undefined;
	readonly profile?: HealthProfile | undefined;
}>;

function siteKey(file: string, node: ts.Node, sourceFile: ts.SourceFile): string {
	return `${file}:${node.getStart(sourceFile)}`;
}

export type CrossFileIndex = Readonly<{
	readonly unreferencedModules: ReadonlySet<string>;
	readonly unreferencedExports: ReadonlySet<string>;
	readonly duplicateBodies: ReadonlySet<string>;
}>;

function bodyHash(node: ts.Node): string | undefined {
	const body =
		ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)
			? node.body
			: ts.isArrowFunction(node)
				? node.body
				: undefined;
	if (body === undefined) return undefined;
	const tokens: Array<string> = [];
	const visit = (current: ts.Node): void => {
		if (ts.isIdentifier(current)) tokens.push('#');
		else if (ts.isStringLiteralLike(current)) tokens.push(JSON.stringify(current.text));
		else if (ts.isNumericLiteral(current)) tokens.push(current.text);
		else tokens.push(String(current.kind));
		ts.forEachChild(current, visit);
	};
	visit(body);
	if (tokens.length < 40) return undefined;
	return createHash('sha256').update(tokens.join(',')).digest('hex');
}

/** Reachability, dead exports, and duplicate bodies over one repository. */
export function analyseCrossFile(options: CrossFileOptions): CrossFileIndex {
	const consumers = options.consumers ?? [];
	const corpus = [...options.files, ...consumers];
	const known = new Set(corpus.map((parsed) => parsed.file));

	const edges = new Map<string, Set<string>>();
	for (const parsed of corpus) {
		const targets = new Set<string>();
		for (const specifier of specifiersOf(parsed)) {
			const resolved =
				resolveRelative(parsed.file, specifier, known) ??
				resolveSubpath(options.root, parsed.file, specifier, known);
			if (resolved !== undefined) targets.add(resolved);
		}
		edges.set(parsed.file, targets);
	}

	const profile = compileHealthProfile(options.profile ?? LANGUAGE_HEALTH_PROFILE);
	const roots = new Set([
		...entrypoints(options.root, known, profile.frameworkEntries),
		...consumers.map((parsed) => parsed.file)
	]);
	const reachable = new Set<string>();
	const queue = [...roots];
	while (queue.length > 0) {
		const current = queue.pop()!;
		if (reachable.has(current)) continue;
		reachable.add(current);
		for (const target of edges.get(current) ?? []) queue.push(target);
	}

	const unreferencedModules = new Set<string>();
	for (const parsed of options.files) {
		if (!reachable.has(parsed.file)) unreferencedModules.add(parsed.file);
	}

	const mentionedElsewhere = new Map<string, Set<string>>();
	for (const parsed of corpus) {
		const names = identifiersOf(parsed);
		for (const name of names) {
			const holders = mentionedElsewhere.get(name) ?? new Set<string>();
			holders.add(parsed.file);
			mentionedElsewhere.set(name, holders);
		}
	}
	const unreferencedExports = new Set<string>();
	for (const parsed of options.files) {
		if (!reachable.has(parsed.file)) continue;
		if (roots.has(parsed.file)) continue;
		for (const exported of exportsOf(parsed)) {
			if (exported.name === 'default') continue;
			const holders = mentionedElsewhere.get(exported.name) ?? new Set<string>();
			const mentions = [...holders].filter((holder) => holder !== parsed.file);
			if (mentions.length > 0) continue;
			unreferencedExports.add(siteKey(parsed.file, exported.node, parsed.sourceFile));
		}
	}

	const bodies = new Map<string, Array<Readonly<{ parsed: Parsed; node: ts.Node }>>>();
	for (const parsed of options.files) {
		const visit = (node: ts.Node): void => {
			const hash = bodyHash(node);
			if (hash !== undefined) {
				const list = bodies.get(hash) ?? [];
				list.push({ parsed, node });
				bodies.set(hash, list);
			}
			ts.forEachChild(node, visit);
		};
		visit(parsed.sourceFile);
	}
	const duplicateBodies = new Set<string>();
	for (const [, group] of bodies) {
		if (group.length < 2) continue;
		const original = group[0]!;
		for (const duplicate of group.slice(1)) {
			if (
				packageRootOf(options.root, duplicate.parsed.file) !==
				packageRootOf(options.root, original.parsed.file)
			)
				continue;
			duplicateBodies.add(siteKey(duplicate.parsed.file, duplicate.node, duplicate.parsed.sourceFile));
		}
	}

	return { unreferencedModules, unreferencedExports, duplicateBodies };
}

const boundIndexes = new Map<string, CrossFileIndex>();

export function bindCrossFileIndex(root: string, index: CrossFileIndex): void {
	boundIndexes.set(root, index);
}

function indexFor(context: FactContext): CrossFileIndex {
	const index = boundIndexes.get(context.root);
	if (index === undefined)
		throw new Error(`norbital-doctor: repository fact "${context.file}" has no bound cross-file index`);
	return index;
}

registerFact({
	name: 'unreferencedModule',
	parameters: [],
	run: (context) => indexFor(context).unreferencedModules.has(context.file)
});

registerFact({
	name: 'unreferencedExport',
	parameters: [],
	run: (context) =>
		indexFor(context).unreferencedExports.has(siteKey(context.file, context.node, context.source))
});

registerFact({
	name: 'duplicateBody',
	parameters: [],
	run: (context) =>
		indexFor(context).duplicateBodies.has(siteKey(context.file, context.node, context.source))
});

const GRAPH_PACK = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs', 'graph');

let graphRules: ReadonlyArray<Rule> | undefined;

export function loadGraphRules(): ReadonlyArray<Rule> {
	graphRules ??= loadPackDirectory(GRAPH_PACK);
	return graphRules;
}

export function runCrossFile(options: CrossFileOptions): ReadonlyArray<Finding> {
	bindCrossFileIndex(options.root, analyseCrossFile(options));
	return runRules({
		root: options.root,
		rules: loadGraphRules(),
		files: options.files.map((parsed) => parsed.file)
	});
}
