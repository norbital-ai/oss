import ts from 'typescript';
import { memoised } from './facts.js';

/** Resolve local import/destructuring names without examining a call's arguments. */
export function importedCallTarget(
	node: ts.CallExpression,
	source: ts.SourceFile,
	modules: RegExp,
	/** Follow only these imported factories when resolving members of their returned builders. */
	factories?: ReadonlySet<string>
): string | undefined {
	const declarations = memoised(source, 'callTargetDeclarations', () => {
		const found = new Map<string, Array<ts.Declaration>>();
		const add = (name: ts.Identifier, declaration: ts.Declaration): void => {
			const rows = found.get(name.text) ?? [];
			rows.push(declaration);
			found.set(name.text, rows);
		};
		const visit = (current: ts.Node): void => {
			if (ts.isTypeNode(current)) return;
			if (
				(ts.isVariableDeclaration(current) ||
					ts.isParameter(current) ||
					ts.isBindingElement(current) ||
					ts.isFunctionDeclaration(current) ||
					ts.isFunctionExpression(current) ||
					ts.isClassDeclaration(current) ||
					ts.isImportClause(current) ||
					ts.isImportSpecifier(current) ||
					ts.isNamespaceImport(current)) &&
				current.name !== undefined &&
				ts.isIdentifier(current.name)
			)
				add(current.name, current);
			ts.forEachChild(current, visit);
		};
		visit(source);
		return found;
	});
	const scope = (declaration: ts.Declaration): ts.Node => {
		if (ts.isFunctionExpression(declaration)) return declaration;
		let current = declaration.parent;
		while (current !== undefined) {
			if (
				ts.isSourceFile(current) ||
				ts.isFunctionLike(current) ||
				ts.isBlock(current) ||
				ts.isForStatement(current) ||
				ts.isForInStatement(current) ||
				ts.isForOfStatement(current) ||
				ts.isCatchClause(current)
			)
				return current;
			current = current.parent;
		}
		return source;
	};
	const seen = new Set<ts.Declaration>();
	const resolve = (expression: ts.Expression, at: ts.Node): string | undefined => {
		if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression, at);
		if (ts.isPropertyAccessExpression(expression)) {
			const base = resolve(expression.expression, at);
			return base === undefined ? undefined : `${base}.${expression.name.text}`;
		}
		if (
			ts.isElementAccessExpression(expression) &&
			ts.isStringLiteral(expression.argumentExpression)
		) {
			const base = resolve(expression.expression, at);
			return base === undefined ? undefined : `${base}.${expression.argumentExpression.text}`;
		}
		if (
			ts.isCallExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === 'require' &&
			expression.arguments.length === 1
		) {
			const argument = expression.arguments[0];
			return argument !== undefined && ts.isStringLiteral(argument) && modules.test(argument.text)
				? argument.text
				: undefined;
		}
		if (ts.isCallExpression(expression) && factories !== undefined) {
			const factory = resolve(expression.expression, at);
			return factory !== undefined && factories.has(factory) ? `${factory}()` : undefined;
		}
		if (!ts.isIdentifier(expression)) return undefined;
		const rows = declarations.get(expression.text) ?? [];
		for (let owner: ts.Node | undefined = at; owner !== undefined; owner = owner.parent) {
			const declaration = rows.find((row) => scope(row) === owner);
			if (declaration === undefined) continue;
			if (seen.has(declaration)) return undefined;
			seen.add(declaration);
			if (
				ts.isImportSpecifier(declaration) ||
				ts.isNamespaceImport(declaration) ||
				ts.isImportClause(declaration)
			) {
				let parent: ts.Node | undefined = declaration;
				while (parent !== undefined && !ts.isImportDeclaration(parent)) parent = parent.parent;
				if (
					parent === undefined ||
					!ts.isImportDeclaration(parent) ||
					!ts.isStringLiteral(parent.moduleSpecifier) ||
					parent.importClause?.isTypeOnly ||
					(ts.isImportSpecifier(declaration) && declaration.isTypeOnly) ||
					!modules.test(parent.moduleSpecifier.text)
				)
					return undefined;
				return ts.isImportSpecifier(declaration)
					? `${parent.moduleSpecifier.text}.${(declaration.propertyName ?? declaration.name).text}`
					: parent.moduleSpecifier.text;
			}
			if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined)
				return resolve(declaration.initializer, declaration);
			if (
				ts.isBindingElement(declaration) &&
				ts.isObjectBindingPattern(declaration.parent) &&
				ts.isVariableDeclaration(declaration.parent.parent) &&
				declaration.dotDotDotToken === undefined
			) {
				const variable = declaration.parent.parent;
				const property = declaration.propertyName ?? declaration.name;
				if (
					variable.initializer === undefined ||
					!(ts.isIdentifier(property) || ts.isStringLiteral(property))
				)
					return undefined;
				const base = resolve(variable.initializer, variable);
				return base === undefined ? undefined : `${base}.${property.text}`;
			}
			return undefined;
		}
		return undefined;
	};
	return resolve(node.expression, node);
}
