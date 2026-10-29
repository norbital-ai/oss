// The CEL AST's child nodes per operator: the walkers of formula.ts and vars.ts read the parser's typed `ASTNode`.
import type { ASTNode } from '@marcbachmann/cel-js';

export function children(n: ASTNode): readonly ASTNode[] {
	switch (n.op) {
		case 'value':
		case 'id':
			return [];
		case '.':
		case '.?':
			return [n.args[0]];
		case '!_':
		case '-_':
			return [n.args];
		case 'call':
			return n.args[1];
		case 'rcall':
			return [n.args[1], ...n.args[2]];
		case 'list':
			return n.args;
		case 'map':
			return n.args.flat();
		default:
			return n.args;
	}
}
