/**
 * Structure, indirection and repeated work.
 *
 * Ported from `A1`, `A5`, `A6`, `D2`, `P9`, `Q1`, `COMPLEX1`, `S1`, `S3`, `S5`, `PERF1`–`PERF4`,
 * `E1`–`E3`, `IMP1`, and the alias family `AL1`–`AL3`.
 *
 * `Q3`/`Q4` are not here. They ask whether a private declaration has exactly one caller, which is a
 * whole-file question the legacy detector answered in a finalize pass; they belong with the
 * cross-file rules.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { defineRule } from '../pattern.js';
import { definePack, type Pack, type Rule } from '../rules.js';
import { readJsonObject, recordField, stringField } from '../manifest.js';

/**
 * Path aliases a repository declares, as `prefix -> repository-relative target directory`.
 *
 * Read from tsconfig `compilerOptions.paths` and from a manifest's `imports` map, walking up from
 * the importing file so a package inside a monorepo sees its own aliases and the root's. Cached per
 * directory: this runs once per import statement otherwise.
 */
const aliasCache = new Map<string, ReadonlyArray<Readonly<{ prefix: string; target: string }>>>();

function stripJsonComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');
}

/** Records one alias, resolved against its base. */
type RecordAlias = (prefix: string, target: string, base: string) => void;

/**
 * `compilerOptions.paths` from a tsconfig or jsconfig, narrowed field by field.
 *
 * A config this reader cannot parse means "no aliases known", never a finding — so every branch
 * here falls through to declaring nothing rather than asserting a shape onto the file.
 */
function tsconfigAliases(root: string, directory: string, name: string, record: RecordAlias): void {
	const file = join(root, directory === '.' ? name : `${directory}/${name}`);
	if (!existsSync(file)) return;
	const parsed = readJsonObject(stripJsonComments(readFileSync(file, 'utf8')));
	if (parsed === undefined) return;
	const compilerOptions = recordField(parsed, 'compilerOptions');
	const base = join(directory, stringField(compilerOptions, 'baseUrl') ?? '.');
	for (const [prefix, targets] of Object.entries(recordField(compilerOptions, 'paths')))
		for (const target of Array.isArray(targets) ? targets : [])
			if (typeof target === 'string') record(prefix, target, base);
}

/** A package's own `imports` map, which declares the `#alias/...` prefixes. */
function manifestAliases(root: string, directory: string, record: RecordAlias): void {
	const file = join(root, directory === '.' ? 'package.json' : `${directory}/package.json`);
	if (!existsSync(file)) return;
	const parsed = readJsonObject(readFileSync(file, 'utf8'));
	if (parsed === undefined) return;
	for (const [prefix, target] of Object.entries(recordField(parsed, 'imports')))
		if (typeof target === 'string') record(prefix, target, directory);
}

function aliasesFor(
	root: string,
	directory: string
): ReadonlyArray<Readonly<{ prefix: string; target: string }>> {
	const key = `${root}\u0000${directory}`;
	const cached = aliasCache.get(key);
	if (cached !== undefined) return cached;
	const found: Array<Readonly<{ prefix: string; target: string }>> = [];
	const record: RecordAlias = (prefix, target, base) => {
		const absolute = resolve(root, base, target.replace(/^\.\//, '').replace(/\*.*$/, ''));
		found.push({
			prefix: prefix.replace(/\*.*$/, ''),
			target: relative(root, absolute).split('\\').join('/')
		});
	};
	for (const name of ['tsconfig.json', 'jsconfig.json'])
		tsconfigAliases(root, directory, name, record);
	manifestAliases(root, directory, record);
	aliasCache.set(key, found);
	return found;
}

/** The alias prefix that already covers a deep relative import, if a repository declares one. */
function aliasCovering(root: string, file: string, specifier: string): string | undefined {
	const target = join(dirname(file), specifier)
		.split('\\')
		.join('/')
		.replace(/\.[cm]?[jt]sx?$/, '');
	for (let directory = dirname(file); ; directory = dirname(directory)) {
		for (const alias of aliasesFor(root, directory))
			// The alias points at a directory that contains the thing being imported the long way.
			if (alias.target !== '' && target.startsWith(`${alias.target}/`)) return alias.prefix;
		if (directory === '.' || directory === '' || directory === '/') return undefined;
	}
}

const discardedTimer = defineRule({
	id: 'A1',
	severity: 'error',
	summary: 'discarded timer requires cleanup review',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		const callee = context.calleeName(node);
		if (callee !== 'setInterval' && callee !== 'setTimeout') return;
		const ts = context.ts;
		// A timer whose handle is kept can be cleared; one thrown away cannot.
		// Walk only as far as the enclosing statement. Walking to the top made every timer inside an
		// assigned function look "kept", because the function itself is assigned to something.
		let kept = false;
		for (const parent of context.ancestors(node)) {
			if (ts.isExpressionStatement(parent) || ts.isBlock(parent) || ts.isSourceFile(parent)) break;
			if (
				ts.isVariableDeclaration(parent) ||
				ts.isPropertyAssignment(parent) ||
				ts.isBinaryExpression(parent) ||
				ts.isReturnStatement(parent)
			) {
				kept = true;
				break;
			}
		}
		if (!kept) context.report(node, `api=${callee} handle=discarded`);
	}
});

const catchRethrow = defineRule({
	id: 'A5',
	severity: 'hint',
	summary: 'catch only rethrows',
	principles: ['simplicity', 'no-bloat'],
	when: ['CatchClause'],
	check(node, context) {
		const ts = context.ts;
		const clause = node as import('typescript').CatchClause;
		const [only] = clause.block.statements;
		if (clause.block.statements.length !== 1 || only === undefined) return;
		if (!ts.isThrowStatement(only) || only.expression === undefined) return;
		// `catch { throw new X() }` replaces the error and is not a pass-through; and a clause with
		// no binding has no identifier to compare, which is where the legacy rule crashed.
		if (clause.variableDeclaration === undefined) return;
		if (!ts.isIdentifier(clause.variableDeclaration.name) || !ts.isIdentifier(only.expression))
			return;
		if (clause.variableDeclaration.name.text === only.expression.text)
			context.report(node, 'body=rethrow');
	}
});

const awaitInLoop = defineRule({
	id: 'A6',
	severity: 'error',
	// Sequential `await` in a loop is a concurrency defect that happens to be spelled with `await`;
	// EFF3's weaker "there is an await here" adds nothing at the same site.
	dominates: ['EFF3'],
	summary: 'await inside a synchronous loop',
	principles: ['efficiency', 'straightforwardness'],
	when: ['AwaitExpression'],
	check(node, context) {
		const ts = context.ts;
		for (const parent of context.ancestors(node)) {
			if (ts.isFunctionLike(parent)) return;
			if (
				ts.isForStatement(parent) ||
				ts.isForOfStatement(parent) ||
				ts.isForInStatement(parent) ||
				ts.isWhileStatement(parent) ||
				ts.isDoStatement(parent)
			) {
				context.report(node, 'position=loop-body');
				return;
			}
		}
	}
});

const identicalBranches = defineRule({
	id: 'D2',
	severity: 'error',
	summary: 'conditional has identical branches',
	principles: ['simplicity', 'no-bloat'],
	when: ['ConditionalExpression'],
	check(node, context) {
		const expression = node as import('typescript').ConditionalExpression;
		const left = context.text(expression.whenTrue).trim();
		const right = context.text(expression.whenFalse).trim();
		if (left === right) context.report(node, 'branches=identical');
	}
});

const exportStar = defineRule({
	id: 'P9',
	severity: 'hint',
	summary: 'export-star barrel',
	principles: ['simplicity', 'colocation', 'no-bloat'],
	when: ['ExportDeclaration'],
	check(node, context) {
		const declaration = node as import('typescript').ExportDeclaration;
		if (declaration.exportClause === undefined && declaration.moduleSpecifier !== undefined)
			context.report(node, 'form=export-star');
	}
});

const deepNesting = defineRule({
	id: 'COMPLEX1',
	severity: 'error',
	summary: 'function control flow nests four or more levels',
	principles: ['simplicity', 'testability', 'no-bloat'],
	when: ['FunctionDeclaration', 'MethodDeclaration', 'ArrowFunction', 'FunctionExpression'],
	check(node, context) {
		const ts = context.ts;
		const body = (node as import('typescript').FunctionLikeDeclaration).body;
		if (body === undefined) return;
		let deepest = 0;
		const visit = (current: import('typescript').Node, depth: number): void => {
			const branching =
				ts.isIfStatement(current) ||
				ts.isForStatement(current) ||
				ts.isForOfStatement(current) ||
				ts.isForInStatement(current) ||
				ts.isWhileStatement(current) ||
				ts.isDoStatement(current) ||
				ts.isSwitchStatement(current) ||
				ts.isTryStatement(current);
			const next = branching ? depth + 1 : depth;
			if (next > deepest) deepest = next;
			// A nested function starts its own budget; its depth is its own to answer for.
			if (ts.isFunctionLike(current) && current !== node) return;
			ts.forEachChild(current, (child) => visit(child, next));
		};
		visit(body, 0);
		if (deepest >= 4) context.report(node, `depth=${deepest} prefer=guard-clauses`);
	}
});

const silentCatch = defineRule({
	id: 'S1',
	severity: 'error',
	summary: 'silent catch block',
	principles: ['straightforwardness', 'testability'],
	when: ['CatchClause'],
	check(node, context) {
		const clause = node as import('typescript').CatchClause;
		if (clause.block.statements.length > 0) return;
		// A comment saying why is the difference between deliberate and forgotten.
		if (/\/\/|\/\*/.test(context.text(clause.block))) return;
		context.report(node, 'body=empty');
	}
});

const verboseNullCheck = defineRule({
	id: 'S3',
	severity: 'hint',
	summary: 'verbose null and undefined check',
	principles: ['simplicity', 'no-bloat'],
	rule: {
		any: ['$VALUE !== null && $VALUE !== undefined', '$VALUE === null || $VALUE === undefined']
	},
	examples: {
		bad: ['if (row !== null && row !== undefined) use(row);'],
		good: ['if (row != null) use(row);']
	}
});

const setRoundTrip = defineRule({
	id: 'S5',
	severity: 'hint',
	summary: 'Array.from(new Set(...))',
	principles: ['simplicity', 'no-bloat'],
	rule: 'Array.from(new Set($VALUE))',
	examples: {
		bad: ['const unique = Array.from(new Set(items));'],
		good: ['const unique = [...new Set(items)];']
	}
});

const chainedTraversals = defineRule({
	id: 'PERF3',
	severity: 'error',
	summary: 'three or more eager collection traversals are chained',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	when: ['CallExpression'],
	check(node, context) {
		const ts = context.ts;
		const EAGER = /^(?:map|filter|flatMap|forEach|reduce|sort|reverse|slice|concat)$/;
		const call = node as import('typescript').CallExpression;
		if (!ts.isPropertyAccessExpression(call.expression)) return;
		if (!EAGER.test(call.expression.name.text)) return;
		// Report once, at the outermost link, so one chain is one finding.
		const parent = context.ancestors(node)[0];
		if (parent !== undefined && ts.isPropertyAccessExpression(parent)) return;
		let depth = 0;
		let current: import('typescript').Node = call;
		const chain: Array<string> = [];
		while (
			ts.isCallExpression(current) &&
			ts.isPropertyAccessExpression(current.expression) &&
			EAGER.test(current.expression.name.text)
		) {
			chain.unshift(current.expression.name.text);
			depth += 1;
			current = current.expression.expression;
		}
		if (depth >= 3) context.report(node, `traversals=${chain.join('>')}`);
	}
});

const filterFirst = defineRule({
	id: 'PERF4',
	severity: 'error',
	summary: 'filter materializes every match only to select the first',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	rule: { any: ['$SOURCE.filter($PREDICATE)[0]', '$SOURCE.filter($PREDICATE).at(0)'] },
	examples: {
		bad: ['const first = rows.filter(isReady)[0];'],
		good: ['const first = rows.find(isReady);']
	}
});

const ENV_PREFIX = /^(?:SECRET_|PUBLIC_|NORBITAL_|NODE_ENV)/;

const environmentBranch = defineRule({
	id: 'E1',
	severity: 'error',
	summary: 'environment-dependent behavior',
	principles: ['straightforwardness', 'testability'],
	when: ['PropertyAccessExpression', 'ElementAccessExpression'],
	check(node, context) {
		const text = context.text(node);
		if (!/^process\.env\b/.test(text)) return;
		const name = text.replace(/^process\.env[.[]['"]?/, '').replace(/['"]?\]$/, '');
		if (!ENV_PREFIX.test(name)) return;
		const ts = context.ts;
		// Reading configuration is fine; branching on it is what makes behaviour environmental.
		const branched = context
			.ancestors(node)
			.some(
				(parent) =>
					ts.isIfStatement(parent) ||
					ts.isConditionalExpression(parent) ||
					(ts.isBinaryExpression(parent) &&
						[
							ts.SyntaxKind.EqualsEqualsEqualsToken,
							ts.SyntaxKind.ExclamationEqualsEqualsToken
						].includes(parent.operatorToken.kind))
			);
		if (branched) context.report(node, `variable=${name}`);
	}
});

const deepRelativeImport = defineRule({
	id: 'IMP1',
	severity: 'error',
	summary: 'deep relative import bypasses a declared alias for the same target',
	principles: ['simplicity', 'straightforwardness', 'colocation'],
	when: ['ImportDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const declaration = node as import('typescript').ImportDeclaration;
		if (!ts.isStringLiteral(declaration.moduleSpecifier)) return;
		const specifier = declaration.moduleSpecifier.text;
		// Two or more levels up has left the module's own neighbourhood, which is what an alias is
		// for. One level is a sibling directory and stays legible.
		if (!/^\.\.\/\.\.\//.test(specifier)) return;
		// The summary says "bypasses a declared alias", so the alias has to exist. Reporting every
		// `../../` without checking made this the largest rule in the realm on the strength of 266
		// template imports for which no alias is declared — there is no other way to write them.
		const alias = aliasCovering(context.root, context.file, specifier);
		if (alias === undefined) return;
		context.report(node, `specifier=${specifier} alias=${alias}`);
	}
});

const bareAlias = defineRule({
	id: 'AL1',
	severity: 'hint',
	summary: 'bare type alias',
	principles: ['simplicity', 'no-bloat'],
	when: ['TypeAliasDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const alias = node as import('typescript').TypeAliasDeclaration;
		if (ts.isTypeReferenceNode(alias.type) && alias.type.typeArguments === undefined)
			context.report(node, `alias=${alias.name.text}`);
	}
});

const primitiveAlias = defineRule({
	id: 'AL2',
	severity: 'hint',
	summary: 'primitive type alias',
	principles: ['simplicity', 'no-bloat'],
	when: ['TypeAliasDeclaration'],
	check(node, context) {
		const ts = context.ts;
		const alias = node as import('typescript').TypeAliasDeclaration;
		const primitive = [
			ts.SyntaxKind.StringKeyword,
			ts.SyntaxKind.NumberKeyword,
			ts.SyntaxKind.BooleanKeyword
		];
		if (primitive.includes(alias.type.kind)) context.report(node, `alias=${alias.name.text}`);
	}
});

const looseRecordAlias = defineRule({
	id: 'AL3',
	severity: 'hint',
	summary: 'loose-record type alias',
	principles: ['simplicity', 'type-safety', 'no-bloat'],
	when: ['TypeAliasDeclaration'],
	check(node, context) {
		const alias = node as import('typescript').TypeAliasDeclaration;
		// Written as a rule rather than a pattern because a pattern compares every child, and an
		// `export` modifier is a child: `type X = …` would not match `export type X = …`.
		if (/^Record<\s*string\s*,\s*unknown\s*>$/.test(context.text(alias.type)))
			context.report(node, `alias=${alias.name.text}`);
	}
});

/** A function parameter carrying a wide inline object instead of a named, schema-derived type. */
const inlineDataParameter = defineRule({
	id: 'AL9',
	severity: 'error',
	summary: 'large inline data parameter has no named schema-derived owner',
	principles: ['simplicity', 'straightforwardness', 'type-safety'],
	when: ['Parameter'],
	check(node, context) {
		const ts = context.ts;
		const parameter = node as import('typescript').ParameterDeclaration;
		const type = parameter.type;
		if (type === undefined || !ts.isTypeLiteralNode(type)) return;
		const fields = type.members.filter((member) => ts.isPropertySignature(member));
		if (fields.length < 4) return;
		const names = fields
			.map((member) =>
				member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : ''
			)
			.filter(Boolean);
		const owner = ts.isIdentifier(parameter.name) ? parameter.name.text : 'parameter';
		context.report(node, `parameter=${owner} fields=${names.join(',')}`);
	}
});

/** The canonical `{ role, content }` message shape, redeclared inline. */
const inlineMessageShape = defineRule({
	id: 'AL8',
	severity: 'error',
	summary: 'inline message shape redeclares the canonical message type',
	principles: ['simplicity', 'type-safety', 'no-bloat'],
	when: ['TypeLiteral'],
	check(node, context) {
		const ts = context.ts;
		const literal = node as import('typescript').TypeLiteralNode;
		const names = literal.members
			.filter((member) => ts.isPropertySignature(member))
			.map((member) =>
				member.name !== undefined && ts.isIdentifier(member.name) ? member.name.text : ''
			);
		if (!names.includes('role')) return;
		if (!names.includes('content') && !names.includes('parts')) return;
		context.report(node, `fields=${names.filter(Boolean).join(',')}`);
	}
});

/** A decoder constructed inside a traversal is rebuilt for every element. */
const decoderInTraversal = defineRule({
	id: 'PERF2',
	severity: 'error',
	summary: 'Effect Schema decoder is rebuilt for every element',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	when: ['CallExpression'],
	check(node, context) {
		const callee = context.calleeName(node) ?? '';
		if (!/^Schema\.(?:decodeUnknown|decode|encode|validate)/.test(callee)) return;
		const ts = context.ts;
		const TRAVERSAL = /^(?:map|filter|flatMap|forEach|reduce|some|every|find)$/;
		// `Effect.map` / `Option.flatMap` and friends are single-value combinators that happen to
		// share their names with the array methods. Counting them made a decoder built exactly once,
		// inside one `Effect.flatMap`, read as a decoder rebuilt for every element.
		const SINGLE_VALUE = /^(?:Effect|Option|Either|Exit|Fiber|STM)$/;
		const inTraversal = context.ancestors(node).some((parent) => {
			if (!ts.isCallExpression(parent) || !ts.isPropertyAccessExpression(parent.expression))
				return false;
			const receiver = parent.expression.expression;
			if (ts.isIdentifier(receiver) && SINGLE_VALUE.test(receiver.text)) return false;
			return TRAVERSAL.test(parent.expression.name.text);
		});
		// The decoder is the thing constructed per element; calling an already-built one is fine.
		const constructs =
			/decodeUnknown(?:Effect|Sync|Either)?\(|^Schema\.(?:decode|encode|validate)\(/.test(
				context.text(node)
			);
		if (inTraversal && constructs) context.report(node, `api=${callee} position=traversal`);
	}
});

/** An async IIFE inside a lifecycle callback: its rejection has nowhere to go. */
const asyncIife = defineRule({
	id: 'V6',
	severity: 'error',
	summary: 'async IIFE in lifecycle code',
	principles: ['straightforwardness', 'testability'],
	when: ['CallExpression'],
	check(node, context) {
		const ts = context.ts;
		const call = node as import('typescript').CallExpression;
		const target = ts.isParenthesizedExpression(call.expression)
			? call.expression.expression
			: call.expression;
		if (!ts.isFunctionLike(target)) return;
		const modifiers = ts.canHaveModifiers(target) ? (ts.getModifiers(target) ?? []) : [];
		if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return;
		context.report(node, 'form=async-iife');
	}
});

export const structureRules: ReadonlyArray<Rule> = [
	inlineDataParameter,
	inlineMessageShape,
	decoderInTraversal,
	asyncIife,
	discardedTimer,
	catchRethrow,
	awaitInLoop,
	identicalBranches,
	exportStar,
	deepNesting,
	silentCatch,
	verboseNullCheck,
	setRoundTrip,
	chainedTraversals,
	filterFirst,
	environmentBranch,
	deepRelativeImport,
	bareAlias,
	primitiveAlias,
	looseRecordAlias
];

export const structurePack: Pack = definePack({
	name: 'norbital/structure',
	rules: structureRules
});
