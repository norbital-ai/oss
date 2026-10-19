import { effectScope } from './effect-scope.js';
/** The type-aware tier: the findings that need a resolved symbol rather than a syntax shape. */
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import ts from 'typescript';
import { Predicate } from 'effect';
import { ignoredRule } from './ignore.js';
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

/** The compiler's object/reference flags discriminate its own Type graph. */
function typeReference(type: ts.Type): type is ts.TypeReference {
	return (
		(type.flags & ts.TypeFlags.Object) !== 0 &&
		'objectFlags' in type &&
		Predicate.isNumber(type.objectFlags) &&
		(type.objectFlags & ts.ObjectFlags.Reference) !== 0
	);
}

/** Follow type identity and generic provenance, without serializing recursive mapped payloads. */
function contextType(checker: ts.TypeChecker, type: ts.Type): boolean {
	const pending = [type];
	const seen = new Set<ts.Type>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		if (
			[current.aliasSymbol, current.getSymbol()].some(
				(symbol) => symbol !== undefined && /^\w*Ctx$/.test(symbol.getName())
			)
		)
			return true;
		if (current.isUnionOrIntersection()) pending.push(...current.types);
		pending.push(...(current.aliasTypeArguments ?? []), ...(current.getBaseTypes() ?? []));
		if (typeReference(current)) pending.push(current.target, ...checker.getTypeArguments(current));
		const constraint = current.getConstraint();
		if (constraint !== undefined) pending.push(constraint);
	}
	return false;
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
	readonly deprecated?: boolean;
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
			const checkDeprecated =
				options.deprecated !== false && !ignoredRule(options.root, file, LEGACY2.id);
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

			const reportEffect = (rule: string, node: ts.Node, summary: string): void => {
				if (!effectScope(options.root, file) || ignoredRule(options.root, file, rule)) return;
				const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				findings.push({
					severity: 'error',
					confidence: 'high',
					rule,
					summary,
					location: `${file}:${position.line + 1}: ${(sourceFile.text.split('\n')[position.line] ?? '').trim()}`,
					principles: ['straightforwardness', 'testability', 'type-safety']
				});
			};
			const effectChannels = (type: ts.Type): ReadonlyArray<readonly ts.Type[]> => {
				const pending = [type];
				const seen = new Set<ts.Type>();
				const channels: Array<readonly ts.Type[]> = [];
				while (pending.length > 0) {
					const current = pending.pop();
					if (current === undefined || seen.has(current)) continue;
					seen.add(current);
					if (current.isUnionOrIntersection()) pending.push(...current.types);
					// A differently named alias may reorder or fix parameters: use the actual Effect reference.
					if (current.getSymbol()?.getName() === 'Effect')
						channels.push(typeReference(current) ? checker.getTypeArguments(current) : []);
					else if (current.aliasSymbol?.getName() === 'Effect')
						channels.push(current.aliasTypeArguments ?? []);
				}
				return channels;
			};
			/** Assignment retains its value, and delegated execution may return another Effect as data. */
			const discardedEffect = (expression: ts.Expression, retained = false): boolean => {
				if (
					ts.isParenthesizedExpression(expression) ||
					ts.isAsExpression(expression) ||
					ts.isTypeAssertionExpression(expression) ||
					ts.isSatisfiesExpression(expression) ||
					ts.isNonNullExpression(expression)
				)
					return discardedEffect(expression.expression, retained);
				if (ts.isVoidExpression(expression)) return discardedEffect(expression.expression);
				if (ts.isYieldExpression(expression) && expression.asteriskToken !== undefined)
					return (
						expression.expression !== undefined && discardedEffect(expression.expression, true)
					);
				if (ts.isBinaryExpression(expression)) {
					const operator = expression.operatorToken.kind;
					if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment)
						return discardedEffect(expression.right, true);
					if (operator === ts.SyntaxKind.CommaToken)
						return discardedEffect(expression.left) || discardedEffect(expression.right, retained);
					if (
						operator === ts.SyntaxKind.AmpersandAmpersandToken ||
						operator === ts.SyntaxKind.BarBarToken ||
						operator === ts.SyntaxKind.QuestionQuestionToken
					)
						return (
							discardedEffect(expression.left, true) || discardedEffect(expression.right, retained)
						);
				}
				if (ts.isConditionalExpression(expression))
					return (
						discardedEffect(expression.condition, true) ||
						discardedEffect(expression.whenTrue, retained) ||
						discardedEffect(expression.whenFalse, retained)
					);
				return !retained && effectChannels(checker.getTypeAtLocation(expression)).length !== 0;
			};
			const ctxEffect = (node: ts.Node, seen = new Set<ts.Symbol>()): boolean => {
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					effectChannels(checker.getTypeAtLocation(node)).length !== 0
				) {
					const receiver = node.expression.expression;
					if (
						/^ctx(?:\.|$)/.test(receiver.getText(receiver.getSourceFile())) ||
						contextType(checker, checker.getTypeAtLocation(receiver))
					)
						return true;
				}
				if (ts.isIdentifier(node)) {
					const symbol = checker.getSymbolAtLocation(node);
					const resolved =
						symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
							? checker.getAliasedSymbol(symbol)
							: symbol;
					if (resolved !== undefined && !seen.has(resolved)) {
						seen.add(resolved);
						for (const declaration of resolved.getDeclarations() ?? []) {
							if (
								!declaration.getSourceFile().fileName.startsWith(`${options.root}/`) ||
								declaration.getSourceFile().fileName.includes('/node_modules/')
							)
								continue;
							if (
								ts.isVariableDeclaration(declaration) &&
								declaration.initializer !== undefined &&
								ctxEffect(declaration.initializer, seen)
							)
								return true;
							if (
								ts.isFunctionDeclaration(declaration) &&
								declaration.body !== undefined &&
								ctxEffect(declaration.body, seen)
							)
								return true;
						}
					}
				}
				let found = false;
				ts.forEachChild(node, (child) => {
					if (ctxEffect(child, seen)) found = true;
				});
				return found;
			};

			const inspectEffect = (node: ts.Node): void => {
				if (ts.isExpressionStatement(node) && discardedEffect(node.expression))
					reportEffect('EFF9', node, 'floating Effect is never executed');
				if (!ts.isCallExpression(node)) return;
				const channels = effectChannels(checker.getTypeAtLocation(node));
				if (
					channels.some(
						(args) => args[1] !== undefined && (args[1].flags & ts.TypeFlags.Unknown) !== 0
					)
				)
					reportEffect('EFF11', node, 'Effect error channel inferred as unknown');
				if (
					channels.length === 0 ||
					!ts.isPropertyAccessExpression(node.expression) ||
					!['all', 'forEach'].includes(node.expression.name.text)
				)
					return;
				if (!node.arguments.some((argument) => ctxEffect(argument))) return;
				const options = node.arguments.at(-1);
				const concurrent =
					options !== undefined &&
					ts.isObjectLiteralExpression(options) &&
					options.properties.some(
						(property) => property.name?.getText(sourceFile) === 'concurrency'
					);
				if (!concurrent) reportEffect('EFF10', node, 'guest ctx batch needs explicit concurrency');
			};
			const visit = (node: ts.Node): void => {
				inspectEffect(node);
				if (checkDeprecated && (ts.isCallExpression(node) || ts.isNewExpression(node)))
					inspectCall(node);
				else if (checkDeprecated && ts.isIdentifier(node)) inspectReference(node);
				ts.forEachChild(node, visit);
			};
			visit(sourceFile);
		}
	}

	return findings.sort((left, right) => left.location.localeCompare(right.location));
}
