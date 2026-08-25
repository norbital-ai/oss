/**
 * A node's identifier name, when it has one.
 *
 * Rules that need a declaration's name used to probe `'name' in node && node.name !== ...
 * inline — the same probe repeated three ways in three packs, and a chained object test in
 * every one. The read lives here instead, once: `Reflect.get` on the compiler's own node
 * shapes, with the compiler's own predicate for the actual test, and rules stop carrying
 * guard logic. A node that never has names (a call expression) yields undefined.
 */
import ts from 'typescript';

export function nameOf(node: ts.Node): ts.Identifier | undefined {
	const name = Reflect.get(node, 'name');
	if (name === undefined) return undefined;
	return ts.isIdentifier(name as ts.Node) ? (name as ts.Identifier) : undefined;
}
