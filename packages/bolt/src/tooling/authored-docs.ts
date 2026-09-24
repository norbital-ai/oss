/**
 * Where a workspace surface is authored, and what its author wrote about it.
 *
 * The doc comment on a transform ("stamps the dispatch when one is named") or on a model column is
 * the workspace's own statement of how it behaves. An agent that cannot see it samples rows and
 * probes with writes to rediscover it. This reads those comments straight from the authored files —
 * a syntax pass, no checker — so `bolt sync` can ship them on the type index and the type service can
 * point a definition that lands in generated `$types.d.ts` back at the line an author wrote.
 *
 * Paths follow the workspace conventions the snapshot already names: a collection is
 * `src/collections/<name>/+model.ts` and `+collection.ts`, an automation `src/automations/+<name>.ts`,
 * a function `src/functions/+<name>.ts`, an app `src/apps/+<name>.svelte`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { CollectionDocs, SourceDoc } from '../authoring/workspace-schema.js';

export type { CollectionDocs, SourceDoc };

/** A first paragraph past this stops being a summary and starts costing every prompt. */
const MAX_DOC = 400;

/** Reads a workspace file, preferring a draft's copy; `undefined` when neither exists. */
export type ReadAuthored = (path: string) => string | undefined;

export const readFromDisk =
	(root: string): ReadAuthored =>
	(path) => {
		const file = join(root, path);
		return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
	};

/** The `/** … *\/` immediately before `node`, reduced to its first paragraph on one line. */
const leadingDoc = (node: ts.Node, source: ts.SourceFile): string => {
	const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
	const last = ranges.at(-1);
	if (last === undefined) return '';
	const raw = source.text.slice(last.pos, last.end);
	if (!raw.startsWith('/**')) return '';
	const body = raw
		.slice(3, -2)
		.split('\n')
		.map((line) => line.replace(/^\s*\*\s?/, ''))
		.join('\n')
		.trim();
	const paragraph = (body.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
	return paragraph.length <= MAX_DOC ? paragraph : `${paragraph.slice(0, MAX_DOC - 1)}…`;
};

const at = (path: string, node: ts.Node, source: ts.SourceFile): string =>
	`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

/** The first `callee({...})` call's object argument, and the statement that holds it. */
const findCall = (
	source: ts.SourceFile,
	callee: string
): { readonly object: ts.ObjectLiteralExpression; readonly statement: ts.Node } | undefined => {
	let found: { object: ts.ObjectLiteralExpression; statement: ts.Node } | undefined;
	for (const statement of source.statements) {
		const visit = (node: ts.Node): void => {
			if (found !== undefined) return;
			if (
				ts.isCallExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === callee &&
				node.arguments[0] !== undefined &&
				ts.isObjectLiteralExpression(node.arguments[0])
			) {
				found = { object: node.arguments[0], statement };
				return;
			}
			ts.forEachChild(node, visit);
		};
		visit(statement);
		if (found !== undefined) return found;
	}
	return undefined;
};

const propertyName = (property: ts.ObjectLiteralElementLike): string | undefined =>
	(ts.isPropertyAssignment(property) ||
		ts.isShorthandPropertyAssignment(property) ||
		ts.isMethodDeclaration(property)) &&
	(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
		? property.name.text
		: undefined;

const parse = (path: string, text: string): ts.SourceFile =>
	ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const doc = (path: string, node: ts.Node, source: ts.SourceFile): SourceDoc => ({
	text: leadingDoc(node, source),
	source: at(path, node, source)
});

/** What the authored files of one collection say, or `undefined` when it has no `+model.ts`. */
export const collectionDocs = (read: ReadAuthored, name: string): CollectionDocs | undefined => {
	const modelPath = `src/collections/${name}/+model.ts`;
	const modelText = read(modelPath);
	if (modelText === undefined) return undefined;
	const model = parse(modelPath, modelText);
	const modelCall = findCall(model, 'defineModel');
	const fields: Record<string, SourceDoc> = {};
	for (const property of modelCall?.object.properties ?? []) {
		const field = propertyName(property);
		if (field !== undefined) fields[field] = doc(modelPath, property, model);
	}
	const collectionPath = `src/collections/${name}/+collection.ts`;
	const collectionText = read(collectionPath);
	const collection =
		collectionText === undefined ? undefined : parse(collectionPath, collectionText);
	const collectionCall =
		collection === undefined ? undefined : findCall(collection, 'defineCollection');
	const member = (key: string): SourceDoc | undefined => {
		if (collection === undefined || collectionCall === undefined) return undefined;
		const property = collectionCall.object.properties.find((entry) => propertyName(entry) === key);
		return property === undefined ? undefined : doc(collectionPath, property, collection);
	};
	const described =
		collection !== undefined && collectionCall !== undefined
			? doc(collectionPath, collectionCall.statement, collection)
			: modelCall === undefined
				? undefined
				: doc(modelPath, modelCall.statement, model);
	const create = member('create');
	const update = member('update');
	const transform = member('transform');
	return {
		...(described === undefined ? {} : { collection: described }),
		...(create === undefined ? {} : { create }),
		...(update === undefined ? {} : { update }),
		...(transform === undefined ? {} : { transform }),
		fields
	};
};

/** The file a workspace name is authored in, by convention; the collection case is `collectionDocs`. */
export const authoredFileOf = (kind: string, name: string): ReadonlyArray<string> => {
	switch (kind) {
		case 'automations':
			return [`src/automations/+${name}.ts`];
		case 'functions':
			return [`src/functions/+${name}.ts`];
		case 'apps':
			return [`src/apps/+${name}.svelte`, `src/apps/${name}/+page.svelte`];
		case 'channels':
			return [`src/channels/+${name}.ts`];
		default:
			return [];
	}
};

/** The first line of `text` that declares the file's default export or `symbol`, 1-based. */
export const declarationLine = (path: string, text: string, symbol?: string): number => {
	if (path.endsWith('.svelte')) return 1;
	const source = parse(path, text);
	for (const statement of source.statements) {
		const named =
			symbol !== undefined &&
			((ts.isFunctionDeclaration(statement) && statement.name?.text === symbol) ||
				(ts.isVariableStatement(statement) &&
					statement.declarationList.declarations.some(
						(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === symbol
					)) ||
				((ts.isInterfaceDeclaration(statement) ||
					ts.isTypeAliasDeclaration(statement) ||
					ts.isClassDeclaration(statement)) &&
					statement.name?.text === symbol));
		if (named || (symbol === undefined && ts.isExportAssignment(statement)))
			return source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
	}
	return 1;
};

/** The doc comment on the statement at `line`, for a name resolved to a file. */
export const docAtLine = (path: string, text: string, line: number): string => {
	const source = parse(path, text);
	const statement = source.statements.find(
		(entry) => source.getLineAndCharacterOfPosition(entry.getStart(source)).line + 1 === line
	);
	return statement === undefined ? '' : leadingDoc(statement, source);
};
