/**
 * Single-use private functions a caller could inline: the evidence behind the `callSites` fact. Ported from the
 * old metrics tier's `analysis/complexity.ts`; only the inline-candidate half survives.
 */
import ts from 'typescript';

export type InlineCandidate = Readonly<{
	name: string;
	kind: 'callback-proxy' | 'transparent-forwarder' | 'single-use-expression';
}>;


function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
	const modifiers = (node as { modifiers?: ReadonlyArray<ts.Modifier> }).modifiers;
	return modifiers?.some((modifier) => modifier.kind === kind) === true;
}

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
	const callee = call.expression;
	if (!(
		ts.isIdentifier(callee) ||
		(ts.isPropertyAccessExpression(callee) && !ts.isCallExpression(callee.expression))
	))
		return null;
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
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan())
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

const GENERIC_EXPRESSION_NAME =
	/^(?:tmp|temp|helper|util|utils|wrap|wrapper|shim|inner|fn|go|impl|thunk|label)$/i;

function nameEarnsExpression(name: string, expression: ts.Node): boolean {
	if (GENERIC_EXPRESSION_NAME.test(name) || name.length <= 2) return false;
	if (ts.isCallExpression(expression)) {
		const callee = expression.expression;
		const calleeName = ts.isIdentifier(callee)
			? callee.text
			: ts.isPropertyAccessExpression(callee)
				? callee.name.text
				: '';
		if (calleeName !== '' && name.toLowerCase() === calleeName.toLowerCase()) return false;
	}
	return /[a-z][A-Z]/.test(name) || (name.includes('_') && name.length >= 6);
}

/** Every top-level, unexported function called exactly once from outside itself whose body a caller could inline. */
export function inlineCandidates(file: ts.SourceFile): ReadonlyArray<InlineCandidate> {
	const candidates: Array<TopLevelFunction> = [];
	const collect = (node: ts.Node): void => {
		const candidate = topLevelFunctionCandidate(node);
		if (candidate) candidates.push(candidate);
		ts.forEachChild(node, collect);
	};
	collect(file);
	const counts = new Map<string, number>();
	for (const candidate of candidates) counts.set(candidate.name, (counts.get(candidate.name) ?? 0) + 1);
	const references = new Map<string, Array<ts.Identifier>>(candidates.map(({ name }) => [name, []]));
	const visit = (node: ts.Node): void => {
		if (ts.isIdentifier(node) && references.has(node.text) && isValueIdentifier(node))
			references.get(node.text)?.push(node);
		ts.forEachChild(node, visit);
	};
	visit(file);
	const found: Array<InlineCandidate> = [];
	for (const candidate of candidates) {
		if (counts.get(candidate.name) !== 1 || isExportedTopLevelFunction(candidate)) continue;
		if (candidate.node.type !== undefined && ts.isTypePredicateNode(candidate.node.type)) continue;
		const external = (references.get(candidate.name) ?? []).filter(
			(use) => use.getStart(file) < candidate.node.getStart(file) || use.end > candidate.node.end
		);
		const use = external[0];
		if (external.length !== 1 || use === undefined || !ts.isCallExpression(use.parent) || use.parent.expression !== use)
			continue;
		const forwardedTo = transparentForwardedCall(candidate);
		const expression = forwardedTo ? null : safeSingleExpression(candidate);
		if (!forwardedTo && (!expression || nameEarnsExpression(candidate.name, expression))) continue;
		found.push({
			name: candidate.name,
			kind: forwardedTo && /^(?:on[A-Z]|handle[A-Z]|callback|listener|handler)/.test(candidate.name)
				? 'callback-proxy'
				: forwardedTo ? 'transparent-forwarder' : 'single-use-expression'
		});
	}
	return found;
}
