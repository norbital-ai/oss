/** The TypeScript role modules the Bolt compiler places in its guest entry, and their runtime imports. */
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { memoised, type FactContext } from './facts.js';
import { decodeJsonObject, stringField } from './manifest.js';

// decl/layout.ts ROLES; check/index.ts bundles every discovered .ts role, not only attached bodies.
const ROLES = [
	/^src\/\+(?:workspace|secrets)\.ts$/,
	/^src\/data\/model\/[^/]+\/\+model\.ts$/,
	/^src\/data\/custom_field\/[^/]+\/\+definition\.ts$/,
	/^src\/integration\/[^/]+\/\+integration\.ts$/,
	/^src\/access_control\/policy\/\+[^/]+\.policy\.ts$/,
	/^src\/access_control\/team\/\+team\.ts$/,
	/^src\/agent\/envoy\/\+[^/]+\.envoy\.ts$/,
	/^src\/agent\/mcp\/\+[^/]+\.mcp\.ts$/,
	/^src\/automation\/\+[^/]+\.automation\.ts$/,
	/^src\/app\/.+\/\+(?:app|group)\.ts$/,
	/^src\/kiosk\/[^/]+\/\+kiosk\.ts$/,
	/^src\/i18n\/\+(?:[^/]+\.)?messages\.ts$/
];
const ROLE_DIRECTORIES = [
	'data',
	'integration',
	'access_control',
	'agent/envoy',
	'agent/mcp',
	'automation',
	'app',
	'kiosk',
	'i18n'
];
const SCRIPT = /\.[cm]?[jt]sx?$/;
const ASSET = /[?&](?:bytes|raw|url|worker|sharedworker)(?:&|$)/;
const portable = (file: string) => file.replace(/\\/g, '/');

function sourceRoot(root: string, file: string): string | undefined {
	let found: string | undefined;
	for (let directory = dirname(file); ; directory = dirname(directory)) {
		const candidate = join(directory, 'src');
		if (found === undefined) {
			if (basename(directory) === 'src') found = directory;
			else if (ts.sys.directoryExists(candidate)) found = candidate;
		}
		if (
			ts.sys.directoryExists(candidate) &&
			(existsSync(join(directory, 'package.json')) || existsSync(join(directory, 'tsconfig.json')))
		)
			return candidate;
		if (directory === root || dirname(directory) === directory) return found;
	}
}

function rootsOf(src: string): readonly string[] {
	const workspace = dirname(src),
		roots: string[] = [];
	const walk = (directory: string): void => {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			// Compiler discovery never creates a role root from hidden directories or installed modules.
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			const file = join(directory, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (
				entry.isFile() &&
				ROLES.some((role) => role.test(portable(relative(workspace, file))))
			)
				roots.push(file);
		}
	};
	for (const name of ['+workspace.ts', '+secrets.ts']) {
		const file = join(src, name);
		if (existsSync(file)) roots.push(file);
	}
	for (const directory of ROLE_DIRECTORIES) walk(join(src, directory));
	const manifest = ts.sys.readFile(join(workspace, 'package.json'));
	if (
		manifest !== undefined &&
		stringField(decodeJsonObject(manifest) ?? {}, 'name') === '@norbital-ai/bolt'
	) {
		// check/index.ts aliases the public declaration entry and installs this runtime before generator modules.
		for (const file of ['index.ts', 'decl/runtime/guest.ts'])
			if (existsSync(join(src, file))) roots.push(join(src, file));
	}
	return roots;
}

function runtimeImports(source: ts.SourceFile): readonly string[] {
	const imports: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isTypeNode(node)) return;
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			if (clause?.isTypeOnly) return;
			if (
				clause?.name === undefined &&
				clause?.namedBindings !== undefined &&
				ts.isNamedImports(clause.namedBindings) &&
				clause.namedBindings.elements.length > 0 &&
				clause.namedBindings.elements.every((binding) => binding.isTypeOnly)
			)
				return;
			if (ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
			return;
		}
		if (ts.isExportDeclaration(node)) {
			if (node.isTypeOnly) return;
			if (
				node.exportClause !== undefined &&
				ts.isNamedExports(node.exportClause) &&
				node.exportClause.elements.length > 0 &&
				node.exportClause.elements.every((binding) => binding.isTypeOnly)
			)
				return;
			if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
				imports.push(node.moduleSpecifier.text);
			return;
		}
		if (ts.isImportEqualsDeclaration(node)) {
			if (
				!node.isTypeOnly &&
				ts.isExternalModuleReference(node.moduleReference) &&
				node.moduleReference.expression !== undefined &&
				ts.isStringLiteral(node.moduleReference.expression)
			)
				imports.push(node.moduleReference.expression.text);
			return;
		}
		if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === 'require'))
		) {
			const first = node.arguments[0];
			if (first !== undefined && ts.isStringLiteral(first)) imports.push(first.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return imports;
}

function reachable({ root, file }: FactContext): boolean {
	const target = resolve(root, file),
		src = sourceRoot(resolve(root), target);
	if (src === undefined || !SCRIPT.test(target) || /\.d\.[cm]?ts$/.test(target)) return false;
	const pending = [...rootsOf(src)];
	if (pending.includes(target)) return true;
	if (pending.length === 0) return false;
	const workspace = dirname(src),
		config = join(workspace, 'tsconfig.json');
	const options: ts.CompilerOptions = existsSync(config)
		? ts.parseJsonSourceFileConfigFileContent(
				ts.readJsonConfigFile(config, ts.sys.readFile),
				ts.sys,
				workspace
			).options
		: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
	const cache = ts.createModuleResolutionCache(workspace, (path) => path, options);
	const seen = new Set<string>();
	for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
		if (seen.has(current)) continue;
		seen.add(current);
		if (current === target) return true;
		const text = ts.sys.readFile(current);
		if (text === undefined) continue;
		const parsed = ts.createSourceFile(current, text, ts.ScriptTarget.Latest, true);
		for (const specifier of runtimeImports(parsed)) {
			if (ASSET.test(specifier)) continue;
			const module = ts.resolveModuleName(
				specifier.split('?')[0] ?? specifier,
				current,
				options,
				ts.sys,
				cache
			).resolvedModule;
			if (
				module !== undefined &&
				SCRIPT.test(module.resolvedFileName) &&
				!/\.d\.[cm]?ts$/.test(module.resolvedFileName)
			)
				pending.push(resolve(module.resolvedFileName));
		}
	}
	return false;
}

/** Memoise on this run's parsed source, so a later doctor call observes edited roots and imports. */
export const guestReachable = (context: FactContext): boolean =>
	memoised(context.source, 'guestReachable', () => reachable(context));
