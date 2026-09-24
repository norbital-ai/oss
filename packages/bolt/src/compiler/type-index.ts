/**
 * The compiler's own answer to "what shape is this?", written once per `bolt sync`.
 *
 * An agent that has to write a record needs the value each field accepts — `amount_charged` is
 * `{ value: number; currency: string }`, not `json` — and the only thing that knows that exactly
 * is the type checker over the workspace's generated `$types`. Reading source to reconstruct it cost
 * one staging turn eleven tool calls. So sync asks the checker once, expands each collection's
 * `Row`, `CreateInput` and `UpdateInput` to plain TypeScript text, and ships the text on the
 * collection definition: a lookup at run time is a property read, with no compiler resident.
 *
 * The same pass is the strictness gate. A surface that resolves to `any` — an import naming what
 * its module does not export, a dependency release missing a module, a type cycle — is exactly the
 * failure `skipLibCheck` hides, so sync refuses it with every offending path.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { CollectionTypes } from '../authoring/workspace-schema.js';

/** Longest single expanded type kept; past this the text stops helping a reader and costs tokens. */
const MAX_TYPE_TEXT = 6_000;
/** How deep the `any` search follows object members, arrays and unions. */
const ANY_DEPTH = 4;

export interface TypeIndexCollection {
	readonly name: string;
	readonly create: boolean;
	readonly update: boolean;
}

export interface TypeIndex {
	readonly collections: Readonly<Record<string, CollectionTypes>>;
	/** Every surface position that resolved to `any`, as `collection.Surface.path`. */
	readonly anyPaths: ReadonlyArray<string>;
}

const FORMAT =
	ts.TypeFormatFlags.NoTruncation |
	ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType |
	ts.TypeFormatFlags.WriteArrayAsGenericType;

const clip = (text: string): string =>
	text.length <= MAX_TYPE_TEXT ? text : `${text.slice(0, MAX_TYPE_TEXT)} /* … truncated */`;

/**
 * Builds the index, or answers `undefined` when the workspace has no `tsconfig.json` to compile
 * against (a definition assembled in memory, a test fixture): no index, no gate, nothing guessed.
 */
export const buildTypeIndex = (
	root: string,
	collections: ReadonlyArray<TypeIndexCollection>
): TypeIndex | undefined => {
	const configPath = join(root, 'tsconfig.json');
	if (!existsSync(configPath) || collections.length === 0) return undefined;
	const config = ts.getParsedCommandLineOfConfigFile(
		configPath,
		{},
		{
			...ts.sys,
			onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
				throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
			}
		}
	);
	if (config === undefined) return undefined;

	const probePath = join(root, 'src', '__bolt_type_index.ts');
	const aliases = collections.map((collection, index) => ({ ...collection, index }));
	const probe = aliases
		.map(
			({ name, index }) =>
				`import type { Row as R${index}, CreateInput as C${index}, UpdateInput as U${index} } from './collections/${name}/$types.js';\n` +
				`declare const r${index}: R${index};\ndeclare const c${index}: C${index};\ndeclare const u${index}: U${index};\n` +
				`export { r${index}, c${index}, u${index} };\n`
		)
		.join('');
	const host = ts.createCompilerHost(config.options, true);
	const readFile = host.readFile.bind(host);
	const fileExists = host.fileExists.bind(host);
	const getSourceFile = host.getSourceFile.bind(host);
	host.readFile = (file) => (file === probePath ? probe : readFile(file));
	host.fileExists = (file) => file === probePath || fileExists(file);
	host.getSourceFile = (file, language, onError, create) =>
		file === probePath
			? ts.createSourceFile(file, probe, language, true, ts.ScriptKind.TS)
			: getSourceFile(file, language, onError, create);
	// `realpath` is what lets a pnpm-isolated dependency resolve from a package's own directory; a
	// host without it types every column `any` — the very failure this pass exists to report.
	const realpath = ts.sys.realpath;
	if (realpath !== undefined) host.realpath = realpath;
	const program = ts.createProgram({
		rootNames: [probePath],
		options: { ...config.options, noEmit: true },
		host
	});
	const checker = program.getTypeChecker();
	const source = program.getSourceFile(probePath);
	if (source === undefined) return undefined;
	const declared = new Map<string, ts.Identifier>();
	source.forEachChild((statement) => {
		if (!ts.isVariableStatement(statement)) return;
		for (const declaration of statement.declarationList.declarations)
			if (ts.isIdentifier(declaration.name)) declared.set(declaration.name.text, declaration.name);
	});

	const anyPaths: string[] = [];
	const findAny = (type: ts.Type, path: string, depth: number, seen: Set<ts.Type>): void => {
		if ((type.flags & ts.TypeFlags.Any) !== 0) {
			anyPaths.push(path);
			return;
		}
		if (depth >= ANY_DEPTH || seen.has(type)) return;
		seen.add(type);
		if (type.isUnionOrIntersection()) {
			for (const member of type.types) findAny(member, path, depth, seen);
			return;
		}
		if (checker.isArrayType(type) || checker.isTupleType(type)) {
			for (const element of checker.getTypeArguments(type as ts.TypeReference))
				findAny(element, `${path}[]`, depth + 1, seen);
			return;
		}
		if ((type.flags & ts.TypeFlags.Object) === 0) return;
		for (const property of checker.getPropertiesOfType(type)) {
			const declaration = property.valueDeclaration ?? property.declarations?.[0];
			if (declaration === undefined) continue;
			findAny(
				checker.getTypeOfSymbolAtLocation(property, declaration),
				`${path}.${property.name}`,
				depth + 1,
				seen
			);
		}
	};

	/**
	 * The checker's text, except where it would name a module path (`import("./x/$types.js").Money`):
	 * a reader without the source cannot follow that, so such a type is spelt out structurally.
	 */
	const render = (type: ts.Type, node: ts.Node, depth: number, optional = false): string => {
		const text = checker.typeToString(type, node, FORMAT);
		if (type.isUnion() && (optional || text.includes('import('))) {
			const nullish = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
			// An optional key's `?` already says `undefined`; the value first, then `null`, is the order
			// a reader expects rather than the checker's.
			const members = type.types.filter(
				(member) => !optional || (member.flags & ts.TypeFlags.Undefined) === 0
			);
			const rendered = [
				...members.filter((member) => (member.flags & nullish) === 0),
				...members.filter((member) => (member.flags & nullish) !== 0)
			].map((member) => render(member, node, depth));
			// The checker holds `boolean` as `false | true`; say it the way it was written.
			return (
				rendered.includes('false') && rendered.includes('true')
					? ['boolean', ...rendered.filter((part) => part !== 'false' && part !== 'true')]
					: rendered
			).join(' | ');
		}
		if (!text.includes('import(') || depth >= ANY_DEPTH) return text;
		if (checker.isArrayType(type)) {
			const [element] = checker.getTypeArguments(type as ts.TypeReference);
			return element === undefined ? text : `ReadonlyArray<${render(element, node, depth + 1)}>`;
		}
		if ((type.flags & ts.TypeFlags.Object) === 0 || type.getCallSignatures().length > 0)
			return text;
		const members = checker.getPropertiesOfType(type).map((property) => {
			const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
			return `${property.name}${optional}: ${render(checker.getTypeOfSymbolAtLocation(property, node), node, depth + 1, optional === '?')}`;
		});
		return `{ ${members.join('; ')} }`;
	};

	/** One property per line, so a field's accepted value reads at a glance. */
	const expand = (
		node: ts.Identifier
	): { readonly text: string; readonly fields: Record<string, string> } => {
		const type = checker.getTypeAtLocation(node);
		if ((type.flags & ts.TypeFlags.Never) !== 0) return { text: 'never', fields: {} };
		const fields: Record<string, string> = {};
		const lines = checker.getPropertiesOfType(type).map((property) => {
			const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
			const value = clip(
				render(checker.getTypeOfSymbolAtLocation(property, node), node, 0, optional)
			);
			fields[property.name] = `${optional ? '?' : ''}${value}`;
			return `  ${property.name}${optional ? '?' : ''}: ${value};`;
		});
		return { text: clip(`{\n${lines.join('\n')}\n}`), fields };
	};

	const indexed: Record<string, CollectionTypes> = {};
	for (const { name, index, create, update } of aliases) {
		const row = declared.get(`r${index}`);
		const creating = declared.get(`c${index}`);
		const updating = declared.get(`u${index}`);
		if (row === undefined || creating === undefined || updating === undefined) continue;
		for (const [surface, node, declaredHere] of [
			['Row', row, true],
			['CreateInput', creating, create],
			['UpdateInput', updating, update]
		] as const)
			if (declaredHere)
				findAny(checker.getTypeAtLocation(node), `${name}.${surface}`, 0, new Set());
		const expandedRow = expand(row);
		const expandedCreate = create ? expand(creating) : undefined;
		const expandedUpdate = update ? expand(updating) : undefined;
		indexed[name] = {
			row: expandedRow.text,
			fields: expandedRow.fields,
			...(expandedCreate === undefined
				? {}
				: { create: expandedCreate.text, createFields: expandedCreate.fields }),
			...(expandedUpdate === undefined
				? {}
				: { update: expandedUpdate.text, updateFields: expandedUpdate.fields })
		};
	}
	return { collections: indexed, anyPaths: [...new Set(anyPaths)].sort() };
};
