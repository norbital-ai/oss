import { posix } from 'node:path';
import { effectScope, runtimeEdgeAllowed } from './effect-scope.js';
/**
 * The built-in facts the pack YAML names (`fact: { name: … }`). Registered once, when the matcher loads.
 */
import ts from 'typescript';
import { Predicate } from 'effect';
import { memoised, registerFact, type FactContext } from './facts.js';
import { inlineCandidates } from './inline.js';
import { compile, type Bindings, type Matcher } from './matcher.js';
import { sourceImportsFrom } from './module-path.js';
import { guestReachable } from './guest-reachability.js';
import { importedCallTarget } from './call-target.js';

/** Runtime ownership follows a called import, not a sibling type/validation import. */
registerFact({
	name: 'usesImportedRuntime',
	parameters: ['from', 'symbol'],
	run: ({ source }, params) => {
		const from = params['from'];
		const symbol = params['symbol'];
		if (!Predicate.isString(from) || !Predicate.isString(symbol)) return false;
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

function boundName(context: FactContext, raw: unknown): string | undefined {
	if (!Predicate.isString(raw)) return declarationName(context.node);
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
	const name = (node as { name?: ts.Node }).name;
	return name !== undefined && ts.isIdentifier(name) ? name.text : undefined;
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

const TENANT_FACTORIES = new Set([
	'@norbital-ai/bolt.automation',
	'@norbital-ai/bolt.integration',
	'@norbital-ai/bolt.model'
]);
/** The generator bodies inside each factory's literal (its second argument), by property path; `*` is any key or element. */
const TENANT_BODIES: ReadonlyMap<string, readonly (readonly string[])[]> = new Map([
	['@norbital-ai/bolt.automation', [['run']]],
	['@norbital-ai/bolt.integration', [['test']]],
	[
		'@norbital-ai/bolt.model',
		[
			['create', 'transform'],
			['update', 'transform'],
			['delete', 'check'],
			['queries', '*', 'run'],
			['actions', '*', 'run'],
			['notify'],
			['syncs', '*', 'read'],
			['syncs', '*', 'write'],
			['syncs', '*', 'parser', '*', 'parse']
		]
	]
]);

/** Markdown is not an Effect-owned module: only a registered tenant body owns its async syntax. */
function documentedTenantBody({ node, source }: FactContext): boolean {
	const body = enclosingFunction(node);
	if (body === undefined) return false;
	// the property path from the literal down to the body: a property's name, `*` for an array element
	const path: string[] = [];
	let argument: ts.Node = body;
	let parent = body.parent;
	while (parent !== undefined && !ts.isCallExpression(parent)) {
		if (ts.isFunctionLike(parent)) return false;
		if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
			if (!ts.isIdentifier(parent.name) && !ts.isStringLiteral(parent.name)) return false;
			path.unshift(parent.name.text);
		} else if (ts.isArrayLiteralExpression(parent)) path.unshift('*');
		else if (!ts.isObjectLiteralExpression(parent) && !ts.isParenthesizedExpression(parent))
			return false;
		argument = parent;
		parent = parent.parent;
	}
	if (ts.isMethodDeclaration(body)) {
		if (!ts.isIdentifier(body.name) && !ts.isStringLiteral(body.name)) return false;
		path.push(body.name.text);
	}
	if (parent === undefined || !ts.isCallExpression(parent) || parent.arguments[1] !== argument)
		return false;
	const target = importedCallTarget(parent, source, /^@norbital-ai\/bolt$/, TENANT_FACTORIES);
	return (TENANT_BODIES.get(target ?? '') ?? []).some(
		(pattern) =>
			pattern.length === path.length && pattern.every((at, i) => at === '*' || at === path[i])
	);
}

function calleeText(node: ts.Node): string {
	if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return '';
	let target: ts.Expression = node.expression;
	while (ts.isParenthesizedExpression(target)) target = target.expression;
	if (ts.isIdentifier(target)) return target.text;
	if (ts.isPropertyAccessExpression(target)) return target.getText();
	return '';
}

/** A.3/B.6's durable callback uses the caller's context for each Cloudflare retry. */
function workflowStepBridge({ root, file, node }: FactContext): boolean {
	if (
		!posix.matchesGlob(posix.join(root, file), '**/analytics-reporter/src/steps.ts') ||
		!ts.isCallExpression(node) ||
		calleeText(node) !== 'Effect.runPromiseWith' ||
		node.arguments.length !== 1
	)
		return false;
	const context = node.arguments[0];
	const invocation = node.parent;
	if (
		context === undefined ||
		!ts.isIdentifier(context) ||
		!ts.isCallExpression(invocation) ||
		invocation.expression !== node ||
		invocation.arguments.length !== 1
	)
		return false;
	const effect = invocation.arguments[0];
	const callback = invocation.parent;
	if (
		effect === undefined ||
		!ts.isIdentifier(effect) ||
		!ts.isArrowFunction(callback) ||
		callback.body !== invocation ||
		callback.parameters.length !== 0
	)
		return false;
	const step = callback.parent;
	if (
		!ts.isCallExpression(step) ||
		!ts.isPropertyAccessExpression(step.expression) ||
		step.expression.name.text !== 'do' ||
		!ts.isIdentifier(step.expression.expression) ||
		step.arguments.length !== 3 ||
		step.arguments[2] !== callback
	)
		return false;
	const receiver = step.expression.expression.text;
	let captured = false;
	let implementation = false;
	for (let owner: ts.Node | undefined = step.parent; owner !== undefined; owner = owner.parent) {
		const capture = ts.isArrowFunction(owner) ? owner.parameters[0] : undefined;
		if (
			ts.isArrowFunction(owner) &&
			owner.parameters.length === 1 &&
			capture !== undefined &&
			ts.isIdentifier(capture.name) &&
			capture.name.text === context.text &&
			ts.isCallExpression(owner.parent) &&
			calleeText(owner.parent) === 'Effect.flatMap'
		) {
			const pipe = owner.parent.parent;
			captured =
				ts.isCallExpression(pipe) &&
				ts.isPropertyAccessExpression(pipe.expression) &&
				pipe.expression.name.text === 'pipe' &&
				ts.isCallExpression(pipe.expression.expression) &&
				calleeText(pipe.expression.expression) === 'Effect.context';
		}
		if (
			ts.isPropertyAssignment(owner) &&
			ts.isIdentifier(owner.name) &&
			owner.name.text === 'do' &&
			ts.isArrowFunction(owner.initializer) &&
			owner.initializer.parameters.length === 2
		) {
			const parameter = owner.initializer.parameters[1];
			const object = owner.parent;
			const layer = object.parent;
			implementation =
				parameter !== undefined &&
				ts.isIdentifier(parameter.name) &&
				parameter.name.text === effect.text &&
				ts.isObjectLiteralExpression(object) &&
				ts.isCallExpression(layer) &&
				calleeText(layer) === 'Layer.succeed' &&
				layer.arguments[1] === object &&
				layer.arguments[0] !== undefined &&
				ts.isIdentifier(layer.arguments[0]) &&
				layer.arguments[0].text === 'WorkflowSteps';
		}
		if (
			ts.isPropertyDeclaration(owner) &&
			ts.isIdentifier(owner.name) &&
			owner.name.text === 'layer' &&
			owner.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
			owner.initializer !== undefined &&
			ts.isArrowFunction(owner.initializer)
		) {
			const parameter = owner.initializer.parameters[0];
			const declaration = owner.parent;
			return (
				captured &&
				implementation &&
				parameter !== undefined &&
				ts.isIdentifier(parameter.name) &&
				parameter.name.text === receiver &&
				ts.isClassDeclaration(declaration) &&
				declaration.name?.text === 'WorkflowSteps'
			);
		}
	}
	return false;
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

/** An optional matcher parameter of `flowsInto`; anything but a matcher is a broken rule, not "absent". */
function asMatcher(parameter: string, value: unknown): Matcher | undefined {
	if (value === undefined) return undefined;
	if (!(Predicate.isString(value) || Predicate.isObject(value)))
		throw new Error(
			`norbital-doctor: fact "flowsInto" parameter "${parameter}" must be a pattern string or a matcher object`
		);
	return value as Matcher;
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
		const rows = memoised(context.source, 'inlineCandidates', () =>
			inlineCandidates(context.source)
		);
		const row = rows.find((candidate) => candidate.name === name);
		if (row === undefined) return false;
		if (Predicate.isString(params.candidate) && row.kind !== params.candidate) return false;
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
		const unless = Predicate.isString(params.unlessReceiver)
			? new RegExp(params.unlessReceiver)
			: undefined;
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
	optional: ['direct', 'imports'],
	run: (context, params) => {
		const expression = new RegExp(String(params.regex));
		const modules = Predicate.isString(params.imports) ? new RegExp(params.imports) : undefined;
		for (
			let current: ts.Node | undefined = context.node;
			current !== undefined;
			current = params.direct === true ? undefined : current.parent
		) {
			if (!ts.isCallExpression(current)) continue;
			const target =
				modules === undefined ? undefined : importedCallTarget(current, context.source, modules);
			if (expression.test(target ?? calleeText(current))) return true;
		}
		return false;
	}
});

registerFact({
	name: 'redundantGenerator',
	parameters: [],
	run: ({ node }) => {
		if (
			!ts.isCallExpression(node) ||
			calleeText(node) !== 'Effect.gen' ||
			node.arguments.length !== 1
		)
			return false;
		let fn = node.arguments[0];
		while (fn !== undefined && ts.isParenthesizedExpression(fn)) fn = fn.expression;
		if (
			fn === undefined ||
			!ts.isFunctionExpression(fn) ||
			fn.asteriskToken === undefined ||
			fn.name !== undefined ||
			fn.parameters.length !== 0 ||
			fn.body.statements.length !== 1
		)
			return false;
		const statement = fn.body.statements[0];
		if (statement === undefined || !ts.isReturnStatement(statement)) return false;
		let value = statement.expression;
		while (value !== undefined && ts.isParenthesizedExpression(value)) value = value.expression;
		const nestedYield = (current: ts.Node): boolean =>
			ts.isYieldExpression(current) ||
			(!ts.isFunctionLike(current) &&
				ts.forEachChild(current, (child) => (nestedYield(child) ? true : undefined)) === true);
		return (
			value !== undefined &&
			ts.isYieldExpression(value) &&
			value.asteriskToken !== undefined &&
			value.expression !== undefined &&
			!nestedYield(value.expression)
		);
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
		const sinkMatcher = asMatcher('sink', params.sink);
		const excludingMatcher = asMatcher('excluding', params.excluding);
		const owner = enclosingFunction(context.node);
		if (owner?.body === undefined) return false;
		const start = boundName(context, params.source) ?? declarationName(context.node);
		if (start === undefined) return false;
		const tracked = memoised(owner, `aliases:${start}`, () => aliasClosure(owner.body!, start));
		const sink = sinkMatcher === undefined ? undefined : compile(sinkMatcher);
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
	name: 'importsFrom',
	parameters: ['module'],
	run: (context, params) => sourceImportsFrom(context.source, String(params.module))
});

/** D13 permits native layout lifetimes only when this module has no data or Effect ownership. */
function presentationOnly({ file, source }: FactContext): boolean {
	if (!/\.svelte(?:\.[jt]s)?$/.test(file)) return false;
	return memoised(source, 'presentationOnly', () => {
		const dataImport =
			/^(?:\$bolt(?:\/|$)|@norbital-ai\/bolt(?:\/|$)|@norbital-ai\/ui\/effect(?:\/|\.|$))|(?:^|\/)(?:client\/(?:context|contract)|bolt(?:\.svelte)?)\.[jt]s$|(?:^\.\.?\/|\/)effect(?:\/index)?(?:\.[jt]s)?$/;
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
				continue;
			if (dataImport.test(statement.moduleSpecifier.text)) return false;
			const bindings = statement.importClause?.namedBindings;
			if (
				statement.moduleSpecifier.text === '@norbital-ai/ui' &&
				bindings !== undefined &&
				ts.isNamedImports(bindings) &&
				bindings.elements.some((binding) =>
					['provideBolt', 'useBolt', 'ViewBolt'].includes(
						(binding.propertyName ?? binding.name).text
					)
				)
			)
				return false;
		}
		const capabilities = new Set([
			'fetch',
			'EventSource',
			'WebSocket',
			'XMLHttpRequest',
			'localStorage',
			'sessionStorage',
			'indexedDB',
			'navigator',
			'Worker',
			'SharedWorker',
			'Notification',
			'FileReader',
			'MediaRecorder',
			'BroadcastChannel',
			'WebTransport',
			'RTCPeerConnection',
			'postMessage'
		]);
		let owned = false;
		const visit = (node: ts.Node): void => {
			if (owned || ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
			if (
				(ts.isIdentifier(node) && capabilities.has(node.text)) ||
				(ts.isElementAccessExpression(node) &&
					ts.isStringLiteral(node.argumentExpression) &&
					capabilities.has(node.argumentExpression.text))
			) {
				owned = true;
				return;
			}
			if (ts.isCallExpression(node)) {
				const target = importedCallTarget(
					node,
					source,
					/^(?:effect(?:\/|$)|@norbital-ai\/ui(?:\/|$)|\$bolt(?:\/|$))/
				);
				owned =
					/^effect(?:\.(?:Effect|ManagedRuntime|Runtime)|\/(?:Effect|ManagedRuntime|Runtime))(?:\.|$)/.test(
						target ?? ''
					) ||
					/^@norbital-ai\/ui\.(?:run|fork|query|live|attach)$/.test(target ?? '') ||
					/^(?:Effect|ManagedRuntime|Runtime)\./.test(calleeText(node)) ||
					/^(?:bolt|client|api|ctx)(?:\.[\w$]+)*\.(?:get|read|act|call|start|live|query|upload|download)$/.test(
						calleeText(node)
					);
			}
			if (!owned) ts.forEachChild(node, visit);
		};
		visit(source);
		return !owned;
	});
}

const EFFECT_BUILDERS = new Set(['effect.Effect.fn', 'effect/Effect.fn']);
const CATCHING_CALLS = new Set([
	'effect.Effect.try',
	'effect/Effect.try',
	'effect.Effect.tryPromise',
	'effect/Effect.tryPromise',
	'effect.Result.try',
	'effect/Result.try'
]);

/** Only the actual try callback catches its throw; an inner deferred callback has its own boundary. */
function effectThrowEscapes({ node, source }: FactContext): boolean {
	if (!ts.isThrowStatement(node)) return false;
	let nested = false;
	for (let current = node.parent; current !== undefined; current = current.parent) {
		if (!ts.isFunctionLike(current)) continue;
		let argument: ts.Node = current;
		while (ts.isParenthesizedExpression(argument.parent)) argument = argument.parent;
		const property = argument.parent;
		let catches = true;
		if (ts.isPropertyAssignment(property) && property.initializer === argument) {
			catches =
				(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
				property.name.text === 'try';
			argument = property.parent;
		} else if (ts.isMethodDeclaration(current) && ts.isObjectLiteralExpression(current.parent)) {
			catches =
				(ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)) &&
				current.name.text === 'try';
			argument = current.parent;
		}
		const parent = argument.parent;
		if (ts.isCallExpression(parent) && parent.arguments.some((value) => value === argument)) {
			const target = importedCallTarget(
				parent,
				source,
				/^effect(?:\/(?:Effect|Result))?$/,
				EFFECT_BUILDERS
			);
			if (target !== undefined) {
				if (CATCHING_CALLS.has(target) && parent.arguments[0] === argument && catches && !nested)
					return false;
				if (/^effect(?:\.Effect|\/Effect)\./.test(target)) return true;
			}
		}
		nested = true;
	}
	return false;
}

registerFact({ name: 'effectThrowEscapes', parameters: [], run: effectThrowEscapes });

registerFact({
	name: 'effectScope',
	parameters: [],
	run: (context) =>
		/\.md$/i.test(context.file)
			? documentedTenantBody(context)
			: effectScope(context.root, context.file) && !presentationOnly(context)
});

const EDGES = [
	'**/bolt/src/cli/main.ts',
	'**/bolt-server/src/main.ts',
	'**/bolt/src/decl/runtime/guest.ts',
	'**/bolt/src/protocol/host-api.ts',
	'**/bolt/src/shell/mount.ts',
	'**/ui/src/effect/index.ts',
	'**/env-cli/src/main.ts',
	'**/env-cli/src/local/serve-start.ts',
	'**/website/src/lib/server/runtime.ts',
	'**/analytics-reporter/src/index.ts',
	'scripts/*.ts',
	'**/oss/scripts/*.ts',
	'**/*.worker.ts'
];
registerFact({
	name: 'runtimeEdgeAllowed',
	parameters: [],
	run: (context) =>
		EDGES.some((pattern) => posix.matchesGlob(context.file, pattern)) ||
		runtimeEdgeAllowed(context.root, context.file) ||
		workflowStepBridge(context)
});
registerFact({
	name: 'guestReachable',
	parameters: [],
	run: guestReachable
});
registerFact({
	name: 'moduleScope',
	parameters: [],
	run: ({ node }) => {
		for (let parent = node.parent; parent !== undefined; parent = parent.parent)
			if (ts.isFunctionLike(parent)) return false;
		return true;
	}
});

const NEVER_REJECTING_PROMISES = ['navigator.serviceWorker.ready'];
registerFact({
	name: 'neverRejectingPromise',
	parameters: [],
	run: ({ node }) => {
		if (!ts.isCallExpression(node)) return false;
		const callback = node.arguments[0];
		if (callback === undefined || !ts.isArrowFunction(callback) || ts.isBlock(callback.body))
			return false;
		return NEVER_REJECTING_PROMISES.includes(callback.body.getText().trim());
	}
});
