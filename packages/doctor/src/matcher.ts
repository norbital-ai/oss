/**
 * A relational rule algebra over the TypeScript parse tree.
 *
 * The shape is ast-grep's — atomic matchers composed by relational and boolean combinators — but
 * the mechanism is ours: the TypeScript parser we already depend on, no tree-sitter, no YAML, and a
 * typed authoring surface where a mistyped syntax kind is a compile error rather than a rule that
 * silently never fires.
 *
 * The reason this exists is `QRY1`. That rule wanted to say "one lexical scope exhibits several
 * bypass mechanisms at once", and the language it was written in could not say it, so it was
 * expressed as *variable naming*: a scope declaring something called `rows` and something called
 * `loading` and two of `version`/`notify`/`refresh`. A `setInterval` driving `query.refresh()`
 * inside an `$effect` matched none of those names and reported clean across the whole repository.
 *
 * The structure of that rule was right. Co-occurring signals, grouped by lexical owner, is exactly
 * how you catch a hand-rolled reimplementation. What was wrong was the evidence: names instead of
 * mechanisms. `atLeast` and `scope` below are the two combinators it needed, so the next rule of
 * that shape can be stated directly — and stated about mechanisms, which survive a rename.
 *
 * A better matcher does not rescue a rule watching the wrong evidence. It only removes the excuse.
 */
import ts from 'typescript';
import type { NodeKind } from './rules.js';

export type MatchResult = Readonly<{ matched: boolean; bindings: ReadonlyMap<string, string> }>;

/**
 * How far a relational rule searches. Mirrors ast-grep's `SerializableStopBy`.
 *
 * `neighbor` is the **default**, as in ast-grep: `inside` looks at the immediate parent and `has`
 * at direct children only. Any other matcher walks until a node matches it, testing that node too —
 * ast-grep's `take_while(inclusive_until(stop))`.
 *
 * A bare `'neighbor'` or `'end'` is the enum; any other string is a pattern, exactly as ast-grep's
 * untagged deserialization reads it.
 */
export type StopBy = 'neighbor' | 'end' | Matcher;

/**
 * How exactly a pattern's nodes must correspond. ast-grep's `Strictness`.
 *
 * TypeScript's AST has no CST layer, so `cst` and `smart` coincide here: the parser never gives us
 * the trivia tree-sitter would. The distinctions that do bite — ignoring comments, ignoring text,
 * ignoring kinds — are real and implemented.
 */
export type Strictness = 'cst' | 'smart' | 'ast' | 'relaxed' | 'signature' | 'template';

/** `nthChild` accepts a number, an `An+B` string, or an object. ast-grep's `SerializableNthChild`. */
export type NthChild =
	| number
	| string
	| Readonly<{
			position: number | string;
			ofRule?: Matcher | undefined;
			reverse?: boolean | undefined;
	  }>;

export type Position = Readonly<{ line: number; column: number }>;
/** A node must appear exactly within this span. ast-grep's `SerializableRange`. */
export type Range = Readonly<{ start: Position; end: Position }>;

/** A pattern with the surrounding code needed to disambiguate it. ast-grep's `PatternStyle`. */
export type PatternStyle =
	| string
	| Readonly<{
			/** Code that resolves the ambiguity; the whole string is parsed. */
			context: string;
			/** The sub-node kind inside `context` that is the real matcher. */
			selector?: NodeKind | undefined;
			strictness?: Strictness | undefined;
	  }>;

export type Matcher =
	/** Shorthand for `{ pattern }`. */
	| string
	/** A shape in the language's own syntax; `$NAME` binds one node, `$...NAME` a run. */
	| Readonly<{ pattern: PatternStyle }>
	/** A bare syntax kind, for "any call" or "any function". */
	| Readonly<{ kind: NodeKind }>
	/**
	 * A regular expression over the node's own text, or over a binding's text when `on` is given.
	 *
	 * `on` is an extension over ast-grep, which expresses the same thing as a `constraints` entry.
	 * It names a metavariable bound earlier in the same `all`, with or without the `$`.
	 */
	| Readonly<{ regex: string; on?: string | undefined }>
	/** Position among siblings, CSS `An+B` style. */
	| Readonly<{ nthChild: NthChild }>
	/** The node must occupy exactly this source span. */
	| Readonly<{ range: Range }>
	/** True when an ancestor matches. `field` requires the node to be that property of the ancestor. */
	| Readonly<{ inside: Matcher; stopBy?: StopBy | undefined; field?: string | undefined }>
	/** True when a descendant matches. */
	| Readonly<{ has: Matcher; stopBy?: StopBy | undefined; field?: string | undefined }>
	/** True when an earlier sibling statement matches. */
	| Readonly<{ follows: Matcher; stopBy?: StopBy | undefined }>
	/** True when a later sibling statement matches. */
	| Readonly<{ precedes: Matcher; stopBy?: StopBy | undefined }>
	/** All must match. Bindings from every member are kept, as in ast-grep. */
	| Readonly<{ all: ReadonlyArray<Matcher> }>
	/** Any may match. Only the matching member's bindings are kept, as in ast-grep. */
	| Readonly<{ any: ReadonlyArray<Matcher> }>
	| Readonly<{ not: Matcher }>
	/** Reference a named rule from the enclosing `utils`. ast-grep's `matches`. */
	| Readonly<{ matches: string }>
	/**
	 * At least `atLeast` of `of` match somewhere in this node's subtree.
	 *
	 * An extension: ast-grep has no counting combinator. Counting *distinct* matchers rather than
	 * occurrences is what makes it mean "several different mechanisms" instead of "one mechanism
	 * several times". `CAP_*` and `defineScope` are built on it.
	 */
	| Readonly<{ atLeast: number; of: ReadonlyArray<Matcher> }>;

/** Named rules a matcher tree can reference through `matches`. ast-grep's `utils`. */
export type Utils = Readonly<Record<string, Matcher>>;

/** A rule per metavariable, narrowing what it may bind. ast-grep's `constraints`. */
export type Constraints = Readonly<Record<string, Matcher>>;

/** What a match bound: the node itself, so a constraint can be a rule rather than a regex. */
export type Bindings = Map<string, ts.Node>;

const METAVARIABLE = /^\$[A-Z][A-Z0-9_]*$/;

/** The registry `matches` resolves against, populated by `withUtils` for the duration of a compile. */
const utilities = new Map<string, Compiled>();

/**
 * Compile a matcher with named utility rules in scope. ast-grep's `utils` + `matches`.
 *
 * The registry is populated before the tree is compiled and each util is compiled lazily on first
 * use, so utils may reference one another — including cyclically — without the compiler recursing.
 */
export function withUtils<T>(utils: Utils, compileTree: () => T): T {
	const previous = new Map(utilities);
	for (const [name, rule] of Object.entries(utils)) {
		let resolved: Compiled | undefined;
		utilities.set(name, {
			kinds: undefined,
			run: (node, source, bindings) => (resolved ??= compile(rule)).run(node, source, bindings)
		});
	}
	try {
		return compileTree();
	} finally {
		utilities.clear();
		for (const [name, value] of previous) utilities.set(name, value);
	}
}

/** The first descendant of a given kind, which is how `selector` narrows a `context` pattern. */
function findKind(node: ts.Node, kind: NodeKind): ts.Node | undefined {
	const wanted = ts.SyntaxKind[kind];
	if (unwrap(node).kind === wanted) return unwrap(node);
	for (const child of children(node)) {
		const found = findKind(child, kind);
		if (found !== undefined) return found;
	}
	return undefined;
}

/**
 * CSS `An+B`, as `nth-child` accepts it: a number, `odd`, `even`, or `2n+1`.
 *
 * Returns a predicate over the one-based position, which is what ast-grep's `parse_an_b` produces.
 */
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

/**
 * Parse a pattern source into the node it describes.
 *
 * `$...NAME` is the DSL spelling of a variadic and is not valid TypeScript, so it is rewritten to a
 * spread of the bare name first; the parser then yields a `SpreadElement` in exactly that position.
 */
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
	// A bare expression parses as an expression statement; match the expression itself, so a pattern
	// can appear anywhere an expression can rather than only as a whole statement.
	return ts.isExpressionStatement(first) ? first.expression : first;
}

/** Parentheses and non-null assertions never change what a pattern means. */
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

function textOf(node: ts.Node, source: ts.SourceFile): string {
	try {
		return node.getText(source).replace(/\s+/g, ' ').trim();
	} catch {
		return '';
	}
}

function variadicName(node: ts.Node): string | undefined {
	if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
		const inner = node.expression;
		if (ts.isIdentifier(inner) && /^[A-Z][A-Z0-9_]*$/.test(inner.text)) return inner.text;
	}
	if (ts.isIdentifier(node) && /^\$\.\.\.[A-Z][A-Z0-9_]*$/.test(node.text)) return node.text;
	return undefined;
}

/** Structural comparison of a parsed pattern against a target node. */
function matchShape(
	pattern: ts.Node,
	target: ts.Node,
	source: ts.SourceFile,
	bindings: Bindings,
	strictness: Strictness = 'smart'
): boolean {
	const patternNode = unwrap(pattern);
	const targetNode = unwrap(target);

	// A metavariable in a *type* position parses as a type reference wrapping the identifier, so
	// `as $TARGET` would only ever match another type reference — never `number`, `string` or a
	// type literal. Unwrapping it here is what makes a metavariable mean the same thing in both
	// positions.
	const asMetavariable =
		ts.isTypeReferenceNode(patternNode) &&
		ts.isIdentifier(patternNode.typeName) &&
		METAVARIABLE.test(patternNode.typeName.text)
			? patternNode.typeName
			: patternNode;

	if (ts.isIdentifier(asMetavariable) && METAVARIABLE.test(asMetavariable.text)) {
		const name = asMetavariable.text;
		const seen = bindings.get(name);
		// A repeated metavariable must bind consistently: that is how a pattern says "the same
		// expression appears in both positions". Comparison is by text, as in ast-grep.
		if (seen !== undefined) return textOf(seen, source) === textOf(targetNode, source);
		bindings.set(name, targetNode);
		return true;
	}

	// `template` ignores node kinds and compares text only; everything else requires the same kind.
	if (strictness !== 'template' && patternNode.kind !== targetNode.kind) return false;
	// `signature` matches shape without text, so two calls with different names still correspond.
	const comparesText = strictness !== 'signature';
	if (ts.isIdentifier(patternNode) && ts.isIdentifier(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (ts.isStringLiteralLike(patternNode) && ts.isStringLiteralLike(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (ts.isNumericLiteral(patternNode) && ts.isNumericLiteral(targetNode))
		return !comparesText || patternNode.text === targetNode.text;
	if (strictness === 'template') return textOf(patternNode, source) === textOf(targetNode, source);

	// `relaxed` and stricter-than-cst levels ignore comment trivia. TypeScript's AST keeps comments
	// out of the child list already, so this is where a JSDoc-bearing node stops differing from a
	// bare one under `relaxed`.
	const patternChildren = children(patternNode);
	const targetChildren = children(targetNode);
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

/**
 * The nodes a relational rule may consider, in search order.
 *
 * ast-grep's `StopBy::find`: `neighbor` looks at the immediate step only, `end` at the whole chain,
 * and a rule walks until one matches — **inclusive**, so the stopping node is itself a candidate.
 */
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

/** Ancestors nearest-first. */
function ancestors(node: ts.Node): ReadonlyArray<ts.Node> {
	const chain: Array<ts.Node> = [];
	for (let parent = node.parent; parent !== undefined; parent = parent.parent) chain.push(parent);
	return chain;
}

/** Every descendant in breadth-first order, so `neighbor` means "direct children". */
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

/** Direct children, which is what `stopBy: 'neighbor'` means for `has`. */
function directChildren(node: ts.Node): ReadonlyArray<ts.Node> {
	return children(node);
}

/**
 * True when `node` is the value of the named property of `parent`.
 *
 * ast-grep uses tree-sitter field names. TypeScript's AST has no field ids, but it has named
 * properties that carry the same meaning — `initializer`, `expression`, `body` — so the property
 * name is the honest analogue.
 */
/**
 * A node's named property.
 *
 * Reading one by name needs no assertion: `Reflect.get` answers `unknown`, which is exactly how
 * much is known about a property addressed by a string.
 */
function namedProperty(parent: object, field: string): unknown {
	return Reflect.get(parent, field);
}

function occupiesField(parent: ts.Node, node: ts.Node, field: string): boolean {
	const value = namedProperty(parent, field);
	if (value === node) return true;
	return Array.isArray(value) && value.includes(node);
}

/** Statement siblings of a node, in source order, or an empty list outside a block. */
function siblings(node: ts.Node): ReadonlyArray<ts.Node> {
	const parent = node.parent;
	if (parent === undefined) return [];
	if (ts.isBlock(parent) || ts.isSourceFile(parent) || ts.isCaseClause(parent))
		return parent.statements;
	return [];
}

/**
 * Run a matcher against a sibling statement, or against the expression it wraps.
 *
 * `parsePattern` deliberately returns the expression for a bare pattern, so `go()` can match
 * anywhere a call appears rather than only as a whole statement. Sibling comparison works on
 * statements, so without this a pattern could never match a sibling and `follows`/`precedes` were
 * unusable with the most common form of pattern there is.
 */
function runOnStatement(
	inner: Compiled,
	statement: ts.Node,
	source: ts.SourceFile,
	bindings: Bindings
): boolean {
	if (inner.run(statement, source, bindings)) return true;
	return ts.isExpressionStatement(statement) && inner.run(statement.expression, source, bindings);
}

/** The statement enclosing a node, which is the unit `follows` and `precedes` compare. */
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
	/** Syntax kinds this matcher can start from, or `undefined` when it can start anywhere. */
	kinds: ReadonlySet<NodeKind> | undefined;
}>;

/** Compile a matcher once, so dispatch and matching do no parsing per node. */
export function compile(matcher: Matcher): Compiled {
	if (typeof matcher === 'string') return compile({ pattern: matcher });

	if ('pattern' in matcher) {
		const style = matcher.pattern;
		const text = typeof style === 'string' ? style : style.context;
		const selector = typeof style === 'string' ? undefined : style.selector;
		const strictness: Strictness =
			(typeof style === 'string' ? undefined : style.strictness) ?? 'smart';
		// `context` is parsed whole and `selector` picks the sub-node that is the real matcher —
		// how ast-grep disambiguates a fragment that is not a statement on its own, such as an
		// object property or a class member.
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
				// CSS counts from one.
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
		// Bound now, while the registry is in scope. Looking it up at run time instead read an empty
		// registry, because `withUtils` tears its scope down as soon as compiling finishes — the
		// util resolved during the compile and vanished before the rule ever ran.
		const util = utilities.get(name);
		if (util === undefined)
			throw new Error(`norbital-doctor: matcher references undefined util "${name}"`);
		return { kinds: undefined, run: util.run };
	}

	if ('kind' in matcher) {
		const wanted = ts.SyntaxKind[matcher.kind];
		return { kinds: new Set([matcher.kind]), run: (node) => unwrap(node).kind === wanted };
	}

	if ('regex' in matcher) {
		const expression = new RegExp(matcher.regex);
		// Bindings are keyed by the metavariable as written, `$NAME`. Accepting the bare name too
		// removes a footgun with no failure mode: `on: 'NAME'` simply found nothing and the rule
		// reported zero, which reads exactly like "this codebase is clean".
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
						? directChildren(node)
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
				// Nearest-first, so `neighbor` means the statement immediately before.
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
		// A conjunction can start only where every member that constrains a kind agrees.
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
		// A negation constrains nothing: every kind can fail to match.
		return {
			kinds: undefined,
			run: (node, source, bindings) => !inner.run(node, source, new Map(bindings))
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
				// Each matcher counts once however many times it occurs: the claim is "several
				// different mechanisms", not "one mechanism repeatedly".
				if (subtree.some((candidate) => part.run(candidate, source, new Map(bindings))))
					distinct += 1;
				if (distinct >= threshold) return true;
			}
			return false;
		}
	};
}

/**
 * Every metavariable a matcher tree can bind.
 *
 * Used to reject a constraint naming a variable the pattern never binds — ast-grep's
 * `UndefinedMetaVar`. Catching it when the rule is authored beats catching it when it happens to
 * match, which for a misspelled key is never.
 */
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
		if (
			'nthChild' in current &&
			typeof current.nthChild === 'object' &&
			current.nthChild.ofRule !== undefined
		)
			walk(current.nthChild.ofRule);
	};
	walk(matcher);
	return found;
}

/** The kinds a compiled matcher can be dispatched on, or `undefined` for "any node". */
export function matcherKinds(matcher: Matcher): ReadonlySet<NodeKind> | undefined {
	return compile(matcher).kinds;
}

/** Run a matcher against one node, returning what it bound. */
export function match(matcher: Matcher, node: ts.Node, source: ts.SourceFile): MatchResult {
	const bindings: Bindings = new Map();
	const matched = compile(matcher).run(node, source, bindings);
	return { matched, bindings: bindingTexts(bindings, source) };
}

/** Bound metavariables as text, which is what a finding's evidence line carries. */
export function bindingTexts(
	bindings: ReadonlyMap<string, ts.Node>,
	source: ts.SourceFile
): ReadonlyMap<string, string> {
	return new Map([...bindings].map(([name, node]) => [name, textOf(node, source)]));
}
