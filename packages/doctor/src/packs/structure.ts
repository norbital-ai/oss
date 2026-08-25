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

const withoutModuleExtension = (path: string): string =>
	path.replace(/\.(?:[cm]?[jt]sx?|svelte)$/, '');

function resolvesToDeclaringModule(file: string, root: string, specifier: string): boolean {
	if (!specifier.startsWith('.')) return false;
	const current = withoutModuleExtension(resolve(root, file));
	const target = withoutModuleExtension(resolve(root, dirname(file), specifier));
	return current === target || current === join(target, 'index');
}

const selfModuleEdge = defineRule({
	id: 'MOD1',
	severity: 'error',
	summary: 'module imports or re-exports itself',
	principles: ['simplicity', 'modularity', 'colocation', 'no-bloat'],
	when: ['ImportDeclaration', 'ExportDeclaration', 'ImportEqualsDeclaration', 'CallExpression'],
	check(node, context) {
		const ts = context.ts;
		let specifier: import('typescript').StringLiteral | undefined;
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier))
				specifier = node.moduleSpecifier;
		} else if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference) &&
			node.moduleReference.expression !== undefined &&
			ts.isStringLiteral(node.moduleReference.expression)
		) {
			specifier = node.moduleReference.expression;
		} else if (
			ts.isCallExpression(node) &&
			node.arguments.length === 1 &&
			ts.isStringLiteral(node.arguments[0]!) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				context.calleeName(node) === 'require')
		) {
			specifier = node.arguments[0];
		}
		if (
			specifier === undefined ||
			!resolvesToDeclaringModule(context.file, context.root, specifier.text)
		)
			return;
		// Recursive Svelte components name themselves as a component value; this is an executable
		// render edge, not a module namespace pretending to add another public entrypoint.
		if (
			context.file.endsWith('.svelte') &&
			specifier.text.endsWith('.svelte') &&
			ts.isImportDeclaration(node) &&
			node.importClause?.name !== undefined &&
			node.importClause.namedBindings === undefined
		)
			return;
		context.report(node, `module=${specifier.text}`);
	}
});

/** A domain identity prefixed as unused inside a service that exists to enforce policy. */
const ignoredPolicyIdentity = defineRule({
	id: 'POLICY1',
	severity: 'error',
	summary: 'policy or admission service ignores the identity it is meant to isolate',
	principles: ['simplicity', 'straightforwardness', 'testability'],
	when: ['Parameter'],
	check(node, context) {
		const ts = context.ts;
		const parameter = node as import('typescript').ParameterDeclaration;
		if (!ts.isIdentifier(parameter.name)) return;
		if (
			!/^_?(?:tenant|workspace|account|organization|subject|principal|user)(?:Id|Key)?$/i.test(
				parameter.name.text
			)
		)
			return;
		const parameterName = parameter.name.text;
		const owner = context.ancestors(node).find((parent) => ts.isFunctionLike(parent)) as
			import('typescript').FunctionLikeDeclaration | undefined;
		if (owner?.body === undefined) return;
		const parent = context.ancestors(owner)[0];
		const ownerName =
			'name' in owner && owner.name !== undefined && ts.isIdentifier(owner.name)
				? owner.name.text
				: parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
					? parent.name.text
					: '';
		const policyVocabulary =
			/(?:capacity|admission|authori[sz]|access|permissions?|policy|quota|routing?|rbac|acl|gate)/i;
		if (!policyVocabulary.test(context.file) && !policyVocabulary.test(ownerName)) return;
		let usedForPolicy = false;
		const contains = (
			ownerNode: import('typescript').Node,
			child: import('typescript').Node
		): boolean => ownerNode.pos <= child.pos && ownerNode.end >= child.end;
		const observationCall = (call: import('typescript').CallExpression): boolean =>
			/(?:^|\.)(?:log|debug|trace|info|warn|error|metric|record|observe)$/.test(
				context.calleeName(call) ?? ''
			);
		const trackedNames = new Set([parameterName]);
		let addedAlias = true;
		while (addedAlias) {
			addedAlias = false;
			const collectAliases = (current: import('typescript').Node): void => {
				if (
					ts.isVariableDeclaration(current) &&
					ts.isIdentifier(current.name) &&
					current.initializer !== undefined
				) {
					let readsTracked = false;
					const inspect = (candidate: import('typescript').Node): void => {
						if (ts.isIdentifier(candidate) && trackedNames.has(candidate.text)) readsTracked = true;
						if (!readsTracked) ts.forEachChild(candidate, inspect);
					};
					inspect(current.initializer);
					if (readsTracked && !trackedNames.has(current.name.text)) {
						trackedNames.add(current.name.text);
						addedAlias = true;
					}
				}
				ts.forEachChild(current, collectAliases);
			};
			collectAliases(owner.body);
		}
		const ancestorUsesIdentity = (
			ancestor: import('typescript').Node,
			identity: import('typescript').Identifier
		): boolean =>
			(ts.isCallExpression(ancestor) &&
				ancestor.arguments.some((argument) => contains(argument, identity))) ||
			ts.isBinaryExpression(ancestor) ||
			ts.isElementAccessExpression(ancestor) ||
			(ts.isIfStatement(ancestor) && contains(ancestor.expression, identity)) ||
			(ts.isConditionalExpression(ancestor) && contains(ancestor.condition, identity)) ||
			(ts.isSwitchStatement(ancestor) && contains(ancestor.expression, identity));
		const identityInfluencesPolicy = (identity: import('typescript').Identifier): boolean => {
			if (!trackedNames.has(identity.text)) return false;
			const ancestors = context.ancestors(identity);
			const ownerIndex = ancestors.indexOf(owner);
			const localAncestors = ownerIndex < 0 ? ancestors : ancestors.slice(0, ownerIndex);
			const observed = localAncestors.some(
				(ancestor) =>
					ts.isVoidExpression(ancestor) ||
					(ts.isCallExpression(ancestor) && observationCall(ancestor))
			);
			return (
				!observed && localAncestors.some((ancestor) => ancestorUsesIdentity(ancestor, identity))
			);
		};
		const visit = (current: import('typescript').Node): void => {
			if (ts.isIdentifier(current) && identityInfluencesPolicy(current)) usedForPolicy = true;
			if (!usedForPolicy) ts.forEachChild(current, visit);
		};
		visit(owner.body);
		if (!usedForPolicy) context.report(node, `parameter=${parameterName}`);
	}
});

/** Operational state must be an observation, not a constant that only looks like one. */
const hardcodedOperationalState = defineRule({
	id: 'OPS1',
	severity: 'error',
	summary: 'operational health or admission state is hard-coded',
	principles: ['straightforwardness', 'testability'],
	when: ['ObjectLiteralExpression'],
	check(node, context) {
		if (
			/(?:^|\/)(?:tests?|fixtures?)(?:\/|$)/i.test(context.file) ||
			/\.(?:test|spec)\.[^/]+$/i.test(context.file)
		)
			return;
		const ts = context.ts;
		const object = node as import('typescript').ObjectLiteralExpression;
		const operationalVocabulary =
			/(?:health|ready|status|operations?|capacity|admission|tenant[-_.]?matrix)/i;
		const operationalOwner =
			operationalVocabulary.test(context.file) ||
			context.ancestors(node).some((parent) => {
				if (
					(ts.isVariableDeclaration(parent) ||
						ts.isPropertyAssignment(parent) ||
						ts.isFunctionDeclaration(parent) ||
						ts.isMethodDeclaration(parent)) &&
					parent.name !== undefined &&
					ts.isIdentifier(parent.name)
				)
					return operationalVocabulary.test(parent.name.text);
				return false;
			});
		if (!operationalOwner) return;
		const properties = new Map<string, import('typescript').Expression>();
		for (const property of object.properties) {
			if (!ts.isPropertyAssignment(property)) continue;
			const name = property.name;
			if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
				properties.set(name.text, property.initializer);
			}
		}
		const health = properties.get('health') ?? properties.get('status');
		const accepting = properties.get('accepting');
		const outstanding = properties.get('outstanding');
		const fixedHealth =
			health !== undefined && ts.isStringLiteral(health) && health.text === 'ready';
		const fixedAdmission =
			accepting?.kind === ts.SyntaxKind.TrueKeyword &&
			outstanding !== undefined &&
			ts.isNumericLiteral(outstanding) &&
			Number(outstanding.text) === 0;
		if (fixedHealth || fixedAdmission) {
			context.report(
				node,
				fixedHealth ? 'claim=readiness:ready' : 'claim=accepting:true,outstanding:0'
			);
		}
	}
});

/** Node owns dotenv grammar; a local parser is both incomplete and another concept to maintain. */
const customEnvParser = defineRule({
	id: 'NODE1',
	severity: 'error',
	summary: 'source reimplements Node built-in environment parsing',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	when: ['FunctionDeclaration', 'MethodDeclaration', 'VariableDeclaration', 'PropertyAssignment'],
	check(node, context) {
		const ts = context.ts;
		const callable = ts.isFunctionDeclaration(node)
			? node
			: ts.isMethodDeclaration(node)
				? node
				: ts.isVariableDeclaration(node) &&
					  node.initializer !== undefined &&
					  (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
					? node.initializer
					: ts.isPropertyAssignment(node) &&
						  (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
						? node.initializer
						: undefined;
		if (callable?.body === undefined) return;
		const declarationName = ts.isFunctionDeclaration(node)
			? (node.name?.text ?? '')
			: ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)
				? node.name.text
				: ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
					? node.name.text
					: ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)
						? node.name.text
						: '';
		if (
			!/(?:env|dotenv|environment)/i.test(declarationName) &&
			!/(?:^|\/)(?:scripts?|config|bootstrap|tests?\/support)(?:\/|$)/i.test(context.file)
		)
			return;
		let splitsLines = false;
		let parsesAssignment = false;
		const visit = (current: import('typescript').Node): void => {
			if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
				const method = current.expression.name.text;
				const [argument] = current.arguments;
				const argumentText = argument === undefined ? '' : context.text(argument);
				const assignmentText = `${context.text(current.expression.expression)} ${argumentText}`;
				if (
					method === 'split' &&
					argument !== undefined &&
					((ts.isStringLiteral(argument) && /(?:\r|\n|\\r|\\n)/.test(argument.text)) ||
						(ts.isRegularExpressionLiteral(argument) &&
							/\\[rn]|\[.*\\r.*\\n.*\]/.test(argument.text)))
				)
					splitsLines = true;
				if (
					['split', 'indexOf', 'startsWith', 'match', 'exec', 'search'].includes(method) &&
					assignmentText.includes('=')
				)
					parsesAssignment = true;
			}
			ts.forEachChild(current, visit);
		};
		visit(callable.body);
		const body = context.text(callable.body);
		const buildsEnvironment =
			/Object\.fromEntries|process\.env|\w+\s*\[[^\]]+\]\s*=|return\s+\w+/.test(body);
		if (splitsLines && parsesAssignment && buildsEnvironment)
			context.report(node, 'prefer=node:util.parseEnv');
	}
});

/** Node can recurse through an unpruned directory tree without a handwritten visitor. */
const customDirectoryRecursion = defineRule({
	id: 'NODE2',
	severity: 'error',
	summary: 'unpruned recursive directory walk reimplements node:fs',
	principles: ['simplicity', 'efficiency', 'no-bloat'],
	when: ['SourceFile'],
	check(node, context) {
		const ts = context.ts;
		type Callable = Readonly<{
			name: string;
			node: import('typescript').FunctionLikeDeclaration;
			body: import('typescript').ConciseBody;
		}>;
		const callables = new Map<string, Callable>();
		const collect = (current: import('typescript').Node): void => {
			let found: Callable | undefined;
			if (
				ts.isFunctionDeclaration(current) &&
				current.name !== undefined &&
				current.body !== undefined
			)
				found = { name: current.name.text, node: current, body: current.body };
			else if (
				ts.isMethodDeclaration(current) &&
				ts.isIdentifier(current.name) &&
				current.body !== undefined
			)
				found = { name: current.name.text, node: current, body: current.body };
			else if (
				ts.isVariableDeclaration(current) &&
				ts.isIdentifier(current.name) &&
				current.initializer !== undefined &&
				(ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
			)
				found = {
					name: current.name.text,
					node: current.initializer,
					body: current.initializer.body
				};
			if (found !== undefined) callables.set(found.name, found);
			ts.forEachChild(current, collect);
		};
		collect(node);
		const pruneVocabulary = /\b(?:exclude|ignore|prun|skip|descendInto|ignoredFile)\w*\b/i;
		const contains = (
			owner: import('typescript').Node,
			child: import('typescript').Node
		): boolean => owner.pos <= child.pos && owner.end >= child.end;
		const exitsBranch = (branch: import('typescript').Statement): boolean => {
			let exits = false;
			const visit = (current: import('typescript').Node): void => {
				if (
					ts.isContinueStatement(current) ||
					ts.isReturnStatement(current) ||
					ts.isThrowStatement(current)
				)
					exits = true;
				if (!exits) ts.forEachChild(current, visit);
			};
			visit(branch);
			return exits;
		};
		const conditionalPrunes = (
			conditional: import('typescript').IfStatement,
			call: import('typescript').CallExpression
		): boolean => {
			if (!pruneVocabulary.test(context.text(conditional.expression))) return false;
			if (conditional.elseStatement !== undefined && contains(conditional.elseStatement, call))
				return true;
			return (
				contains(conditional.thenStatement, call) &&
				/(?:!|===?\s*false|!==?\s*true)/.test(context.text(conditional.expression))
			);
		};
		const priorGuardPrunes = (
			block: import('typescript').Block,
			call: import('typescript').CallExpression
		): boolean => {
			const containingIndex = block.statements.findIndex((statement) => contains(statement, call));
			if (containingIndex < 0) return false;
			return block.statements
				.slice(0, containingIndex)
				.some(
					(statement) =>
						ts.isIfStatement(statement) &&
						pruneVocabulary.test(context.text(statement.expression)) &&
						exitsBranch(statement.thenStatement)
				);
		};
		const isPruned = (
			call: import('typescript').CallExpression,
			owner: import('typescript').FunctionLikeDeclaration
		): boolean => {
			const ancestors = context.ancestors(call);
			const ownerIndex = ancestors.indexOf(owner);
			return (ownerIndex < 0 ? ancestors : ancestors.slice(0, ownerIndex)).some(
				(ancestor) =>
					(ts.isIfStatement(ancestor) && conditionalPrunes(ancestor, call)) ||
					(ts.isBlock(ancestor) && priorGuardPrunes(ancestor, call))
			);
		};
		const readsDirectory = new Set<string>();
		const edges = new Map<string, Set<string>>();
		for (const callable of callables.values()) {
			const outgoing = new Set<string>();
			const visit = (current: import('typescript').Node): void => {
				if (ts.isCallExpression(current)) {
					const callee = context.calleeName(current) ?? '';
					if (/(?:^|\.)(?:readdir|readdirSync)$/.test(callee)) {
						const options = current.arguments[1];
						if (options === undefined || !/\brecursive\s*:\s*true\b/.test(context.text(options)))
							readsDirectory.add(callable.name);
					}
					const target = callee.split('.').at(-1);
					if (target !== undefined && callables.has(target) && !isPruned(current, callable.node))
						outgoing.add(target);
				}
				ts.forEachChild(current, visit);
			};
			visit(callable.body);
			edges.set(callable.name, outgoing);
		}
		const reachable = (from: string, target: string, seen: Set<string>): boolean => {
			for (const next of edges.get(from) ?? []) {
				if (next === target) return true;
				if (!seen.has(next)) {
					seen.add(next);
					if (reachable(next, target, seen)) return true;
				}
			}
			return false;
		};
		const reachesDirectoryRead = (from: string, seen: Set<string>): boolean => {
			if (readsDirectory.has(from)) return true;
			for (const next of edges.get(from) ?? []) {
				if (seen.has(next)) continue;
				seen.add(next);
				if (reachesDirectoryRead(next, seen)) return true;
			}
			return false;
		};
		for (const callable of callables.values()) {
			if (
				reachable(callable.name, callable.name, new Set([callable.name])) &&
				reachesDirectoryRead(callable.name, new Set([callable.name]))
			) {
				context.report(callable.node, `walker=${callable.name} prefer=readdir-recursive`);
				return;
			}
		}
	}
});

/** Node's CLI parser owns flag spelling, repeats, `--name=value`, and unknown-option rejection. */
const customArgumentParser = defineRule({
	id: 'NODE3',
	severity: 'error',
	summary: 'command entrypoint reimplements node:util parseArgs',
	principles: ['simplicity', 'straightforwardness', 'no-bloat'],
	when: ['SourceFile'],
	check(node, context) {
		const ts = context.ts;
		if (
			!/(?:^|\/)(?:scripts?|bin)(?:\/|$)|(?:cli|command)(?:[-_.][^/]*)?\.[cm]?[jt]s$/i.test(
				context.file
			)
		)
			return;
		const source = context.text(node);
		if (!/process\.argv/.test(source)) return;
		const optionNames = new Set<string>();
		let manualSearch = false;
		const visit = (current: import('typescript').Node): void => {
			if (
				ts.isStringLiteral(current) &&
				/^(?:--[a-z][a-z0-9-]*|-[a-zA-Z])(?:=|$)/.test(current.text)
			)
				optionNames.add(current.text.replace(/=.*/, ''));
			if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
				const method = current.expression.name.text;
				if (
					['find', 'findIndex', 'includes', 'indexOf', 'some', 'filter', 'startsWith'].includes(
						method
					) &&
					/(?:--[a-z]|-[a-zA-Z](?:['"`]|\b))/.test(context.text(current))
				)
					manualSearch = true;
			}
			if (
				ts.isBinaryExpression(current) &&
				/(?:--[a-z]|-[a-zA-Z](?:['"`]|\b))/.test(context.text(current))
			)
				manualSearch = true;
			if (
				ts.isCaseClause(current) &&
				ts.isStringLiteral(current.expression) &&
				/^(?:--[a-z]|-[a-zA-Z]$)/.test(current.expression.text)
			)
				manualSearch = true;
			ts.forEachChild(current, visit);
		};
		visit(node);
		if (
			manualSearch ||
			(optionNames.size > 0 &&
				/(?:const|function)\s+(?:flag|option|argumentValue|value|values)\b/.test(source))
		)
			context.report(node, `options=${optionNames.size} prefer=node:util.parseArgs`);
	}
});

/** A tool named glob must implement glob semantics, not substring search under another name. */
const fakeGlob = defineRule({
	id: 'NODE4',
	severity: 'error',
	summary: 'glob entrypoint uses substring matching instead of node:fs glob',
	principles: ['simplicity', 'straightforwardness', 'testability'],
	when: ['SourceFile'],
	check(node, context) {
		const ts = context.ts;
		let substringMatcher = false;
		const visit = (current: import('typescript').Node): void => {
			if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
				const owner = context.ancestors(current).find((ancestor) => ts.isFunctionLike(ancestor)) as
					import('typescript').FunctionLikeDeclaration | undefined;
				const parent = owner === undefined ? undefined : context.ancestors(owner)[0];
				const ownerName =
					owner !== undefined &&
					'name' in owner &&
					owner.name !== undefined &&
					ts.isIdentifier(owner.name)
						? owner.name.text
						: parent !== undefined &&
							  (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
							  ts.isIdentifier(parent.name)
							? parent.name.text
							: '';
				const ownerText = owner === undefined ? '' : context.text(owner);
				const globEntrypoint =
					/glob/i.test(ownerName) ||
					/['"]sandbox_glob['"]/.test(ownerText) ||
					/(?:^|\/)[^/]*glob[^/]*\.[cm]?[jt]sx?$/.test(context.file);
				if (
					globEntrypoint &&
					['includes', 'indexOf', 'search'].includes(current.expression.name.text) &&
					/(?:pattern|glob)/i.test(context.text(current))
				)
					substringMatcher = true;
			}
			if (!substringMatcher) ts.forEachChild(current, visit);
		};
		visit(node);
		if (substringMatcher) context.report(node, 'matcher=substring prefer=node:fs/promises.glob');
	}
});

/** Environment must be loaded before module-scope configuration captures `process.env`. */
const lateEnvironmentLoad = defineRule({
	id: 'BOOT1',
	severity: 'error',
	summary: 'environment file is loaded after configuration is captured',
	principles: ['straightforwardness', 'testability'],
	when: ['SourceFile'],
	check(node, context) {
		if (
			!/(?:^|\/)(?:scripts?|bin|bootstrap)(?:\/|$)|(?:server|bootstrap)\.[cm]?[jt]s$/i.test(
				context.file
			)
		)
			return;
		const ts = context.ts;
		const source = node as import('typescript').SourceFile;
		const importedLoaderNames = (
			statement: import('typescript').Statement
		): ReadonlyArray<string> => {
			if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) return [];
			const bindings = statement.importClause.namedBindings;
			if (bindings !== undefined && ts.isNamedImports(bindings))
				return bindings.elements
					.filter((element) => (element.propertyName?.text ?? element.name.text) === 'loadEnvFile')
					.map((element) => element.name.text);
			if (bindings !== undefined && ts.isNamespaceImport(bindings))
				return [`${bindings.name.text}.loadEnvFile`];
			return [];
		};
		const loaders = new Set(['loadEnvFile', ...source.statements.flatMap(importedLoaderNames)]);
		const callables = new Map<string, import('typescript').FunctionLikeDeclaration>();
		const collectCallable = (current: import('typescript').Node): void => {
			if (
				ts.isFunctionDeclaration(current) &&
				current.name !== undefined &&
				current.body !== undefined
			)
				callables.set(current.name.text, current);
			else if (
				ts.isVariableDeclaration(current) &&
				ts.isIdentifier(current.name) &&
				current.initializer !== undefined &&
				(ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
			)
				callables.set(current.name.text, current.initializer);
			ts.forEachChild(current, collectCallable);
		};
		collectCallable(source);
		type Event = Readonly<{ kind: 'capture' | 'load'; node: import('typescript').Node }>;
		const events: Array<Event> = [];
		let execute: (current: import('typescript').Node, active: Set<string>) => void;
		const executeCall = (
			current: import('typescript').CallExpression,
			active: Set<string>
		): void => {
			for (const argument of current.arguments) execute(argument, active);
			let invoked: import('typescript').Expression = current.expression;
			while (ts.isParenthesizedExpression(invoked)) invoked = invoked.expression;
			if (ts.isArrowFunction(invoked) || ts.isFunctionExpression(invoked))
				execute(invoked.body, active);
			const callee = context.calleeName(current) ?? '';
			if (loaders.has(callee)) events.push({ kind: 'load', node: current });
			const localName = callee.split('.').at(-1);
			if (localName === undefined) return;
			const local = callables.get(localName);
			if (local === undefined || active.has(localName)) return;
			active.add(localName);
			if (local.body !== undefined) execute(local.body, active);
			active.delete(localName);
		};
		execute = (current: import('typescript').Node, active: Set<string>): void => {
			if (ts.isFunctionDeclaration(current)) return;
			if (
				(ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
				!active.has(context.text(current))
			)
				return;
			if (
				ts.isPropertyAccessExpression(current) &&
				ts.isIdentifier(current.expression) &&
				current.expression.text === 'process' &&
				current.name.text === 'env'
			)
				events.push({ kind: 'capture', node: current });
			if (ts.isCallExpression(current)) {
				executeCall(current, active);
				return;
			}
			ts.forEachChild(current, (child) => execute(child, active));
		};
		for (const statement of source.statements) execute(statement, new Set());
		const firstLoad = events.findIndex((event) => event.kind === 'load');
		if (firstLoad < 0) return;
		const captured = events.slice(0, firstLoad).find((event) => event.kind === 'capture');
		if (captured !== undefined) context.report(captured.node, 'order=read-before-loadEnvFile');
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
	selfModuleEdge,
	ignoredPolicyIdentity,
	hardcodedOperationalState,
	customEnvParser,
	customDirectoryRecursion,
	customArgumentParser,
	fakeGlob,
	lateEnvironmentLoad,
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
