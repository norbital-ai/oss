import type { ASTNode } from '@marcbachmann/cel-js';

/** CEL macros that bind a variable as their first argument. */
const MACRO_BINDERS = new Set(['filter', 'map', 'all', 'exists', 'exists_one']);

/** Built-in CEL functions that should not be treated as dependencies. */
const CEL_BUILTINS = new Set([
	'string',
	'int',
	'double',
	'bytes',
	'dyn',
	'size',
	'timestamp',
	'type',
	'has',
	'reduce',
	'toDouble',
	'contains',
	'startsWith',
	'endsWith',
	'matches',
	'indexOf',
	'lastIndexOf',
	'substring',
	'join',
	'at'
]);

/**
 * Walk a CEL AST and collect all free identifier names.
 *
 * Handles:
 * - `call` nodes: skips the function name, walks args
 * - `rcall` nodes: skips the method name, walks receiver + args. For macros
 *   (filter, map, all, exists, exists_one), the first arg is a bound variable
 *   and is excluded.
 * - `.` / `.?` nodes: skips the property name, walks the object
 * - `map` literals: skips keys, walks values
 * - All other nodes: walks all child ASTNodes
 */
function collectIdentifiers(node: ASTNode, bound: Set<string>, out: Set<string>): void {
	switch (node.op) {
		case 'id': {
			if (!bound.has(node.args)) out.add(node.args);
			return;
		}

		case 'value':
			return;

		case 'call': {
			const [, argNodes] = node.args;
			for (const arg of argNodes) collectIdentifiers(arg, bound, out);
			return;
		}

		case 'rcall': {
			const [methodName, receiver, argNodes] = node.args;
			collectIdentifiers(receiver, bound, out);
			const newBound = new Set(bound);
			const firstArg = argNodes[0];
			if (MACRO_BINDERS.has(methodName) && firstArg && firstArg.op === 'id') {
				newBound.add(firstArg.args);
			}
			for (const arg of argNodes) collectIdentifiers(arg, newBound, out);
			return;
		}

		case '.':
		case '.?': {
			const [obj] = node.args;
			collectIdentifiers(obj, bound, out);
			return;
		}

		case '[]':
		case '[?]': {
			const [obj, key] = node.args;
			collectIdentifiers(obj, bound, out);
			collectIdentifiers(key, bound, out);
			return;
		}

		case 'list': {
			for (const item of node.args) collectIdentifiers(item, bound, out);
			return;
		}

		case 'map': {
			for (const [, value] of node.args) collectIdentifiers(value, bound, out);
			return;
		}

		case '?:': {
			const [cond, then, els] = node.args;
			collectIdentifiers(cond, bound, out);
			collectIdentifiers(then, bound, out);
			collectIdentifiers(els, bound, out);
			return;
		}

		case '||':
		case '&&': {
			const [left, right] = node.args;
			collectIdentifiers(left, bound, out);
			collectIdentifiers(right, bound, out);
			return;
		}

		case '!_':
		case '-_': {
			collectIdentifiers(node.args, bound, out);
			return;
		}

		default: {
			// Binary operators: +, -, *, /, %, ==, !=, <, <=, >, >=, in
			const [left, right] = node.args;
			collectIdentifiers(left, bound, out);
			collectIdentifiers(right, bound, out);
		}
	}
}

/**
 * Extract all free identifiers from a CEL AST.
 * Returns identifiers that are NOT bound by macros.
 */
export function extractIdentifiers(ast: ASTNode): Set<string> {
	const ids = new Set<string>();
	collectIdentifiers(ast, new Set(), ids);
	return ids;
}

/**
 * Given a set of identifiers, separate them into expr dependencies and other references.
 *
 * @param identifiers - All free identifiers from an expr's AST
 * @param exprNames - The set of all expr names in the definition
 * @returns `{ exprDeps, others }` where `exprDeps` are identifiers that match
 *          other expr names (topo-sort dependencies), and `others` are input
 *          field references or unknown identifiers.
 */
export function partitionDependencies(
	identifiers: Set<string>,
	exprNames: Set<string>
): { exprDeps: Set<string>; others: Set<string> } {
	const exprDeps = new Set<string>();
	const others = new Set<string>();
	for (const id of identifiers) {
		if (CEL_BUILTINS.has(id)) continue;
		if (exprNames.has(id)) {
			exprDeps.add(id);
		} else {
			others.add(id);
		}
	}
	return { exprDeps, others };
}

/** Cycle error thrown when topo-sort detects a cycle. */
export class CycleError extends Error {
	readonly nodes: string[];
	constructor(nodes: string[]) {
		super(`Computation cycle detected: ${nodes.join(' → ')}`);
		this.name = 'CycleError';
		this.nodes = nodes;
	}
}

/**
 * Topologically sort expr names by their dependencies.
 *
 * @param exprs - Map of expr name → set of expr names it depends on
 * @returns Evaluation order (dependencies first)
 * @throws {CycleError} if a cycle is detected
 */
export function topoSort(exprs: Map<string, Set<string>>): string[] {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const order: string[] = [];
	const path: string[] = [];

	function visit(name: string): void {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			const cycleStart = path.indexOf(name);
			throw new CycleError([...path.slice(cycleStart), name]);
		}
		visiting.add(name);
		path.push(name);

		const deps = exprs.get(name);
		if (deps) {
			for (const dep of deps) {
				visit(dep);
			}
		}

		visiting.delete(name);
		path.pop();
		visited.add(name);
		order.push(name);
	}

	for (const name of exprs.keys()) {
		visit(name);
	}

	return order;
}
