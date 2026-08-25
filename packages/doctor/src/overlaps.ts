/**
 * "You reimplemented something a library already owns."
 *
 * The detection and the ownership are separate concerns, and the legacy detector conflated them:
 * its clamp check recognises `Math.min(Math.max(x, lo), hi)` — true in any ecosystem — but then
 * hardcodes a literal `'effect'` import test and an `effect/Number#clamp` message. So the shape was
 * always general and only the binding was not.
 *
 * Here the shapes stay general and the owner is configuration. Point them at Effect, es-toolkit,
 * remeda, lodash, or a house standard library; a repository that configures none of them gets no
 * findings of this kind.
 *
 * A file that already imports the owner is exempt: importing `es-toolkit` and then writing a loop
 * is a choice about that call site, not an unawareness of the library.
 */
import ts from 'typescript';
import { defineRule } from './pattern.js';
import { type Principle, type Rule, type Severity } from './rules.js';

/** Reimplementable shapes the detectors recognise. */
export type OverlapShape =
	| 'clamp'
	| 'chunk'
	| 'partition'
	| 'deep-equal'
	| 'group-by'
	| 'unique'
	| 'sum'
	| 'cache'
	| 'rate-limit';

export type OverlapBinding = Readonly<{
	readonly shape: OverlapShape;
	/** Package that owns the primitive, e.g. `es-toolkit`, `effect`, `@acme/std`. */
	readonly owner: string;
	/** Exported name, e.g. `clamp`. Used in the evidence string. */
	readonly member: string;
	/** Optional module path within the owner, e.g. `Number` for `effect/Number`. */
	readonly module?: string | undefined;
	/** Defaults to `error`. */
	readonly severity?: Severity | undefined;
	/** Override the generated rule id. Defaults to `OVERLAP_<SHAPE>`. */
	readonly id?: string | undefined;
}>;

const PRINCIPLES: ReadonlyArray<Principle> = [
	'simplicity',
	'straightforwardness',
	'efficiency',
	'no-bloat'
];

function mathMethod(node: ts.Node): string | undefined {
	if (!ts.isCallExpression(node)) return undefined;
	const target = node.expression;
	return ts.isPropertyAccessExpression(target) &&
		ts.isIdentifier(target.expression) &&
		target.expression.text === 'Math'
		? target.name.text
		: undefined;
}

function arrayMethod(node: ts.Node): string | undefined {
	if (!ts.isCallExpression(node)) return undefined;
	const target = node.expression;
	return ts.isPropertyAccessExpression(target) ? target.name.text : undefined;
}

/** `Math.min(Math.max(x, lo), hi)` in either nesting order. */
function isClamp(node: ts.Node): boolean {
	const outer = mathMethod(node);
	if (outer === undefined || !['min', 'max'].includes(outer)) return false;
	const call = node as ts.CallExpression;
	if (call.arguments.length !== 2) return false;
	return call.arguments.some((argument) => {
		const inner = mathMethod(argument);
		return (
			inner !== undefined &&
			['min', 'max'].includes(inner) &&
			inner !== outer &&
			(argument as ts.CallExpression).arguments.length === 2
		);
	});
}

/** A loop whose body slices fixed-width windows out of an array. */
function isChunk(node: ts.Node): boolean {
	if (!ts.isForStatement(node)) return false;
	const body = node.getText();
	return /\.slice\s*\(/.test(body) && /\.push\s*\(/.test(body) && /\+=\s*[A-Za-z_$]/.test(body);
}

/** The same collection filtered twice with a predicate and its negation. */
function isPartition(node: ts.Node): boolean {
	if (!ts.isVariableStatement(node)) return false;
	const text = node.getText();
	const filters = text.match(/\.filter\s*\(/g);
	return filters !== null && filters.length >= 2 && /!\s*[A-Za-z_$(]/.test(text);
}

/** `JSON.stringify(a) === JSON.stringify(b)` used as equality. */
function isDeepEqual(node: ts.Node): boolean {
	if (!ts.isBinaryExpression(node)) return false;
	if (
		node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
		node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsToken
	)
		return false;
	const stringify = (side: ts.Node) =>
		ts.isCallExpression(side) &&
		ts.isPropertyAccessExpression(side.expression) &&
		ts.isIdentifier(side.expression.expression) &&
		side.expression.expression.text === 'JSON' &&
		side.expression.name.text === 'stringify';
	return stringify(node.left) && stringify(node.right);
}

/** `reduce` that accumulates into keyed buckets. */
function isGroupBy(node: ts.Node): boolean {
	if (arrayMethod(node) !== 'reduce') return false;
	const text = node.getText();
	return /\[[^\]]+\]\s*(?:\?\?=|\|\|=|=)/.test(text) && /push\s*\(/.test(text);
}

/** `[...new Set(xs)]` or `Array.from(new Set(xs))`. */
function isUnique(node: ts.Node): boolean {
	const text = node.getText();
	if (ts.isArrayLiteralExpression(node)) return /^\[\s*\.\.\.\s*new Set\s*\(/.test(text);
	if (ts.isCallExpression(node))
		return (
			arrayMethod(node) === 'from' &&
			node.arguments.length === 1 &&
			/^new Set\s*\(/.test(node.arguments[0]?.getText() ?? '')
		);
	return false;
}

/** A memo keyed by arguments: a `Map` consulted, then written, around a computation. */
function isCache(node: ts.Node): boolean {
	if (
		!ts.isFunctionDeclaration(node) &&
		!ts.isArrowFunction(node) &&
		!ts.isFunctionExpression(node)
	)
		return false;
	const body = node.body;
	if (body === undefined) return false;
	const text = body.getText();
	return (
		/\.has\s*\(/.test(text) &&
		/\.get\s*\(/.test(text) &&
		/\.set\s*\(/.test(text) &&
		/\breturn\b/.test(text)
	);
}

/**
 * A hand-rolled throttle: elapsed time since a remembered instant, compared against a budget.
 *
 * The timestamp source is deliberately not part of the signal. `Date.now() - last > n` and
 * `now - last > n` with an injected clock are the same rate limiter, and the second is the better
 * spelling — requiring `Date.now()` would have caught only the version that also violates the
 * ambient-time rule.
 */
function isRateLimit(node: ts.Node): boolean {
	if (!ts.isIfStatement(node)) return false;
	const condition = node.expression;
	if (!ts.isBinaryExpression(condition)) return false;
	const comparison = [
		ts.SyntaxKind.GreaterThanToken,
		ts.SyntaxKind.GreaterThanEqualsToken,
		ts.SyntaxKind.LessThanToken,
		ts.SyntaxKind.LessThanEqualsToken
	];
	if (!comparison.includes(condition.operatorToken.kind)) return false;
	const elapsed = [condition.left, condition.right].find(
		(side) => ts.isBinaryExpression(side) && side.operatorToken.kind === ts.SyntaxKind.MinusToken
	);
	if (elapsed === undefined) return false;
	return /\b(last|previous|prev|since|cooldown|throttle|debounce|elapsed)[A-Za-z]*\b/i.test(
		elapsed.getText()
	);
}

/** `reduce((a, b) => a + b, 0)`. */
function isSum(node: ts.Node): boolean {
	if (arrayMethod(node) !== 'reduce') return false;
	const call = node as ts.CallExpression;
	const callback = call.arguments[0];
	if (callback === undefined || !ts.isArrowFunction(callback)) return false;
	return /^[A-Za-z_$][\w$]*\s*\+\s*[A-Za-z_$][\w$]*$/.test(callback.body.getText().trim());
}

type Detector = Readonly<{
	when: ReadonlyArray<Parameters<typeof defineRule>[0]['when'][number]>;
	matches(node: ts.Node): boolean;
	describe: string;
}>;

const DETECTORS: Readonly<Record<OverlapShape, Detector>> = {
	clamp: { when: ['CallExpression'], matches: isClamp, describe: 'nested Math.min/Math.max' },
	chunk: { when: ['ForStatement'], matches: isChunk, describe: 'sliding slice loop' },
	partition: {
		when: ['VariableStatement'],
		matches: isPartition,
		describe: 'a predicate filtered twice'
	},
	'deep-equal': {
		when: ['BinaryExpression'],
		matches: isDeepEqual,
		describe: 'JSON.stringify comparison'
	},
	'group-by': {
		when: ['CallExpression'],
		matches: isGroupBy,
		describe: 'reduce into keyed buckets'
	},
	unique: {
		when: ['ArrayLiteralExpression', 'CallExpression'],
		matches: isUnique,
		describe: 'Set round-trip'
	},
	sum: { when: ['CallExpression'], matches: isSum, describe: 'reduce with addition' },
	// The two families the legacy EFF4 detector carried that no other shape covered. Without these,
	// deleting it would have silently stopped enforcing them.
	cache: {
		when: ['FunctionDeclaration', 'ArrowFunction', 'FunctionExpression'],
		matches: isCache,
		describe: 'has/get/set memo around a computation'
	},
	'rate-limit': {
		when: ['IfStatement'],
		matches: isRateLimit,
		describe: 'timestamp compared against now before doing work'
	}
};

/** The shapes a binding may name, for configuration surfaces that validate before building. */
export const OVERLAP_SHAPES: ReadonlyArray<OverlapShape> = Object.keys(
	DETECTORS
) as OverlapShape[];

/** Build one rule per configured binding. */
export function overlapRules(bindings: ReadonlyArray<OverlapBinding>): ReadonlyArray<Rule> {
	return bindings.map((binding) => {
		const detector = DETECTORS[binding.shape];
		if (detector === undefined)
			throw new Error(
				`norbital-doctor: unknown overlap shape "${binding.shape}"; known shapes are ${Object.keys(DETECTORS).join(', ')}`
			);
		const qualified = binding.module ? `${binding.owner}/${binding.module}` : binding.owner;
		return defineRule({
			id: binding.id ?? `OVERLAP_${binding.shape.toUpperCase().replace(/-/g, '_')}`,
			severity: binding.severity ?? 'error',
			confidence: 'high',
			summary: `local ${binding.shape} reimplements ${qualified}#${binding.member}`,
			principles: PRINCIPLES,
			when: detector.when,
			check(node, context) {
				if (context.importsFrom(binding.owner)) return;
				if (!detector.matches(node)) return;
				context.report(node, `shape=${binding.shape} prefer=${qualified}#${binding.member}`);
			}
		});
	});
}
