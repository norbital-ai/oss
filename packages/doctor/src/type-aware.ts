/**
 * The type-aware tier: the findings that need a resolved symbol rather than a syntax shape.
 *
 * It is always on. A rule only a checker can decide is not optional evidence, and a receipt that
 * says `typeAware: false` leaves its reader to guess what was never looked at. One `ts.Program` is
 * built per owning `tsconfig.json`, over exactly the files the scan already selected, so the tier's
 * scope and the receipt's file count describe one set rather than two.
 *
 * Scope is TypeScript and JavaScript. The compiler cannot parse `.svelte`, so a component's script
 * reaches the syntactic and graph tiers but not this one. That is stated here, and in the receipt
 * documentation, because a `true` tier flag must not imply coverage the tier does not have.
 */
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
	// The same four `LEGACY1` carries: a deprecated API and a deprecated declaration are one debt
	// seen from either end.
	principles: ['simplicity', 'straightforwardness', 'modularity', 'no-bloat']
};

/** Whether a declaration carries `@deprecated`, wherever it was written. */
function deprecated(declaration: ts.Declaration): boolean {
	return ts.getJSDocTags(declaration).some((tag) => tag.tagName.text === 'deprecated');
}

/**
 * The identifier a reader would point at for a call: `name` in `a.b.name()`, `f` in `f()`.
 *
 * Reporting the whole call expression would put the location at the start of a chain that may be
 * several lines above the deprecated member.
 */
function callee(call: ts.CallExpression | ts.NewExpression): ts.Node {
	const target = call.expression;
	return ts.isPropertyAccessExpression(target) ? target.name : target;
}

/**
 * The declarations a reference resolves to, following an import alias to its source.
 *
 * A local `import { x }` binding has one declaration — the import itself — which never carries the
 * tag. The tag is on whatever the alias points at.
 */
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

/**
 * Compiler options for one program.
 *
 * A configuration that cannot be read is unusable evidence, not a reason to fall back to defaults
 * and scan on: the resulting program would resolve nothing and report nothing, which is
 * indistinguishable from a clean repository.
 */
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

export type TypeAwareRun = Readonly<{
	/** Whether the tier ran. False only when the selection holds no file a program can contain. */
	readonly ran: boolean;
	/** How many programs were built — one per owning configuration. */
	readonly programs: number;
	/** Files the tier actually covered, which excludes `.svelte`. */
	readonly files: number;
	readonly findings: ReadonlyArray<Finding>;
}>;

/**
 * Build a program per owning configuration and report every use of a deprecated declaration.
 *
 * Deciding this needs the checker twice over. The declaration is usually in someone else's `.d.ts`,
 * so no syntactic rule can see the `@deprecated` tag at all; and a symbol is not the unit of
 * deprecation. `@sveltejs/kit`'s `error` carries three overloads and only the third is deprecated,
 * so a symbol-level check reports every `error(...)` call in the realm — six of them in the website
 * alone, each a confident finding at a real line, and every one wrong. The resolved *signature* is
 * what was actually called, so that is what is checked.
 *
 * A plain reference — a type, an imported name, a property read — has no signature to resolve. It
 * reports only when *every* declaration behind it is deprecated, which is the same rule stated for
 * a symbol whose overload set is not split.
 */
export function runTypeAware(options: TypeAwareOptions): TypeAwareRun {
	const covered = options.files.filter((file) => PROGRAM_SOURCE.test(file));
	if (covered.length === 0) return { ran: false, programs: 0, files: 0, findings: [] };

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
				// The name in `function f()` or `const f = …` is the declaration, not a use of it.
				// `LEGACY1` is the rule about declaring something deprecated.
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

	return {
		ran: true,
		programs: groups.size,
		files: covered.length,
		findings: findings.sort((left, right) => left.location.localeCompare(right.location))
	};
}
