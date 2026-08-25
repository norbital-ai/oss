/**
 * Shared fixture plumbing for the metric tests: parse inline sources and fish out one
 * declaration by name. Kept as source rather than build output because only tests read it.
 */
import ts from 'typescript';

/** Parse a snippet as TypeScript with parents wired (getText and syntax checks need them). */
export function parse(source: string): ts.SourceFile {
	return ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
}

function named<T extends ts.Node>(
	source: string,
	name: string,
	pick: (file: ts.SourceFile) => T | undefined,
	kind: string
): T {
	const found = pick(parse(source));
	if (!found) throw new Error(`fixture lost ${kind} "${name}"`);
	return found;
}

const functionByName = (source: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined =>
	source.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name
	);

const classByName = (source: ts.SourceFile, name: string): ts.ClassDeclaration | undefined =>
	source.statements.find(
		(statement): statement is ts.ClassDeclaration =>
			ts.isClassDeclaration(statement) && statement.name?.text === name
	);

const variableInitializer = (
	source: ts.SourceFile,
	name: string
): ts.Expression | undefined => {
	for (const statement of source.statements) {
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations)
			if (ts.isIdentifier(declaration.name) && declaration.name.text === name)
				return declaration.initializer;
	}
	return undefined;
};

export const fnNamed = (source: string, name: string): ts.FunctionDeclaration =>
	named(source, name, (file) => functionByName(file, name), 'function');

export const classNamed = (source: string, name: string): ts.ClassDeclaration =>
	named(source, name, (file) => classByName(file, name), 'class');

export const arrowNamed = (source: string, name: string): ts.ArrowFunction => {
	const initializer = variableInitializer(parse(source), name);
	if (!initializer || !ts.isArrowFunction(initializer))
		throw new Error(`fixture lost arrow "${name}"`);
	return initializer;
};
