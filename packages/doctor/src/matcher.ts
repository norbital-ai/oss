// repository-health:allow SEM_PARALLEL -- matcher is the engine pattern.ts drives; one pipeline, two phases.
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import ts from 'typescript';
import { evaluateFact } from './facts.js';
import {
	aliasCovering,
	moduleSpecifierOf,
	resolvesToDeclaringModule,
	sourceImportsFrom
} from './module-path.js';
import type { NodeKind } from './rules.js';

type MatchHost = Readonly<{ root: string; file: string }>;

const hosts = new WeakMap<ts.SourceFile, MatchHost>();

export function bindMatchHost(
	source: ts.SourceFile,
	host: Readonly<{ root: string; file: string }>
): void {
	hosts.set(source, host);
}

export type MatchResult = Readonly<{ matched: boolean; bindings: ReadonlyMap<string, string> }>;

export type StopBy = 'neighbor' | 'end' | Matcher;

export type Strictness = 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature' | 'template';

export type NthChild =
	| number
	| string
	| Readonly<{
			position: number | string;
			ofRule?: Matcher | undefined;
			reverse?: boolean | undefined;
	  }>;

export type Position = Readonly<{ line: number; column: number }>;
export type Range = Readonly<{ start: Position; end: Position }>;

export type PatternStyle =
	| string
	| Readonly<{
			context: string;
			selector?: NodeKind | undefined;
			strictness?: Strictness | undefined;
	  }>;

export type Matcher =
	| string
	| Readonly<{ pattern: PatternStyle }>
	| Readonly<{ kind: NodeKind }>
	| Readonly<{ regex: string; on?: string | undefined }>
	| Readonly<{ nthChild: NthChild }>
	| Readonly<{ range: Range }>
	| Readonly<{ inside: Matcher; stopBy?: StopBy | undefined; field?: string | undefined }>
	| Readonly<{ has: Matcher; stopBy?: StopBy | undefined; field?: string | undefined }>
	| Readonly<{ follows: Matcher; stopBy?: StopBy | undefined }>
	| Readonly<{ precedes: Matcher; stopBy?: StopBy | undefined }>
	| Readonly<{ all: ReadonlyArray<Matcher> }>
	| Readonly<{ any: ReadonlyArray<Matcher> }>
	| Readonly<{ not: Matcher }>
	| Readonly<{ matches: string }>
	| Readonly<{ atLeast: number; of: ReadonlyArray<Matcher> }>
	| Readonly<{ selfModule: true }>
	| Readonly<{ aliasCovered: true }>
	| Readonly<{ importsFrom: string }>
	| Readonly<{ count: Readonly<{ min: number; of: Matcher }> }>
	| Readonly<{ calls: Readonly<{ of: string; exactly: number }> }>
	| Readonly<{ fact: Readonly<{ name: string }> & Readonly<Record<string, unknown>> }>;

export type Utils = Readonly<Record<string, Matcher>>;

export type Constraints = Readonly<Record<string, Matcher>>;

export type Bindings = Map<string, ts.Node>;

const METAVARIABLE = /^\$[A-Z][A-Z0-9_]*$/;

const utilities = new Map<string, Compiled>();

export function withUtils<T>(utils: Utils, compileTree: () => T): T {
	const previous = new Map(utilities);
	for (const [name, rule] of Object.entries(utils)) {
		let resolved: Compiled | undefined;
		utilities.set(name, {
			kinds: undefined,
			run: (node, source, bindings) => (resolved ??= compile(rule)).run(node, source, bindings)
		});
	}
	const outcome = Effect.runSync(Effect.result(Effect.try(() => compileTree())));
	utilities.clear();
	for (const [name, value] of previous) utilities.set(name, value);
	return Result.getOrElse(outcome, (error) => {
		throw error;
	});
}

function findKind(node: ts.Node, kind: NodeKind): ts.Node | undefined {
	const wanted = ts.SyntaxKind[kind];
	if (unwrap(node).kind === wanted) return unwrap(node);
	for (const child of children(node)) {
		const found = findKind(child, kind);
		if (found !== undefined) return found;
	}
	return undefined;
}

function parseAnB(described: number | string): (position: number) => boolean {
	if (typeof described === 'number') return (position) => position === described;
	const text = described.trim().toLowerCase();
	if (text === 'odd') return (position) => position % 2 === 1;
	if (text === 'even') return (position) => position % 2 === 0;
	const match = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(text);
	if (match === null) {
		const literal = Number(text);
		if (!Number.isFinite(literal))
			throw new Error(`norbital-doctor: nthChild cannot parse "${described}"`);
		return (position) => position === literal;
	}
	const rawA = match[1] ?? '';
	const a = rawA === '' || rawA === '+' ? 1 : rawA === '-' ? -1 : Number(rawA);
	const b = match[2] === undefined ? 0 : Number(match[2].replace(/\s+/g, ''));
	return (position) => {
		if (a === 0) return position === b;
		const n = (position - b) / a;
		return Number.isInteger(n) && n >= 0;
	};
}

export function parsePattern(pattern: string): ts.Node {
	const source = ts.createSourceFile(
		'pattern.ts',
		pattern.replace(/\$\.\.\.([A-Z][A-Z0-9_]*)/g, '...$1'),
		ts.ScriptTarget.Latest,
		true
	);
	const [first] = source.statements;
	if (first === undefined)
		throw new Error(`norbital-doctor: empty pattern ${JSON.stringify(pattern)}`);
	return ts.isExpressionStatement(first) ? first.expression : first;
}

const VARIABLE_LIST_FLAGS =
	ts.NodeFlags.Const | ts.NodeFlags.Let | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;

function sameUnvisitedPunctuation(pattern: ts.Node, target: ts.Node): boolean {
	if (ts.isBinaryExpression(pattern) && ts.isBinaryExpression(target))
		return pattern.operatorToken.kind === target.operatorToken.kind;
	if (ts.isPrefixUnaryExpression(pattern) && ts.isPrefixUnaryExpression(target))
		return pattern.operator === target.operator;
	if (ts.isPostfixUnaryExpression(pattern) && ts.isPostfixUnaryExpression(target))
		return pattern.operator === target.operator;
	if (ts.isPropertyAccessExpression(pattern) && ts.isPropertyAccessExpression(target))
		return (pattern.questionDotToken !== undefined) === (target.questionDotToken !== undefined);
	if (ts.isElementAccessExpression(pattern) && ts.isElementAccessExpression(target))
		return (pattern.questionDotToken !== undefined) === (target.questionDotToken !== undefined);
	if (ts.isCallExpression(pattern) && ts.isCallExpression(target))
		return (pattern.questionDotToken !== undefined) === (target.questionDotToken !== undefined);
	if (ts.isVariableDeclarationList(pattern) && ts.isVariableDeclarationList(target))
		return (pattern.flags & VARIABLE_LIST_FLAGS) === (target.flags & VARIABLE_LIST_FLAGS);
	return true;
}

function unwrap(node: ts.Node): ts.Node {
	let current = node;
	while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
		current = current.expression;
	return current;
}

function children(node: ts.Node): ReadonlyArray<ts.Node> {
	const collected: Array<ts.Node> = [];
	ts.forEachChild(node, (child) => {
		collected.push(child);
	});
	return collected;
}

const NOT_A_FIELD: ReadonlySet<string> = new Set([
	'parent',
	'original',
	'symbol',
	'locals',
	'nextContainer',
	'flowNode',
	'emitNode',
	'jsDoc',
	'jsDocCache'
]);

function fieldsOf(node: ts.Node): ReadonlyMap<string, ReadonlyArray<ts.Node>> {
	const visited = new Set<ts.Node>();
	ts.forEachChild(
		node,
		(child) => {
			visited.add(child);
		},
		(array) => {
			for (const child of array) visited.add(child);
		}
	);
	const fields = new Map<string, ReadonlyArray<ts.Node>>();
	for (const [key, value] of Object.entries(node)) {
		if (NOT_A_FIELD.has(key)) continue;
		if (Array.isArray(value)) {
			if (value.every((item) => visited.has(item as ts.Node)))
				fields.set(key, value as ReadonlyArray<ts.Node>);
			continue;
		}
		if (value !== null && typeof value === 'object' && visited.has(value as ts.Node))
			fields.set(key, [value as ts.Node]);
	}
	return fields;
}

function textOf(node: ts.Node, source: ts.SourceFile): string {
	const text = Effect.runSync(
		Effect.result(Effect.try(() => node.getText(source).replace(/\s+/g, ' ').trim()))
	);
	return Result.getOrElse(text, () => '');
}

function variadicName(node: ts.Node): string | undefined {
	if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
		const inner = node.expression;
		if (ts.isIdentifier(inner) && /^[A-Z][A-Z0-9_]*$/.test(inner.text)) return inner.text;
	}
	if (ts.isIdentifier(node) && /^\$\.\.\.[A-Z][A-Z0-9_]*$/.test(node.text)) return node.text;
	return undefined;
}

function matchShape(
	pattern: ts.Node,
	target: ts.Node,
	source: ts.SourceFile,
	bindings: Bindings,
	strictness: Strictness = 'smart'
): boolean {
	const patternNode = unwrap(pattern);
	const targetNode = unwrap(target);

	const asMetavariable =
		ts.isTypeReferenceNode(patternNode) &&
		ts.isIdentifier(patternNode.typeName) &&
		METAVARIABLE.test(patternNode.typeName.text)
			? patternNode.typeName
			: patternNode;

	if (ts.isIdentifier(asMetavariable) && METAVARIABLE.test(asMetavariable.text)) {
		const name = asMetavariable.text;
		const seen = bindings.get(name);
		if (seen !== undefined) return textOf(seen, source) === textOf(targetNode, source);
		bindings.set(name, targetNode);
		return true;
	}

	if (strictness !== 'template' && patternNode.kind !== targetNode.kind) return false;
	if (strictness !== 'template' && !sameUnvisitedPunctuation(patternNode, targetNode)) return false;
	const comparesText = strictness !== 'signature';
	if (ts.isIdentifier(patternNode) && ts.isIdentifier(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (ts.isStringLiteralLike(patternNode) && ts.isStringLiteralLike(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (ts.isNumericLiteral(patternNode) && ts.isNumericLiteral(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (strictness === 'template') return textOf(patternNode, source) === textOf(targetNode, source);

	const patternFields = fieldsOf(patternNode);
	const targetFields = fieldsOf(targetNode);
	for (const [name, patternChildren] of patternFields) {
		const targetChildren = targetFields.get(name);
		if (targetChildren === undefined) return false;
		if (name === 'modifiers' && strictness !== 'cst') {
			const present = new Set(targetChildren.map((child) => child.kind));
			if (!patternChildren.every((child) => present.has(child.kind))) return false;
			continue;
		}
		if (!matchList(patternChildren, targetChildren, source, bindings, strictness)) return false;
	}
	if (strictness === 'cst')
		for (const name of targetFields.keys()) if (!patternFields.has(name)) return false;
	return true;
}

function matchList(
	patternChildren: ReadonlyArray<ts.Node>,
	targetChildren: ReadonlyArray<ts.Node>,
	source: ts.SourceFile,
	bindings: Bindings,
	strictness: Strictness
): boolean {
	const variadic = patternChildren.findIndex((child) => variadicName(child) !== undefined);
	if (variadic >= 0) {
		const before = patternChildren.slice(0, variadic);
		const after = patternChildren.slice(variadic + 1);
		if (targetChildren.length < before.length + after.length) return false;
		for (const [index, child] of before.entries())
			if (!matchShape(child, targetChildren[index]!, source, bindings, strictness)) return false;
		for (const [offset, child] of after.entries()) {
			const target = targetChildren[targetChildren.length - after.length + offset]!;
			if (!matchShape(child, target, source, bindings, strictness)) return false;
		}
		return true;
	}
	if (patternChildren.length !== targetChildren.length) return false;
	return patternChildren.every((child, index) =>
		matchShape(child, targetChildren[index]!, source, bindings, strictness)
	);
}

function withinStop(
	all: ReadonlyArray<ts.Node>,
	stop: StopBy,
	source: ts.SourceFile,
	bindings: Bindings
): ReadonlyArray<ts.Node> {
	if (stop === 'neighbor') return all.slice(0, 1);
	if (stop === 'end') return all;
	const boundary = compile(stop);
	const taken: Array<ts.Node> = [];
	for (const candidate of all) {
		taken.push(candidate);
		if (boundary.run(candidate, source, new Map(bindings))) break;
	}
	return taken;
}

function ancestors(node: ts.Node): ReadonlyArray<ts.Node> {
	const chain: Array<ts.Node> = [];
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) chain.push(parent);
	return chain;
}

function descendants(node: ts.Node): ReadonlyArray<ts.Node> {
	const found: Array<ts.Node> = [];
	const queue: Array<ts.Node> = [...children(node)];
	while (queue.length > 0) {
		const current = queue.shift()!;
		found.push(current);
		queue.push(...children(current));
	}
	return found;
}

function namedProperty(parent: object, field: string): unknown {
	return Reflect.get(parent, field);
}

function occupiesField(parent: ts.Node, node: ts.Node, field: string): boolean {
	const value = namedProperty(parent, field);
	if (value === node) return true;
	return Array.isArray(value) && value.includes(node);
}

function siblings(node: ts.Node): ReadonlyArray<ts.Node> {
	const parent = node.parent;
	if (parent === undefined) return [];
	if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent))
		return parent.statements;
	return [];
}

function runOnStatement(
	inner: Compiled,
	statement: ts.Node,
	source: ts.SourceFile,
	bindings: Bindings
): boolean {
	if (inner.run(statement, source, bindings)) return true;
	return ts.isExpressionStatement(statement) && inner.run(statement.expression, source, bindings);
}

function enclosingStatement(node: ts.Node): ts.Node {
	let current: ts.Node = node;
	while (
		current.parent !== undefined &&
		!ts.isBlock(current.parent) &&
		!ts.isSourceFile(current.parent)
	)
		current = current.parent;
	return current;
}

type Compiled = Readonly<{
	run(node: ts.Node, source: ts.SourceFile, bindings: Bindings): boolean;
	kinds: ReadonlySet<NodeKind> | undefined;
}>;

export function compile(matcher: Matcher): Compiled {
	if (typeof matcher === 'string') return compile({ pattern: matcher });

	if ('pattern' in matcher) {
		const style = matcher.pattern;
		const text = typeof style === 'string' ? style : style.context;
		const selector = typeof style === 'string' ? undefined : style.selector;
		const strictness: Strictness =
			(typeof style === 'string' ? undefined : style.strictness) ?? 'smart';
		const whole = parsePattern(text);
		const parsed = selector === undefined ? whole : (findKind(whole, selector) ?? whole);
		const kind = ts.SyntaxKind[unwrap(parsed).kind] as NodeKind;
		return {
			kinds: strictness === 'template' ? undefined : new Set([kind]),
			run: (node, source, bindings) => matchShape(parsed, node, source, bindings, strictness)
		};
	}

	if ('nthChild' in matcher) {
		const described = matcher.nthChild;
		const simple = typeof described === 'object' ? described.position : described;
		const step = parseAnB(simple);
		const ofRule =
			typeof described === 'object' && described.ofRule !== undefined
				? compile(described.ofRule)
				: undefined;
		const reverse = typeof described === 'object' && described.reverse === true;
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const parent = node.parent;
				if (parent === undefined) return false;
				const all = children(parent);
				const considered =
					ofRule === undefined
						? all
						: all.filter((sibling) => ofRule.run(sibling, source, new Map(bindings)));
				const ordered = reverse ? [...considered].reverse() : considered;
				const index = ordered.indexOf(node);
				return index >= 0 && step(index + 1);
			}
		};
	}

	if ('range' in matcher) {
		const { start, end } = matcher.range;
		return {
			kinds: undefined,
			run: (node, source) => {
				const from = source.getLineAndCharacterOfPosition(node.getStart(source));
				const to = source.getLineAndCharacterOfPosition(node.getEnd());
				return (
					from.line === start.line &&
					from.character === start.column &&
					to.line === end.line &&
					to.character === end.column
				);
			}
		};
	}

	if ('matches' in matcher) {
		const name = matcher.matches;
		const util = utilities.get(name);
		if (util === undefined)
			throw new Error(`norbital-doctor: matcher references undefined util "${name}"`);
		return { kinds: undefined, run: util.run };
	}

	if ('kind' in matcher) {
		const named = matcher.kind.startsWith('ts:') ? matcher.kind.slice(3) : matcher.kind;
		if (named.includes(':'))
			return { kinds: new Set(['SourceFile' as NodeKind]), run: () => false };
		const wanted = ts.SyntaxKind[named as NodeKind];
		return {
			kinds: new Set([named as NodeKind]),
			run: (node) => node.kind === wanted || unwrap(node).kind === wanted
		};
	}

	if ('regex' in matcher) {
		const expression = new RegExp(matcher.regex);
		const on =
			matcher.on === undefined
				? undefined
				: matcher.on.startsWith('$')
					? matcher.on
					: `$${matcher.on}`;
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const bound = on === undefined ? undefined : bindings.get(on);
				const subject = on === undefined ? textOf(node, source) : bound && textOf(bound, source);
				return subject !== undefined && expression.test(subject);
			}
		};
	}

	if ('inside' in matcher) {
		const inner = compile(matcher.inside);
		const stop = matcher.stopBy ?? 'neighbor';
		const field = matcher.field;
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				let child = node;
				for (const parent of withinStop(ancestors(node), stop, source, bindings)) {
					const held = field === undefined || occupiesField(parent, child, field);
					child = parent;
					if (held && inner.run(parent, source, bindings)) return true;
				}
				return false;
			}
		};
	}

	if ('has' in matcher) {
		const inner = compile(matcher.has);
		const stop = matcher.stopBy ?? 'neighbor';
		const field = matcher.field;
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const scope =
					stop === 'neighbor'
						? children(node)
						: withinStop(descendants(node), stop, source, bindings);
				return scope.some(
					(child) =>
						(field === undefined || occupiesField(child.parent ?? node, child, field)) &&
						inner.run(child, source, bindings)
				);
			}
		};
	}

	if ('follows' in matcher) {
		const inner = compile(matcher.follows);
		const stop = matcher.stopBy ?? 'neighbor';
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const statement = enclosingStatement(node);
				const list = siblings(statement);
				const index = list.indexOf(statement);
				if (index <= 0) return false;
				const earlier = list.slice(0, index).reverse();
				return withinStop(earlier, stop, source, bindings).some((candidate) =>
					runOnStatement(inner, candidate, source, bindings)
				);
			}
		};
	}

	if ('precedes' in matcher) {
		const inner = compile(matcher.precedes);
		const stop = matcher.stopBy ?? 'neighbor';
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const statement = enclosingStatement(node);
				const list = siblings(statement);
				const index = list.indexOf(statement);
				if (index < 0) return false;
				return withinStop(list.slice(index + 1), stop, source, bindings).some((candidate) =>
					runOnStatement(inner, candidate, source, bindings)
				);
			}
		};
	}

	if ('all' in matcher) {
		const parts = matcher.all.map(compile);
		const constrained = parts.map((part) => part.kinds).filter((set) => set !== undefined);
		const kinds =
			constrained.length === 0
				? undefined
				: constrained.reduce<Set<NodeKind>>(
						(accumulated, set) => new Set([...accumulated].filter((kind) => set!.has(kind))),
						new Set(constrained[0]!)
					);
		return {
			kinds,
			run: (node, source, bindings) => parts.every((p) => p.run(node, source, bindings))
		};
	}

	if ('any' in matcher) {
		const parts = matcher.any.map(compile);
		const kinds = parts.some((part) => part.kinds === undefined)
			? undefined
			: new Set(parts.flatMap((part) => [...part.kinds!]));
		return {
			kinds,
			run: (node, source, bindings) => parts.some((p) => p.run(node, source, bindings))
		};
	}

	if ('not' in matcher) {
		const inner = compile(matcher.not);
		return {
			kinds: undefined,
			run: (node, source, bindings) => !inner.run(node, source, new Map(bindings))
		};
	}

	if ('selfModule' in matcher) {
		return {
			kinds: undefined,
			run: (node, source) => {
				const specifier = moduleSpecifierOf(node);
				if (specifier === undefined) return false;
				const host = hosts.get(source);
				const file = host?.file ?? source.fileName;
				const root = host?.root ?? '.';
				return resolvesToDeclaringModule(file, root, specifier);
			}
		};
	}

	if ('aliasCovered' in matcher) {
		return {
			kinds: undefined,
			run: (node, source) => {
				const specifier = moduleSpecifierOf(node);
				const host = hosts.get(source);
				if (specifier === undefined || host === undefined) return false;
				return aliasCovering(host.root, host.file, specifier) !== undefined;
			}
		};
	}

	if ('importsFrom' in matcher) {
		const specifier = matcher.importsFrom;
		if (typeof specifier !== 'string' || specifier.length === 0)
			throw new Error('norbital-doctor: importsFrom requires a package specifier');
		return {
			kinds: undefined,
			run: (_node, source) => sourceImportsFrom(source, specifier)
		};
	}

	if ('count' in matcher) {
		const inner = compile(matcher.count.of);
		const minimum = matcher.count.min;
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const subtree = [node, ...descendants(node)];
				let found = 0;
				for (const candidate of subtree) {
					if (unwrap(candidate) !== candidate) continue;
					if (inner.run(candidate, source, new Map(bindings))) found += 1;
				}
				return found >= minimum;
			}
		};
	}

	if ('fact' in matcher) {
		const { name, ...params } = matcher.fact;
		if (typeof name !== 'string' || name.length === 0)
			throw new Error('norbital-doctor: fact requires a name');
		return {
			kinds: undefined,
			run: (node, source, bindings) => {
				const host = hosts.get(source);
				return evaluateFact(name, params, {
					node,
					source,
					bindings,
					file: host?.file ?? source.fileName,
					root: host?.root ?? '.'
				});
			}
		};
	}

	if ('calls' in matcher) {
		const raw = matcher.calls.of;
		const name = raw.startsWith('$') ? raw : `$${raw}`;
		const exactly = matcher.calls.exactly;
		return {
			kinds: undefined,
			run: (_node, source, bindings) => {
				const bound = bindings.get(name);
				if (bound === undefined || !ts.isIdentifier(bound)) return false;
				const text = bound.text;
				let found = 0;
				const visit = (current: ts.Node): void => {
					if (
						ts.isIdentifier(current) &&
						current.text === text &&
						ts.isCallExpression(current.parent) &&
						current.parent.expression === current
					)
						found += 1;
					ts.forEachChild(current, visit);
				};
				visit(source);
				return found === exactly;
			}
		};
	}

	const parts = matcher.of.map(compile);
	const threshold = matcher.atLeast;
	return {
		kinds: undefined,
		run: (node, source, bindings) => {
			const subtree = [node, ...descendants(node)];
			let distinct = 0;
			for (const part of parts) {
				if (subtree.some((candidate) => part.run(candidate, source, new Map(bindings))))
					distinct += 1;
				if (distinct >= threshold) return true;
			}
			return false;
		}
	};
}

export function metavariablesOf(matcher: Matcher): ReadonlySet<string> {
	const found = new Set<string>();
	const walk = (current: Matcher): void => {
		if (typeof current === 'string') return walk({ pattern: current });
		if ('pattern' in current) {
			const text = typeof current.pattern === 'string' ? current.pattern : current.pattern.context;
			for (const name of text.match(/\$\.\.\.[A-Z][A-Z0-9_]*|\$[A-Z][A-Z0-9_]*/g) ?? [])
				found.add(name.startsWith('$...') ? `$${name.slice(4)}` : name);
			return;
		}
		for (const key of ['inside', 'has', 'follows', 'precedes', 'not'] as const)
			if (key in current) walk((current as Record<string, Matcher>)[key]!);
		for (const key of ['all', 'any'] as const) {
			const branch = namedProperty(current, key);
			if (Array.isArray(branch)) branch.forEach(walk);
		}
		if ('of' in current) current.of.forEach(walk);
		if ('count' in current) walk(current.count.of);
		const nth = Reflect.get(current, 'nthChild');
		if (typeof nth === 'object' && nth !== null) {
			const ofRule = Reflect.get(nth, 'ofRule');
			if (ofRule !== undefined) walk(ofRule as Matcher);
		}
	};
	walk(matcher);
	return found;
}

export function matcherKinds(matcher: Matcher): ReadonlySet<NodeKind> | undefined {
	return compile(matcher).kinds;
}

export function match(matcher: Matcher, node: ts.Node, source: ts.SourceFile): MatchResult {
	const bindings: Bindings = new Map();
	const matched = compile(matcher).run(node, source, bindings);
	return { matched, bindings: bindingTexts(bindings, source) };
}

export function bindingTexts(
	bindings: ReadonlyMap<string, ts.Node>,
	source: ts.SourceFile
): ReadonlyMap<string, string> {
	return new Map([...bindings].map(([name, node]) => [name, textOf(node, source)]));
}
