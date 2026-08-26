// repository-health:allow SEM_PARALLEL -- different analysis modules sharing the analyzer vocabulary; related by family, not duplication.
/**
 * Per-function structure: cyclomatic complexity, nesting, pass-through shape, and inline
 * candidates, plus the AST walk that feeds every downstream metric, ported from `analyze.mjs`.
 *
 * Complexity counts branch points in one body and stops at nested function boundaries — nested
 * functions are measured independently rather than inflating their owner. An inline candidate must
 * be private, named once, and called exactly once from the same file, and be either an
 * unchanged-parameter forwarder or a small single expression; exported functions, callbacks used
 * as values, recursion, branching, async/generator/generic boundaries, and mutation are all
 * excluded mechanically, because candidates are review evidence rather than rewrites.
 */
import ts from 'typescript';
import {
	classPathway,
	containingClass,
	declarationName,
	duplicateCallableKind,
	duplicateCallableName,
	className,
	overlapProfile,
	pathwayHash
} from './entities.js';
import type { PathwayEntityCore } from './entities.js';
import type { FunctionMetric } from './structure.js';
import { analyzableSource } from './inventory.js';

/** One import edge with whether it carries values or only types. */
export type ImportEdge = Readonly<{ specifier: string; typeOnly: boolean }>;

/** The per-file AST summary every consumer reads. */
export type AstSummary = Readonly<{
	imports: ReadonlyArray<ImportEdge>;
	functions: Array<FunctionMetric>;
	namedFunctions: number;
	namedPassThroughFunctions: number;
	inlineCandidates: Array<{
		name: string;
		line: number;
		useLine: number;
		kind: 'transparent-forwarder' | 'single-use-expression';
		confidence: 'high' | 'review';
		forwardsTo?: string;
		tokens: number;
	}>;
	localNamedCalls: number;
	duplicateEntities: Array<PathwayEntityCore>;
	services: Array<string>;
}>;

/** Count branch points and maximum control nesting in one function body. */
export function complexityOf(body: ts.Node): { cyclomatic: number; nesting: number } {
	let cyclomatic = 1;
	let maximumNesting = 0;
	const visit = (node: ts.Node, nesting: number): void => {
		if (
			node !== body &&
			(ts.isFunctionDeclaration(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isArrowFunction(node) ||
				ts.isFunctionExpression(node) ||
				ts.isConstructorDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node))
		)
			return;
		const control =
			ts.isIfStatement(node) ||
			ts.isForStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isForOfStatement(node) ||
			ts.isWhileStatement(node) ||
			ts.isDoStatement(node) ||
			ts.isCaseClause(node) ||
			ts.isCatchClause(node) ||
			ts.isConditionalExpression(node);
		if (control) cyclomatic += 1;
		if (ts.isBinaryExpression(node) && ['&&', '||', '??'].includes(node.operatorToken.getText()))
			cyclomatic += 1;
		const next = nesting + (control ? 1 : 0);
		maximumNesting = Math.max(maximumNesting, next);
		ts.forEachChild(node, (child) => visit(child, next));
	};
	visit(body, 0);
	return { cyclomatic, nesting: maximumNesting };
}

/** Class-level complexity from member bodies only; an empty class stays at the floor. */
function directClassComplexity(
	node: ts.ClassDeclaration | ts.ClassExpression
): { cyclomatic: number; nesting: number } {
	const metrics = node.members
		.map((member) => (member as { body?: ts.Node }).body)
		.filter((body): body is ts.Node => body !== undefined)
		.map((body) => complexityOf(body));
	return {
		cyclomatic: Math.max(1, ...metrics.map(({ cyclomatic }) => cyclomatic)),
		nesting: Math.max(0, ...metrics.map(({ nesting }) => nesting))
	};
}

/** Identify a wrapper whose entire behavior is forwarding one call. */
export function isPassThrough(body: ts.Node): boolean {
	if (!ts.isBlock(body))
		return (
			ts.isCallExpression(body) ||
			(ts.isAwaitExpression(body) && ts.isCallExpression(body.expression))
		);
	if (body.statements.length !== 1) return false;
	const statement = body.statements[0];
	if (!statement) return false;
	if (ts.isReturnStatement(statement) && statement.expression) {
		const expression = ts.isAwaitExpression(statement.expression)
			? statement.expression.expression
			: statement.expression;
		return ts.isCallExpression(expression);
	}
	if (ts.isExpressionStatement(statement)) {
		const expression = ts.isAwaitExpression(statement.expression)
			? statement.expression.expression
			: statement.expression;
		return ts.isCallExpression(expression);
	}
	return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	const modifiers = (node as { modifiers?: ReadonlyArray<ts.Modifier> }).modifiers;
	return modifiers?.some((modifier) => modifier.kind === kind) === true;
}

/** A top-level named function: its value node, name, name node, and body. */
type TopLevelFunction = {
	node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
	name: string;
	nameNode: ts.Identifier;
	body: ts.Node;
};

function topLevelFunctionCandidate(node: ts.Node): TopLevelFunction | null {
	if (ts.isFunctionDeclaration(node) && node.name && node.body && ts.isSourceFile(node.parent)) {
		return { node, name: node.name.text, nameNode: node.name, body: node.body };
	}
	if (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		node.initializer &&
		(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
		ts.isVariableDeclarationList(node.parent) &&
		ts.isVariableStatement(node.parent.parent) &&
		ts.isSourceFile(node.parent.parent.parent)
	) {
		return {
			node: node.initializer,
			name: node.name.text,
			nameNode: node.name,
			body: node.initializer.body
		};
	}
	return null;
}

function isExportedTopLevelFunction(candidate: TopLevelFunction): boolean {
	const declaration = candidate.nameNode.parent;
	if (ts.isFunctionDeclaration(declaration))
		return (
			hasModifier(declaration, ts.SyntaxKind.ExportKeyword) ||
			hasModifier(declaration, ts.SyntaxKind.DefaultKeyword)
		);
	const statement = declaration.parent?.parent;
	return ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function directReturnedExpression(body: ts.Node): ts.Node | null {
	if (!ts.isBlock(body)) return body;
	if (body.statements.length !== 1) return null;
	const statement = body.statements[0];
	if (!statement) return null;
	return ts.isReturnStatement(statement) && statement.expression ? statement.expression : null;
}

function transparentForwardedCall(candidate: TopLevelFunction): string | null {
	if (hasModifier(candidate.node, ts.SyntaxKind.AsyncKeyword)) return null;
	if ((candidate.node as { asteriskToken?: unknown }).asteriskToken) return null;
	const parameters = candidate.node.parameters.map((parameter) =>
		ts.isIdentifier(parameter.name) && !parameter.initializer && !parameter.dotDotDotToken
			? parameter.name.text
			: null
	);
	if (parameters.some((name) => name === null)) return null;
	const returned = directReturnedExpression(candidate.body);
	const call = returned && ts.isCallExpression(returned) ? returned : null;
	if (!call || call.arguments.length !== parameters.length) return null;
	if (
		!call.arguments.every(
			(argument, index) => ts.isIdentifier(argument) && argument.text === parameters[index]
		)
	)
		return null;
	return call.expression.getText(candidate.nameNode.getSourceFile());
}

function tokenCount(text: string): number {
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
	let count = 0;
	for (
		let token = scanner.scan();
		token !== ts.SyntaxKind.EndOfFileToken;
		token = scanner.scan()
	)
		count += 1;
	return count;
}

function isValueIdentifier(node: ts.Identifier): boolean {
	const parent = node.parent;
	if (!parent) return false;
	if (
		(ts.isFunctionDeclaration(parent) ||
			ts.isFunctionExpression(parent) ||
			ts.isClassDeclaration(parent) ||
			ts.isClassExpression(parent) ||
			ts.isMethodDeclaration(parent) ||
			ts.isPropertyDeclaration(parent) ||
			ts.isVariableDeclaration(parent) ||
			ts.isParameter(parent) ||
			ts.isTypeAliasDeclaration(parent) ||
			ts.isInterfaceDeclaration(parent)) &&
		parent.name === node
	)
		return false;
	if (
		ts.isImportSpecifier(parent) ||
		ts.isImportClause(parent) ||
		ts.isNamespaceImport(parent) ||
		ts.isExportSpecifier(parent) ||
		ts.isTypeReferenceNode(parent) ||
		ts.isQualifiedName(parent) ||
		ts.isLiteralTypeNode(parent) ||
		(ts.isPropertyAccessExpression(parent) && parent.name === node) ||
		((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node)
	)
		return false;
	return true;
}

function safeSingleExpression(candidate: TopLevelFunction): ts.Node | null {
	if (hasModifier(candidate.node, ts.SyntaxKind.AsyncKeyword)) return null;
	if (
		(candidate.node as { asteriskToken?: unknown }).asteriskToken ||
		(candidate.node as { typeParameters?: ReadonlyArray<unknown> }).typeParameters?.length
	)
		return null;
	if (
		candidate.node.parameters.some(
			(parameter) =>
				!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken
		)
	)
		return null;
	const expression = directReturnedExpression(candidate.body);
	if (!expression || tokenCount(expression.getText(candidate.nameNode.getSourceFile())) > 24)
		return null;
	let unsafe = false;
	const visit = (node: ts.Node): void => {
		if (
			node.kind === ts.SyntaxKind.ThisKeyword ||
			node.kind === ts.SyntaxKind.SuperKeyword ||
			ts.isAwaitExpression(node) ||
			ts.isYieldExpression(node) ||
			ts.isConditionalExpression(node) ||
			ts.isFunctionLike(node) ||
			ts.isClassExpression(node) ||
			(ts.isBinaryExpression(node) &&
				node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
				node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
			(ts.isPrefixUnaryExpression(node) &&
				[ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
			ts.isPostfixUnaryExpression(node)
		) {
			unsafe = true;
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(expression);
	return unsafe ? null : expression;
}

/** Find only mechanically inlineable same-file one-use functions; larger abstractions stay inventory. */
function inlineEvidence(
	file: ts.SourceFile,
	candidates: ReadonlyArray<TopLevelFunction>
): { inlineCandidates: AstSummary['inlineCandidates']; localCalls: number } {
	const counts = new Map<string, number>();
	for (const candidate of candidates)
		counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
	const references = new Map<string, Array<ts.Identifier>>(
		candidates.map(({ name }) => [name, []])
	);
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && references.has(node.text) && isValueIdentifier(node))
			references.get(node.text)?.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const localCalls = [...references.values()].reduce(
		(total, uses) =>
			total +
			uses.filter((use) => ts.isCallExpression(use.parent) && use.parent.expression === use).length,
		0
	);
	const inlineCandidates: AstSummary['inlineCandidates'] = [];
	for (const candidate of candidates) {
		if (counts.get(candidate.name) !== 1 || isExportedTopLevelFunction(candidate)) continue;
		const uses = references.get(candidate.name) ?? [];
		const externalUses = uses.filter(
			(use) => use.getStart(file) < candidate.node.getStart(file) || use.end > candidate.node.end
		);
		if (
			externalUses.length !== 1 ||
			!externalUses[0] ||
			!ts.isCallExpression(externalUses[0].parent) ||
			externalUses[0].parent.expression !== externalUses[0]
		)
			continue;
		const forwardedTo = transparentForwardedCall(candidate);
		const expression = forwardedTo ? null : safeSingleExpression(candidate);
		if (!forwardedTo && !expression) continue;
		inlineCandidates.push({
			name: candidate.name,
			line: file.getLineAndCharacterOfPosition(candidate.nameNode.getStart(file)).line + 1,
			useLine: file.getLineAndCharacterOfPosition(externalUses[0].getStart(file)).line + 1,
			kind: forwardedTo ? 'transparent-forwarder' : 'single-use-expression',
			confidence: forwardedTo ? 'high' : 'review',
			...(forwardedTo ? { forwardsTo: forwardedTo } : {}),
			tokens: tokenCount(candidate.body.getText(file))
		});
	}
	return { inlineCandidates, localCalls };
}

/** Extract imports, functions, and Effect-style service ownership from the compiler AST. */
export function analyzeAst(path: string, source: string): AstSummary {
	const scriptKind = path.endsWith('.tsx')
		? ts.ScriptKind.TSX
		: path.endsWith('.jsx')
			? ts.ScriptKind.JSX
			: path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
	const file = ts.createSourceFile(
		path,
		analyzableSource(path, source),
		ts.ScriptTarget.Latest,
		true,
		scriptKind
	);
	const imports: Array<ImportEdge> = [];
	const functions: Array<FunctionMetric> = [];
	const duplicateEntities: Array<PathwayEntityCore> = [];
	const services: Array<string> = [];
	const topLevelFunctions: Array<TopLevelFunction> = [];
	const visit = (node: ts.Node): void => {
		const topLevel = topLevelFunctionCandidate(node);
		if (topLevel) topLevelFunctions.push(topLevel);
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
			imports.push({
				specifier: node.moduleSpecifier.text,
				typeOnly:
					node.importClause?.isTypeOnly === true ||
					(node.importClause?.name === undefined &&
						node.importClause?.namedBindings !== undefined &&
						ts.isNamedImports(node.importClause.namedBindings) &&
						node.importClause.namedBindings.elements.every((item) => item.isTypeOnly))
			});
		if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		)
			imports.push({
				specifier: node.moduleSpecifier.text,
				typeOnly:
					node.isTypeOnly ||
					(node.exportClause !== undefined &&
						ts.isNamedExports(node.exportClause) &&
						node.exportClause.elements.every((item) => item.isTypeOnly))
			});
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0] as ts.Node)
		)
			imports.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, typeOnly: false });
		if (
			ts.isCallExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'require' &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0] as ts.Node)
		)
			imports.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, typeOnly: false });
		if (
			ts.isNewExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === 'URL' &&
			node.arguments?.length === 2 &&
			ts.isStringLiteral(node.arguments[0] as ts.Node) &&
			node.arguments[1]?.getText(file) === 'import.meta.url'
		)
			imports.push({
				specifier: (node.arguments[0] as ts.StringLiteral).text,
				typeOnly: false
			});
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isMethodDeclaration(node) ||
				ts.isConstructorDeclaration(node) ||
				ts.isGetAccessorDeclaration(node) ||
				ts.isSetAccessorDeclaration(node) ||
				ts.isArrowFunction(node) ||
				ts.isFunctionExpression(node)) &&
			node.body
		) {
			const body: ts.Node = node.body;
			const metrics = complexityOf(body);
			functions.push({
				name: declarationName(node),
				line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
				...metrics,
				passThrough: isPassThrough(body)
			});
			const kind = duplicateCallableKind(node);
			const pathway = kind ? pathwayHash(body.getText(file)) : undefined;
			if (pathway) {
				const owner = containingClass(node);
				duplicateEntities.push({
					name: duplicateCallableName(node, file),
					kind: kind ?? 'method',
					ownerClassId: owner ? `${path}:${owner.getStart(file)}` : null,
					line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
					...metrics,
					passThrough: isPassThrough(body),
					...pathway,
					...(overlapProfile(body) ?? {})
				});
			}
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
			const pathway = classPathway(node, file);
			if (pathway) {
				duplicateEntities.push({
					name: className(node, file),
					kind: 'class',
					ownerClassId: `${path}:${node.getStart(file)}`,
					line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
					...directClassComplexity(node),
					passThrough: false,
					...pathway
				});
			}
		}
		if (
			ts.isClassDeclaration(node) &&
			node.name &&
			node.heritageClauses?.some((clause) =>
				clause.getText(file).match(/(?:Effect|Context|ServiceMap)\.Service/)
			)
		)
			services.push(node.name.text);
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			/(?:Context|ServiceMap)\.(?:(?:Generic)?Tag|Service)\s*(?:<[^;]+?>)?\s*\(/.test(
				node.initializer.getText(file)
			)
		)
			services.push(node.name.text);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const indirection = inlineEvidence(file, topLevelFunctions);
	return {
		imports: [
			...new Map(
				imports.map((item) => [`${item.typeOnly ? 'type' : 'value'}:${item.specifier}`, item])
			).values()
		].sort(
			(a, b) => a.specifier.localeCompare(b.specifier) || Number(a.typeOnly) - Number(b.typeOnly)
		),
		functions,
		namedFunctions: topLevelFunctions.length,
		namedPassThroughFunctions: topLevelFunctions.filter(({ body }) => isPassThrough(body)).length,
		inlineCandidates: indirection.inlineCandidates,
		localNamedCalls: indirection.localCalls,
		duplicateEntities,
		services: [...new Set(services)].sort()
	};
}
