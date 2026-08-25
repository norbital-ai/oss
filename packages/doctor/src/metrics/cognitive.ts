/**
 * Cognitive Complexity, SonarSource-style, recomputed over the compiler AST.
 *
 * Cyclomatic Complexity answers "how many paths"; Cognitive Complexity answers "how hard to
 * follow", and the difference is structural: path counting charges five sibling `if`s exactly
 * what it charges five stacked ones, while a reader experiences the nesting far worse. The
 * scoring follows the SonarSource formulation (G. Ann Campbell, 2018) with the deviations the
 * merged analyzer wants, each pinned by tests and listed here so the numbers stay auditable:
 *
 * - +1 per `if`, `for` (all three forms), `while`, `do`, `catch`, ternary `?`, and per `case`
 *   clause. Cases rather than the `switch` head mirror src/analysis/complexity.ts, which also
 *   charges cyclomatic per clause; keeping the two counters comparable matters more here than
 *   matching the paper's per-switch charge. `default` adds nothing — it opens no new branch.
 * - An `else`, including the `if` half of an `else if`, adds +1 flat. Charging nesting on chain
 *   links would make a long-but-flat ladder grow quadratically, the exact false alarm this
 *   metric exists to avoid.
 * - Nesting increments (+1 per enclosing control level) land on `if`, loops, `switch`, and
 *   `catch` only. Logical sequences and ternaries stay flat: they compose booleans, they do not
 *   deepen scope.
 * - A maximal run of one logical operator scores once; switching operator mid-chain (`&&` then
 *   `||`) opens a new sequence worth another +1. Sequences are tracked positionally — only the
 *   left spine of a logical operator propagates its run — so `(a && b) || (c && d)` is two
 *   sequences, and an operator buried in an unrelated subexpression never inherits a run.
 * - `??` is deliberately absent: coalescing picks a fallback, it does not branch.
 * - A `return` or `throw` wrapping logic adds nothing itself; the wrapped logic scores normally,
 *   which falls out of the walk rather than needing a rule.
 * - Nested function-likes short-circuit. A closure is its own unit with its own score; charging
 *   its body to the parent would punish extraction.
 */
import ts from 'typescript';

const LOGICAL_OPERATORS = new Set(['&&', '||']);

type FunctionLike =
	| ts.FunctionDeclaration
	| ts.MethodDeclaration
	| ts.ArrowFunction
	| ts.FunctionExpression
	| ts.ConstructorDeclaration
	| ts.GetAccessorDeclaration
	| ts.SetAccessorDeclaration;

export function isFunctionLike(node: ts.Node): node is FunctionLike {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isArrowFunction(node) ||
		ts.isFunctionExpression(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	);
}

type Score = { total: number };

/**
 * Walk one subtree. `depth` is the enclosing control-flow depth; `chain` is defined only on the
 * left spine of a logical operator, carrying the operator whose run an operand would extend.
 */
function visit(node: ts.Node, depth: number, chain: string | undefined, score: Score): void {
	// A closure is scored as its own unit; its internals neither count here nor inherit depth.
	if (isFunctionLike(node)) return;
	if (ts.isIfStatement(node)) {
		// The compiler has no else-clause node: an `else if` is literally an IfStatement wired
		// into the parent's `elseStatement`, so "is this the else half" is answered by position.
		const isElseBranch =
			ts.isIfStatement(node.parent) && node.parent.elseStatement === node;
		score.total += isElseBranch ? 1 : 1 + depth;
		visit(node.expression, depth, undefined, score);
		visit(node.thenStatement, depth + 1, undefined, score);
		if (node.elseStatement) {
			if (!ts.isIfStatement(node.elseStatement)) score.total += 1;
			visit(node.elseStatement, depth + 1, undefined, score);
		}
		return;
	}
	if (ts.isForStatement(node)) {
		score.total += 1 + depth;
		if (node.initializer) visit(node.initializer, depth, undefined, score);
		if (node.condition) visit(node.condition, depth, undefined, score);
		if (node.incrementor) visit(node.incrementor, depth, undefined, score);
		visit(node.statement, depth + 1, undefined, score);
		return;
	}
	if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
		score.total += 1 + depth;
		visit(node.initializer, depth, undefined, score);
		visit(node.expression, depth, undefined, score);
		visit(node.statement, depth + 1, undefined, score);
		return;
	}
	if (ts.isWhileStatement(node)) {
		score.total += 1 + depth;
		visit(node.expression, depth, undefined, score);
		visit(node.statement, depth + 1, undefined, score);
		return;
	}
	if (ts.isDoStatement(node)) {
		score.total += 1 + depth;
		visit(node.statement, depth + 1, undefined, score);
		visit(node.expression, depth, undefined, score);
		return;
	}
	if (ts.isSwitchStatement(node)) {
		visit(node.expression, depth, undefined, score);
		for (const clause of node.caseBlock.clauses) {
			if (ts.isCaseClause(clause)) score.total += 1;
			for (const statement of clause.statements)
				visit(statement, depth + 1, undefined, score);
		}
		return;
	}
	if (ts.isCatchClause(node)) {
		score.total += 1 + depth;
		if (node.variableDeclaration) visit(node.variableDeclaration, depth, undefined, score);
		visit(node.block, depth + 1, undefined, score);
		return;
	}
	if (ts.isConditionalExpression(node)) {
		score.total += 1;
		visit(node.condition, depth, undefined, score);
		visit(node.whenTrue, depth, undefined, score);
		visit(node.whenFalse, depth, undefined, score);
		return;
	}
	if (
		ts.isBinaryExpression(node) &&
		LOGICAL_OPERATORS.has(node.operatorToken.getText())
	) {
		const operator = node.operatorToken.getText();
		if (chain !== operator) score.total += 1;
		visit(node.left, depth, operator, score);
		visit(node.right, depth, undefined, score);
		return;
	}
	ts.forEachChild(node, (child) => visit(child, depth, undefined, score));
}

/** Cognitive Complexity of one function-like declaration; 0 for a bodyless overload. */
export function cognitiveComplexity(fn: ts.Node): number {
	if (!isFunctionLike(fn))
		throw new Error(
			`norbital-doctor: cognitiveComplexity expects a function, method, arrow, or function expression, received ${ts.SyntaxKind[fn.kind]}`
		);
	if (!fn.body) return 0;
	const score = { total: 0 };
	visit(fn.body, 0, undefined, score);
	return score.total;
}
