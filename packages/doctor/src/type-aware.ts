/** The type-aware tier: the findings that need a resolved symbol rather than a syntax shape. */
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import ts from 'typescript';
import { ignoredRule } from '../engine/scripts/ignore.mjs';
import type { Finding } from './index.js';
import { PRINCIPLE_ORDER, type Principle } from './rules.js';

/** Extensions the compiler can put in a program. `.svelte` is deliberately absent. */
const PROGRAM_SOURCE = /\.(?:[mc]?tsx?|[mc]?jsx?)$/;

const LEGACY2: Readonly<{
	id: string;
	severity: Finding['severity'];
	confidence: Finding['confidence'];
	summary: string;
	principles: ReadonlyArray<Principle>;
}> = {
	id: 'LEGACY2',
	severity: 'error',
	confidence: 'high',
	summary: 'compiler-resolved deprecated API is still used',
	principles: ['simplicity', 'straightforwardness', 'modularity', 'no-bloat']
};

/** Whether a declaration carries `@deprecated`, wherever it was written. */
function deprecated(declaration: ts.Declaration): boolean {
	return ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'deprecated');
}

/** The identifier a reader would point at for a call: `name` in `a.b.name()`, `f` in `f()`. */
function callee(call: ts.CallExpression | ts.NewExpression): ts.Node {
	const target = call.expression;
	return ts.isPropertyAccessExpression(target) ? target.name : target;
}

/** The declarations a reference resolves to, following an import alias to its source. */
function resolvedDeclarations(
	checker: ts.TypeChecker,
	node: ts.Identifier
): ReadonlyArray<ts.Declaration> {
	const symbol = checker.getSymbolAtLocation(node);
	if (symbol === undefined) return [];
	const resolved =
		(symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
	return resolved.getDeclarations() ?? [];
}

/** The nearest `tsconfig.json`/`jsconfig.json` at or above a file, within the repository. */
function owningConfig(root: string, file: string): string | undefined {
	let directory = dirname(join(root, file));
	while (directory === root || directory.startsWith(`${root}${sep}`)) {
		for (const name of ['tsconfig.json', 'jsconfig.json']) {
			const candidate = join(directory, name);
			if (existsSync(candidate)) return candidate;
		}
		if (directory === root) break;
		directory = dirname(directory);
	}
	return undefined;
}

/** Compiler options for one program. */
function compilerOptions(configPath: string | undefined): ts.CompilerOptions {
	const defaults: ts.CompilerOptions = {
		noEmit: true,
		allowJs: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.Latest,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext
	};
	if (configPath === undefined) return defaults;
	const raw = ts.readConfigFile(configPath, ts.sys.readFile);
	if (raw.error !== undefined)
		throw new Error(
			`norbital-doctor: ${configPath} could not be read: ${ts.flattenDiagnosticMessageText(raw.error.messageText, ' ')}`
		);
	const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dirname(configPath));
	return { ...parsed.options, noEmit: true, allowJs: true, skipLibCheck: true };
}

type TypeAwareOptions = Readonly<{
	readonly root: string;
	/** Repository-relative files the scan selected. Non-program extensions are skipped. */
	readonly files: ReadonlyArray<string>;
}>;

/**
 * Build a program per owning configuration and report every use of a deprecated declaration. A call is judged by its
 * resolved signature (only one overload of `@sveltejs/kit`'s `error` is deprecated); a plain reference only when every
 * declaration behind it is.
 */
export function runTypeAware(options: TypeAwareOptions): ReadonlyArray<Finding> {
	const covered = options.files.filter((file) => PROGRAM_SOURCE.test(file));
	if (covered.length === 0) return [];

	const groups = new Map<string, Array<string>>();
	for (const file of covered) {
		const config = owningConfig(options.root, file) ?? '';
		const bucket = groups.get(config) ?? [];
		bucket.push(file);
		groups.set(config, bucket);
	}

	const findings: Array<Finding> = [];
	for (const [config, files] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
		const program = ts.createProgram({
			rootNames: files.map((file) => join(options.root, file)),
			options: compilerOptions(config === '' ? undefined : config)
		});
		const checker = program.getTypeChecker();

		for (const file of files) {
			if (ignoredRule(options.root, file, LEGACY2.id)) continue;
			const sourceFile = program.getSourceFile(join(options.root, file));
			if (sourceFile === undefined) continue;

			/** Callees already decided by signature, so the reference pass does not re-decide them. */
			const decided = new Set<ts.Node>();
			const seen = new Set<string>();
			const report = (node: ts.Node, evidence: string): void => {
				const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				const key = `${position.line}\0${evidence}`;
				if (seen.has(key)) return;
				seen.add(key);
				const line = sourceFile.text.split('\n')[position.line] ?? '';
				findings.push({
					severity: LEGACY2.severity,
					confidence: LEGACY2.confidence,
					rule: LEGACY2.id,
					summary: LEGACY2.summary,
					location: `${file}:${position.line + 1}: ${line.trim()} [${evidence}]`,
					principles: PRINCIPLE_ORDER.filter((principle) => LEGACY2.principles.includes(principle))
				});
			};
			const where = (declaration: ts.Declaration): string =>
				declaration.getSourceFile().fileName.replace(/^.*\/node_modules\//, '');

			const inspectCall = (node: ts.CallExpression | ts.NewExpression): void => {
				const declaration = checker.getResolvedSignature(node)?.getDeclaration();
				if (declaration === undefined || !deprecated(declaration)) return;
				const target = callee(node);
				decided.add(target);
				report(target, `symbol=${target.getText(sourceFile)} declared=${where(declaration)}`);
			};

			const inspectReference = (node: ts.Identifier): void => {
				if (decided.has(node)) return;
				const parent: ts.Node & { name?: ts.Node } = node.parent;
				if (parent?.name === node) return;
				const declarations = resolvedDeclarations(checker, node);
				if (declarations.length === 0 || !declarations.every(deprecated)) return;
				report(node, `symbol=${node.text} declared=${where(declarations[0]!)}`);
			};

			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) || ts.isNewExpression(node)) inspectCall(node);
				else if (ts.isIdentifier(node)) inspectReference(node);
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}
	}

	return findings.sort((left, right) => left.location.localeCompare(right.location));
}
