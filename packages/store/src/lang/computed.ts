// A computed field's CEL, compiled to the stored `Expr` tree that `ddl.ts` turns into a generated column.
import { Environment, type ASTNode } from '@marcbachmann/cel-js';
import type { Expr } from '../schema/spec.ts';

const TEXT_OPS = ['concat', 'text', 'lower', 'upper', 'trim', 'substring', 'regex_replace', 'json_text'] as const;
const UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const env = new Environment();

/**
 * Compile `expression` over the row's own fields (bare names). `+` concatenates when either side is text: a string
 * literal, a text function, or a field `text_field` names; otherwise it adds. Any other CEL construct throws.
 */
export function computed_expr(expression: string, text_field: (field: string) => boolean): Expr {
	const is_text = (e: Expr): boolean =>
		typeof e === 'string' ||
		(typeof e === 'object' && ('field' in e ? text_field(e.field) : TEXT_OPS.some((op) => op in e)));
	const parts = (e: Expr): readonly Expr[] => (typeof e === 'object' && 'concat' in e ? e.concat : [e]);
	const literal = (n: ASTNode): string | number => {
		if (n.op === 'value' && typeof n.args === 'string') return n.args;
		if (n.op === 'value' && (typeof n.args === 'number' || typeof n.args === 'bigint')) return Number(n.args);
		throw new Error(`'${n.input.slice(n.start, n.end)}' must be a literal`);
	};
	const text = (n: ASTNode): string => {
		const value = literal(n);
		if (typeof value !== 'string') throw new Error(`'${n.input.slice(n.start, n.end)}' must be a string`);
		return value;
	};
	const walk = (n: ASTNode): Expr => {
		switch (n.op) {
			case 'id':
				return { field: n.args };
			case 'value':
				if (typeof n.args === 'boolean') return n.args;
				return literal(n);
			case '-_': {
				const value = literal(n.args);
				if (typeof value !== 'number') throw new Error('unary minus takes a number');
				return -value;
			}
			case '+': {
				const [a, b] = [walk(n.args[0]), walk(n.args[1])];
				return is_text(a) || is_text(b) ? { concat: [...parts(a), ...parts(b)] } : { plus: [a, b] };
			}
			case '-':
				return { minus: [walk(n.args[0]), walk(n.args[1])] };
			case '*':
				return { times: [walk(n.args[0]), walk(n.args[1])] };
			case '/':
				return { div: [walk(n.args[0]), walk(n.args[1])] };
			case '==':
				return { eq: [walk(n.args[0]), walk(n.args[1])] };
			case '!=':
				return { ne: [walk(n.args[0]), walk(n.args[1])] };
			case '>':
				return { gt: [walk(n.args[0]), walk(n.args[1])] };
			case '>=':
				return { gte: [walk(n.args[0]), walk(n.args[1])] };
			case '<':
				return { lt: [walk(n.args[0]), walk(n.args[1])] };
			case '<=':
				return { lte: [walk(n.args[0]), walk(n.args[1])] };
			case '&&': {
				const [a, b] = [walk(n.args[0]), walk(n.args[1])];
				const and = (e: Expr) => (typeof e === 'object' && 'and' in e ? e.and : [e]);
				return { and: [...and(a), ...and(b)] };
			}
			case '||': {
				const [a, b] = [walk(n.args[0]), walk(n.args[1])];
				const or = (e: Expr) => (typeof e === 'object' && 'or' in e ? e.or : [e]);
				return { or: [...or(a), ...or(b)] };
			}
			case '!_':
				return { not: walk(n.args) };
			case '?:':
				return { when: [walk(n.args[0]), walk(n.args[1]), walk(n.args[2])] };
			case 'call': {
				const [fn, args] = n.args;
				const [a, b, c] = args;
				const one = (): Expr => {
					if (a === undefined || args.length !== 1) throw new Error(`${fn}() takes one argument`);
					return walk(a);
				};
				const two = (): readonly [Expr, ASTNode] => {
					if (a === undefined || b === undefined || args.length !== 2) throw new Error(`${fn}() takes two arguments`);
					return [walk(a), b];
				};
				switch (fn) {
					case 'string':
						return { text: one() };
					case 'lower':
						return { lower: one() };
					case 'upper':
						return { upper: one() };
					case 'trim':
						return { trim: one() };
					case 'size':
						return { json_length: one() };
					case 'round': {
						const [x, digits] = two();
						const places = literal(digits);
						if (typeof places !== 'number') throw new Error('round() takes a number of digits');
						return { round: [x, places] };
					}
					case 'plus_days': {
						const [x, days] = two();
						return { plus_days: [x, walk(days)] };
					}
					case 'start_of': {
						const [x, unit] = two();
						const u = UNITS.find((name) => name === text(unit));
						if (u === undefined) throw new Error(`start_of() takes one of ${UNITS.join(', ')}`);
						return { start_of: [x, u] };
					}
					case 'json_text': {
						const [x, key] = two();
						return { json_text: [x, text(key)] };
					}
					case 'substring':
						if (a === undefined || b === undefined || args.length > 3)
							throw new Error('substring() takes two or three arguments');
						return { substring: c === undefined ? [walk(a), walk(b)] : [walk(a), walk(b), walk(c)] };
					case 'regex_replace':
						if (a === undefined || b === undefined || c === undefined || args.length !== 3)
							throw new Error('regex_replace() takes three arguments');
						return { regex_replace: [walk(a), text(b), text(c)] };
					case 'coalesce':
						if (args.length === 0) throw new Error('coalesce() takes at least one argument');
						return { coalesce: args.map(walk) };
				}
				throw new Error(`function '${fn}' is not supported in a computed field`);
			}
		}
		throw new Error(`'${n.input.slice(n.start, n.end)}' is not supported in a computed field`);
	};
	return walk(env.parse(expression).ast);
}
