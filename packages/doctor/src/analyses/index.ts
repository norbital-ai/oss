import ts from 'typescript';
import { Schema } from 'effect';
import { analyzeAst } from '../analysis/complexity.js';
import { memoised, registerFact, type FactContext } from '../facts.js';
import { compile, type Bindings, type Matcher } from '../matcher.js';
import {
	aliasCovering,
	moduleSpecifierOf,
	resolvesToDeclaringModule,
	sourceImportsFrom
} from '../module-path.js';
import { nameOf } from '../model.js';

const isString = Schema.is(Schema.String);

/** Runtime ownership follows a called import, not a sibling type/validation import. */
registerFact({
	name: 'usesImportedRuntime',
	parameters: ['from', 'symbol'],
	run: ({ source }, params) => {
		const from = params['from'];
		const symbol = params['symbol'];
		if (!isString(from) || !isString(symbol)) return false;
		return memoised(source, `usesImportedRuntime:${from}:${symbol}`, () => {
			const namespaces = new Set<string>();
			const functions = new Set<string>();
			for (const statement of source.statements) {
				if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
					continue;
				const clause = statement.importClause;
				if (clause == null || clause.isTypeOnly) continue;
				const bindings = clause.namedBindings;
				const module = statement.moduleSpecifier.text;
				if (bindings == null) continue;
				if (ts.isNamespaceImport(bindings)) {
					if (module === from) namespaces.add(`${bindings.name.text}.${symbol}`);
					if (module === `${from}/${symbol}`) namespaces.add(bindings.name.text);
					continue;
				}
				for (const binding of bindings.elements) {
					if (binding.isTypeOnly) continue;
					if (module === from && (binding.propertyName ?? binding.name).text === symbol)
						namespaces.add(binding.name.text);
					if (module === `${from}/${symbol}`) functions.add(binding.name.text);
				}
			}
			let used = false;
			const visit = (node: ts.Node): void => {
				if (used || ts.isTypeNode(node)) return;
				if (ts.isCallExpression(node)) {
					const callee = node.expression;
					used =
						(ts.isIdentifier(callee) && functions.has(callee.text)) ||
						(ts.isPropertyAccessExpression(callee) &&
							namespaces.has(callee.expression.getText(source)));
				}
				if (!used) ts.forEachChild(node, visit);
			};
			visit(source);
			return used;
		});
	}
});
// A matcher value is a string or any object; the original check accepted arrays too.
const isMatcherValue = Schema.is(
	Schema.Union([
		Schema.String,
		Schema.Record(Schema.String, Schema.Unknown),
		Schema.Array(Schema.Unknown)
	])
);

function boundName(context: FactContext, raw: unknown): string | undefined {
	if (!isString(raw)) return declarationName(context.node);
	const key = raw.startsWith('$') ? raw : `$${raw}`;
	const bound = context.bindings.get(key);
	if (bound !== undefined && ts.isIdentifier(bound)) return bound.text;
	if (raw === '$SELF' || raw === 'SELF') return declarationName(context.node);
	return raw.startsWith('$') ? declarationName(context.node) : raw;
}

function declarationName(node: ts.Node): string | undefined {
	if (
		(ts.isFunctionDeclaration(node) ||
			ts.isMethodDeclaration(node) ||
			ts.isVariableDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isClassDeclaration(node) ||
			ts.isInterfaceDeclaration(node) ||
			ts.isTypeAliasDeclaration(node)) &&
		node.name !== undefined &&
		ts.isIdentifier(node.name)
	)
		return node.name.text;
	if (ts.isVariableStatement(node)) {
		const first = node.declarationList.declarations[0];
		return first !== undefined && ts.isIdentifier(first.name) ? first.name.text : undefined;
	}
	return nameOf(node)?.text;
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (
			ts.isFunctionDeclaration(current) ||
			ts.isMethodDeclaration(current) ||
			ts.isConstructorDeclaration(current) ||
			ts.isGetAccessorDeclaration(current) ||
			ts.isSetAccessorDeclaration(current) ||
			ts.isFunctionExpression(current) ||
			ts.isArrowFunction(current)
		)
			return current;
	}
	return undefined;
}

function calleeText(node: ts.Node): string {
	if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return '';
	const target = node.expression;
	if (ts.isIdentifier(target)) return target.text;
	if (ts.isPropertyAccessExpression(target)) return target.getText();
	return '';
}

function nestingOf(fn: ts.FunctionLikeDeclaration): number {
	const body = fn.body;
	if (body === undefined) return 0;
	let deepest = 0;
	const visit = (current: ts.Node, depth: number): void => {
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
		if (ts.isFunctionLike(current) && current !== fn) return;
		ts.forEachChild(current, (child) => visit(child, next));
	};
	visit(body, 0);
	return deepest;
}

type Callable = Readonly<{
	name: string;
	node: ts.FunctionLikeDeclaration;
	body: ts.ConciseBody;
}>;

type CallGraph = Readonly<{
	callables: ReadonlyMap<string, Callable>;
	edges: ReadonlyMap<string, ReadonlySet<string>>;
	readsDirectory: ReadonlySet<string>;
}>;

function buildCallGraph(source: ts.SourceFile, prune: RegExp): CallGraph {
	const callables = new Map<string, Callable>();
	const collect = (current: ts.Node): void => {
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
	collect(source);
	const contains = (owner: ts.Node, child: ts.Node): boolean =>
		owner.pos <= child.pos && owner.end >= child.end;
	const exitsBranch = (branch: ts.Statement): boolean => {
		let exits = false;
		const visit = (current: ts.Node): void => {
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
	const textOf = (node: ts.Node): string => node.getText(source);
	const isPruned = (call: ts.CallExpression, owner: ts.FunctionLikeDeclaration): boolean => {
		const chain: Array<ts.Node> = [];
		for (let parent = call.parent; parent !== undefined && parent !== owner; parent = parent.parent)
			chain.push(parent);
		return chain.some((ancestor) => {
			if (ts.isIfStatement(ancestor)) {
				if (!prune.test(textOf(ancestor.expression))) return false;
				if (ancestor.elseStatement !== undefined && contains(ancestor.elseStatement, call))
					return true;
				return (
					contains(ancestor.thenStatement, call) &&
					/(?:!|===?\s*false|!==?\s*true)/.test(textOf(ancestor.expression))
				);
			}
			if (ts.isBlock(ancestor)) {
				const index = ancestor.statements.findIndex((statement) => contains(statement, call));
				if (index < 0) return false;
				return ancestor.statements
					.slice(0, index)
					.some(
						(statement) =>
							ts.isIfStatement(statement) &&
							prune.test(textOf(statement.expression)) &&
							exitsBranch(statement.thenStatement)
					);
			}
			return false;
		});
	};
	const readsDirectory = new Set<string>();
	const edges = new Map<string, Set<string>>();
	for (const callable of callables.values()) {
		const outgoing = new Set<string>();
		const visit = (current: ts.Node): void => {
			if (ts.isCallExpression(current)) {
				const callee = calleeText(current);
				if (/(?:^|\.)(?:readdir|readdirSync)$/.test(callee)) {
					const options = current.arguments[1];
					if (options === undefined || !/\brecursive\s*:\s*true\b/.test(textOf(options)))
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
	return { callables, edges, readsDirectory };
}

function reachable(
	edges: ReadonlyMap<string, ReadonlySet<string>>,
	from: string,
	target: string,
	seen: Set<string>
): boolean {
	for (const next of edges.get(from) ?? []) {
		if (next === target) return true;
		if (!seen.has(next)) {
			seen.add(next);
			if (reachable(edges, next, target, seen)) return true;
		}
	}
	return false;
}

function reachesSet(
	edges: ReadonlyMap<string, ReadonlySet<string>>,
	seeds: ReadonlySet<string>,
	from: string,
	seen: Set<string>
): boolean {
	if (seeds.has(from)) return true;
	for (const next of edges.get(from) ?? []) {
		if (seen.has(next)) continue;
		seen.add(next);
		if (reachesSet(edges, seeds, next, seen)) return true;
	}
	return false;
}

function ownerParts(node: ts.Node, file: string): ReadonlyArray<string> {
	const parts = [file];
	for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
		if (
			(ts.isVariableDeclaration(current) ||
				ts.isPropertyAssignment(current) ||
				ts.isFunctionDeclaration(current) ||
				ts.isMethodDeclaration(current) ||
				ts.isClassDeclaration(current) ||
				ts.isInterfaceDeclaration(current) ||
				ts.isTypeAliasDeclaration(current)) &&
			current.name !== undefined &&
			ts.isIdentifier(current.name)
		)
			parts.push(current.name.text);
	}
	return parts;
}

function aliasClosure(owner: ts.Node, start: string): ReadonlySet<string> {
	const tracked = new Set([start]);
	let added = true;
	while (added) {
		added = false;
		const collect = (current: ts.Node): void => {
			if (
				ts.isVariableDeclaration(current) &&
				ts.isIdentifier(current.name) &&
				current.initializer !== undefined
			) {
				let reads = false;
				const inspect = (candidate: ts.Node): void => {
					if (ts.isIdentifier(candidate) && tracked.has(candidate.text)) reads = true;
					if (!reads) ts.forEachChild(candidate, inspect);
				};
				inspect(current.initializer);
				if (reads && !tracked.has(current.name.text)) {
					tracked.add(current.name.text);
					added = true;
				}
			}
			ts.forEachChild(current, collect);
		};
		collect(owner);
	}
	return tracked;
}

function asMatcher(value: unknown): Matcher | undefined {
	return isMatcherValue(value) ? (value as Matcher) : undefined;
}

registerFact({
	name: 'nestingDepth',
	parameters: ['atLeast'],
	run: (context, params) => {
		if (!ts.isFunctionLike(context.node)) return false;
		const depth = memoised(context.node, 'nestingDepth', () =>
			nestingOf(context.node as ts.FunctionLikeDeclaration)
		);
		return depth >= Number(params.atLeast);
	}
});

registerFact({
	name: 'callSites',
	parameters: [],
	optional: ['of', 'exactly', 'candidate'],
	run: (context, params) => {
		const name = boundName(context, params.of);
		if (name === undefined) return false;
		const rows = memoised(
			context.source,
			'inlineCandidates',
			() => analyzeAst(context.file, context.source.getFullText()).inlineCandidates
		);
		const row = rows.find((candidate) => candidate.name === name);
		if (row === undefined) return false;
		if (isString(params.candidate) && row.kind !== params.candidate) return false;
		if (params.exactly !== undefined && Number(params.exactly) !== 1) return false;
		return true;
	}
});

registerFact({
	name: 'enclosingOwnerMatches',
	parameters: ['regex'],
	run: (context, params) => {
		const expression = new RegExp(String(params.regex));
		return ownerParts(context.node, context.file).some((part) => expression.test(part));
	}
});

registerFact({
	name: 'enclosingCallChain',
	parameters: ['regex'],
	optional: ['unlessReceiver'],
	run: (context, params) => {
		const method = new RegExp(String(params.regex));
		const unless = isString(params.unlessReceiver) ? new RegExp(params.unlessReceiver) : undefined;
		for (let current = context.node.parent; current !== undefined; current = current.parent) {
			if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression))
				continue;
			const receiver = current.expression.expression;
			if (unless !== undefined && ts.isIdentifier(receiver) && unless.test(receiver.text)) continue;
			if (method.test(current.expression.name.text)) return true;
		}
		return false;
	}
});

registerFact({
	name: 'calleeMatches',
	parameters: ['regex'],
	run: (context, params) => {
		const expression = new RegExp(String(params.regex));
		for (
			let current: ts.Node | undefined = context.node;
			current !== undefined;
			current = current.parent
		) {
			if (ts.isCallExpression(current) && expression.test(calleeText(current))) return true;
		}
		return false;
	}
});

registerFact({
	name: 'bindingMutatedInFunction',
	parameters: [],
	run: (context) => {
		const declared = context.bindings.get('$NAME');
		if (declared === undefined || !ts.isIdentifier(declared)) return false;
		const identifier = declared.text;
		return memoised(context.source, `mutated:${identifier}`, () => {
			let mutated = false;
			const visit = (current: ts.Node): void => {
				if (mutated) return;
				if (
					ts.isBinaryExpression(current) &&
					current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
					ts.isIdentifier(current.left) &&
					current.left.text === identifier
				)
					for (let owner = current.parent; owner !== undefined; owner = owner.parent)
						if (
							ts.isFunctionDeclaration(owner) ||
							ts.isArrowFunction(owner) ||
							ts.isMethodDeclaration(owner)
						) {
							mutated = true;
							return;
						}
				ts.forEachChild(current, visit);
			};
			visit(context.source);
			return mutated;
		});
	}
});

registerFact({
	name: 'flowsInto',
	parameters: [],
	optional: ['source', 'sink', 'excluding'],
	run: (context, params) => {
		const owner = enclosingFunction(context.node);
		if (owner?.body === undefined) return false;
		const start = boundName(context, params.source) ?? declarationName(context.node);
		if (start === undefined) return false;
		const tracked = memoised(owner, `aliases:${start}`, () => aliasClosure(owner.body!, start));
		const sinkMatcher = asMatcher(params.sink);
		const sink = sinkMatcher === undefined ? undefined : compile(sinkMatcher);
		const excludingMatcher = asMatcher(params.excluding);
		const excluding = excludingMatcher === undefined ? undefined : compile(excludingMatcher);
		const contains = (parent: ts.Node, child: ts.Node): boolean =>
			parent.pos <= child.pos && parent.end >= child.end;
		const reportsFlow = (chain: ReadonlyArray<ts.Node>, current: ts.Node): boolean => {
			const observed =
				excluding !== undefined &&
				chain.some((ancestor) => excluding.run(ancestor, context.source, new Map() as Bindings));
			if (observed) return false;
			if (sink !== undefined)
				return chain.some((ancestor) => sink.run(ancestor, context.source, new Map() as Bindings));
			return chain.some(
				(ancestor) =>
					(ts.isCallExpression(ancestor) &&
						ancestor.arguments.some((argument) => contains(argument, current))) ||
					ts.isBinaryExpression(ancestor) ||
					ts.isElementAccessExpression(ancestor) ||
					(ts.isIfStatement(ancestor) && contains(ancestor.expression, current)) ||
					(ts.isConditionalExpression(ancestor) && contains(ancestor.condition, current)) ||
					(ts.isSwitchStatement(ancestor) && contains(ancestor.expression, current))
			);
		};
		let found = false;
		const visit = (current: ts.Node): void => {
			if (found) return;
			if (ts.isIdentifier(current) && tracked.has(current.text)) {
				const chain: Array<ts.Node> = [];
				for (
					let parent = current.parent;
					parent !== undefined && parent !== owner;
					parent = parent.parent
				)
					chain.push(parent);
				if (reportsFlow(chain, current)) found = true;
			}
			if (!found) ts.forEachChild(current, visit);
		};
		visit(owner.body);
		return found;
	}
});

registerFact({
	name: 'callGraphCycle',
	parameters: [],
	optional: ['through', 'prune'],
	run: (context, params) => {
		const prune = new RegExp(
			isString(params.prune)
				? params.prune
				: '\\b(?:exclude|ignore|prun|skip|descendInto|ignoredFile)\\w*\\b',
			'i'
		);
		const graph = memoised(context.source, `callGraph:${prune.source}`, () =>
			buildCallGraph(context.source, prune)
		);
		const name = boundName(context, params.through) ?? declarationName(context.node);
		if (name === undefined || !graph.callables.has(name)) return false;
		return (
			reachable(graph.edges, name, name, new Set([name])) &&
			reachesSet(graph.edges, graph.readsDirectory, name, new Set([name]))
		);
	}
});

registerFact({
	name: 'reaches',
	parameters: ['to'],
	optional: ['from'],
	run: (context, params) => {
		const name = boundName(context, params.from) ?? declarationName(context.node);
		if (name === undefined) return false;
		const target = asMatcher(params.to);
		if (target === undefined) return false;
		const compiled = compile(target);
		const graph = memoised(context.source, 'callGraph:default', () =>
			buildCallGraph(context.source, /$^/)
		);
		const seeds = new Set<string>();
		for (const callable of graph.callables.values()) {
			let hit = false;
			const visit = (current: ts.Node): void => {
				if (hit) return;
				if (compiled.run(current, context.source, new Map() as Bindings)) hit = true;
				if (!hit) ts.forEachChild(current, visit);
			};
			visit(callable.body);
			if (hit) seeds.add(callable.name);
		}
		return reachesSet(graph.edges, seeds, name, new Set([name])) || seeds.has(name);
	}
});

registerFact({
	name: 'evaluatedBefore',
	parameters: ['other'],
	optional: ['subject'],
	run: (context, params) => {
		const other = asMatcher(params.other);
		if (other === undefined) return false;
		const compiled = compile(other);
		let otherPos = Number.POSITIVE_INFINITY;
		const visit = (current: ts.Node): void => {
			if (compiled.run(current, context.source, new Map() as Bindings))
				otherPos = Math.min(otherPos, current.getStart(context.source));
			ts.forEachChild(current, visit);
		};
		visit(context.source);
		return context.node.getStart(context.source) < otherPos;
	}
});

registerFact({
	name: 'importsFrom',
	parameters: ['module'],
	run: (context, params) => sourceImportsFrom(context.source, String(params.module))
});

registerFact({
	name: 'resolvesToSelf',
	parameters: [],
	run: (context) => {
		const specifier = moduleSpecifierOf(context.node);
		return (
			specifier !== undefined && resolvesToDeclaringModule(context.file, context.root, specifier)
		);
	}
});

registerFact({
	name: 'aliasCovered',
	parameters: [],
	run: (context) => {
		const specifier = moduleSpecifierOf(context.node);
		return (
			specifier !== undefined && aliasCovering(context.root, context.file, specifier) !== undefined
		);
	}
});

type OpenDomainShape = 'comparison' | 'membership' | 'dispatch';

function namesEntity(node: ts.PropertyAccessExpression, entities: RegExp): boolean {
	const parts: Array<string> = [];
	let current: ts.Expression = node.expression;
	while (ts.isPropertyAccessExpression(current)) {
		parts.push(current.name.text);
		current = current.expression;
	}
	if (ts.isIdentifier(current)) parts.push(current.text);
	return parts.some((part) => {
		const normalized = part.replace(/^(?:selected|current|active|the)/i, '');
		return entities.test(normalized.toLowerCase()) || entities.test(part.toLowerCase());
	});
}

function openDomainProperty(
	node: ts.Node,
	properties: RegExp,
	entities: RegExp
): string | undefined {
	if (!ts.isPropertyAccessExpression(node)) return undefined;
	const property = node.name.text;
	if (!properties.test(property)) return undefined;
	return namesEntity(node, entities) ? property : undefined;
}

function openDomainComparison(node: ts.Node, properties: RegExp, entities: RegExp): boolean {
	if (!ts.isBinaryExpression(node)) return false;
	const operator = node.operatorToken.kind;
	if (
		operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
		operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken &&
		operator !== ts.SyntaxKind.EqualsEqualsToken &&
		operator !== ts.SyntaxKind.ExclamationEqualsToken
	)
		return false;
	for (const [subject, other] of [
		[node.left, node.right],
		[node.right, node.left]
	] as const) {
		if (openDomainProperty(subject, properties, entities) === undefined) continue;
		if (!ts.isStringLiteral(other) && !ts.isNoSubstitutionTemplateLiteral(other)) continue;
		if (other.text === '') continue;
		return true;
	}
	return false;
}

function openDomainMembership(node: ts.Node, properties: RegExp, entities: RegExp): boolean {
	if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
	if (!['includes', 'indexOf', 'has'].includes(node.expression.name.text)) return false;
	const argument = node.arguments[0];
	if (argument === undefined || openDomainProperty(argument, properties, entities) === undefined)
		return false;
	const receiver = node.expression.expression;
	return (
		ts.isArrayLiteralExpression(receiver) &&
		receiver.elements.some((element) => ts.isStringLiteral(element))
	);
}

registerFact({
	name: 'openDomainIdentifier',
	parameters: ['properties', 'entities', 'shape'],
	run: (context, params) => {
		const properties = new RegExp(String(params.properties));
		const entities = new RegExp(String(params.entities));
		const shape = String(params.shape);
		if (shape !== 'comparison' && shape !== 'membership' && shape !== 'dispatch')
			throw new Error(`norbital-doctor: fact "openDomainIdentifier" unknown shape "${shape}"`);
		const kind: OpenDomainShape = shape;
		switch (kind) {
			case 'comparison':
				return openDomainComparison(context.node, properties, entities);
			case 'membership':
				return openDomainMembership(context.node, properties, entities);
			case 'dispatch':
				return (
					ts.isSwitchStatement(context.node) &&
					openDomainProperty(context.node.expression, properties, entities) !== undefined
				);
			default: {
				const _exhaustive: never = kind;
				return _exhaustive;
			}
		}
	}
});
