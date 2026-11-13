// One CEL program for browser labels and native materialization. SQL operands stay JSON until an operator needs a scalar.
import { Environment, type ASTNode } from '@marcbachmann/cel-js';
import { Result } from 'effect';
import { children } from './cel-ast.ts';

const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
import { UUID_PATTERN, type Value } from './kind.ts';
import { Decimal } from './decimal.ts';

const string = (sql: string) => `(${sql} #>> '{}')`;
const bool = (sql: string) =>
	`(CASE WHEN jsonb_typeof(${sql}) = 'boolean' THEN ${string(sql)} END)::boolean`;
const number = (sql: string) =>
	`(CASE WHEN jsonb_typeof(${sql}) = 'number' THEN ${string(sql)} END)::numeric`;
const parsedNumber = (sql: string) =>
	`(CASE WHEN ${string(sql)} ~ '^[+-]?[0-9]+([.][0-9]*)?([eE][+-]?[0-9]+)?$' THEN ${string(sql)} END)::numeric`;
const json = (sql: string) => `to_jsonb(${sql})`;
const integer = (node: ASTNode): boolean => {
	if (node.op === 'value') return typeof node.args === 'bigint';
	if (node.op === 'call') return node.args[0] === 'int';
	if (node.op === '-_') return integer(node.args);
	if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/' || node.op === '%')
		return integer(node.args[0]) && integer(node.args[1]);
	return false;
};
const size = (sql: string) =>
	`(CASE jsonb_typeof(${sql}) WHEN 'array' THEN jsonb_array_length(${sql}) WHEN 'object' THEN (SELECT count(*)::int FROM jsonb_object_keys(${sql})) ELSE length(${string(sql)}) END)`;
const input = (value: Value): unknown => {
	if (value instanceof Decimal) return value.toString();
	if (Array.isArray(value)) return value.map(input);
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([key, own]) => [key, input(own)]));
	return value;
};
const pathOf = (n: ASTNode): readonly string[] | undefined => {
	if (n.op === 'id') return [n.args];
	if (n.op === '.' || n.op === '.?') {
		const parent = pathOf(n.args[0]);
		return parent === undefined ? undefined : [...parent, n.args[1]];
	}
	return undefined;
};

/** A checked label's record paths, interpreter, and equivalent native stored-label expression. */
export type LabelProgram = {
	readonly paths: readonly string[];
	readonly evaluate: (row: { readonly [field: string]: Value }) => unknown;
	readonly sql: (read: (path: string) => string) => string;
};

/** Native label text uses the same scalar/fallback rules as the browser; `from` supplies a materializer's row. */
export const label_text_sql = (expression: string, from?: string): string => `SELECT CASE
		WHEN value ~* '${UUID_PATTERN.source}' THEN NULL
		WHEN left(value, 1) IN ('{', '[') AND pg_input_is_valid(value, 'jsonb') THEN NULL
		WHEN value ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}([.]\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$' THEN
			CASE WHEN (value::timestamptz AT TIME ZONE 'UTC')::time = '00:00:00'::time THEN to_char(value::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD')
			ELSE to_char(value::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') END
		ELSE nullif(btrim(value), '') END
		FROM (SELECT (${expression} #>> '{}') AS value${from === undefined ? '' : ` FROM ${from}`}) label_value`;
const cache = new Map<string, LabelProgram | { readonly error: string }>();

/** Compile pure CEL over `record` (bare field names also work). Unsupported native operators fail at authoring. */
export function label_expression(expression: string): LabelProgram | { readonly error: string } {
	const hit = cache.get(expression);
	if (hit !== undefined) return hit;
	const result = Result.try(() => {
		const env = new Environment({ homogeneousAggregateLiterals: false });
		const ast = env.parse(expression).ast;
		const paths = new Set<string>();
		const walk = (node: ASTNode, bound: readonly string[] = []) => {
			const path = pathOf(node);
			if (path !== undefined) {
				if (!bound.includes(path[0] ?? '')) {
					const own = path[0] === 'record' ? path.slice(1) : path;
					if (own.length === 0)
						throw new Error('A label names record fields, not the whole record.');
					paths.add(own.join('.'));
				}
				return;
			}
			if (node.op === 'rcall' && ['map', 'filter', 'exists', 'all'].includes(node.args[0])) {
				walk(node.args[1], bound);
				const [variable, ...body] = node.args[2];
				if (variable?.op !== 'id') throw new Error('A label comprehension needs a variable.');
				for (const child of body) walk(child, [...bound, variable.args]);
				return;
			}
			for (const child of children(node)) walk(child, bound);
		};
		walk(ast);
		env.registerVariable('record', 'map<string, dyn>');
		for (const root of new Set([...paths].map((p) => p.split('.')[0] ?? '')))
			if (root !== 'record') env.registerVariable(root, 'dyn');
		const checked = env.check(expression);
		if (!checked.valid) throw checked.error;
		if (checked.type !== 'dyn' && checked.type !== 'string')
			throw new Error(
				`A label must return text, got ${checked.type}. Use string(value) for numbers.`
			);
		const program = env.parse(expression);
		const sql = (read: (path: string) => string) => {
			let serial = 0;
			const emit = (n: ASTNode, locals: ReadonlyMap<string, string> = new Map()): string => {
				const path = pathOf(n);
				if (path !== undefined) {
					const local = locals.get(path[0] ?? '');
					return local === undefined
						? `coalesce(${read((path[0] === 'record' ? path.slice(1) : path).join('.'))}, 'null'::jsonb)`
						: path.slice(1).reduce((row, key) => `(${row} -> ${literal(key)})`, local);
				}
				const child = (x: ASTNode) => emit(x, locals);
				switch (n.op) {
					case 'value':
						if (n.args === null) return "'null'::jsonb";
						if (typeof n.args === 'string') return json(`${literal(n.args)}::text`);
						if (['number', 'bigint', 'boolean'].includes(typeof n.args))
							return json(String(n.args));
						break;
					case 'list':
						return `jsonb_build_array(${n.args.map(child).join(', ')})`;
					case 'map':
						return `jsonb_build_object(${n.args.flatMap(([key, value]) => [string(child(key)), child(value)]).join(', ')})`;
					case '[]': {
						const source = child(n.args[0]),
							value = child(n.args[1]),
							index = number(value),
							position = `(CASE WHEN ${index} BETWEEN 0 AND 2147483647 AND ${index} % 1 = 0 THEN ${string(value)} END)::int`;
						return `(CASE WHEN jsonb_typeof(${source}) = 'array' THEN ${source} -> ${position} ELSE ${source} -> ${string(value)} END)`;
					}
					case 'in': {
						const own = child(n.args[0]),
							source = child(n.args[1]);
						return json(
							`(CASE WHEN jsonb_typeof(${source}) = 'object' THEN ${source} ? ${string(own)} ELSE ${source} @> jsonb_build_array(${own}) END)`
						);
					}
					case '?:':
						return `(CASE WHEN ${bool(child(n.args[0]))} IS TRUE THEN ${child(n.args[1])} WHEN ${bool(child(n.args[0]))} IS FALSE THEN ${child(n.args[2])} ELSE 'null'::jsonb END)`;
					case '!_':
						return json(`NOT ${bool(child(n.args))}`);
					case '-_':
						return json(`-${number(child(n.args))}`);
					case '==':
					case '!=':
					case '<':
					case '<=':
					case '>':
					case '>=':
						return json(
							`(${child(n.args[0])} ${n.op === '==' ? '=' : n.op === '!=' ? '<>' : n.op} ${child(n.args[1])})`
						);
					case '&&':
					case '||':
						return json(
							`(${bool(child(n.args[0]))} ${n.op === '&&' ? 'AND' : 'OR'} ${bool(child(n.args[1]))})`
						);
					case '+': {
						const left = child(n.args[0]),
							right = child(n.args[1]),
							alias = `label_${serial++}`;
						const a = `${alias}.left_value`,
							b = `${alias}.right_value`;
						return `(SELECT CASE WHEN jsonb_typeof(${a}) = 'string' AND jsonb_typeof(${b}) = 'string' THEN ${json(`${string(a)} || ${string(b)}`)} WHEN jsonb_typeof(${a}) = 'array' AND jsonb_typeof(${b}) = 'array' THEN ${a} || ${b} ELSE ${json(`${number(a)} + ${number(b)}`)} END FROM (SELECT ${left} AS left_value, ${right} AS right_value) ${alias})`;
					}
					case '-':
					case '*':
						return json(`(${number(child(n.args[0]))} ${n.op} ${number(child(n.args[1]))})`);
					case '%':
						return json(`(${number(child(n.args[0]))} % nullif(${number(child(n.args[1]))}, 0))`);
					case '/': {
						const quotient = `${number(child(n.args[0]))} / nullif(${number(child(n.args[1]))}, 0)`;
						return json(
							integer(n.args[0]) && integer(n.args[1])
								? `trunc(${quotient})`
								: `(${quotient})::double precision`
						);
					}
					case 'call': {
						const [fn, args] = n.args,
							value = args[0];
						if (value === undefined) break;
						const x = child(value);
						if (fn === 'string') return json(string(x));
						if (fn === 'int') return json(`trunc(${parsedNumber(x)})::bigint`);
						if (fn === 'double') return json(`(${parsedNumber(x)})::double precision`);
						if (fn === 'has') {
							const path = pathOf(value);
							if (path === undefined) break;
							const local = locals.get(path[0] ?? '');
							const selected =
								local === undefined
									? read((path[0] === 'record' ? path.slice(1) : path).join('.'))
									: path.slice(1).reduce((row, key) => `(${row} -> ${literal(key)})`, local);
							// CEL presence distinguishes a declared null value from a missing member.
							return json(`(${selected} IS NOT NULL)`);
						}
						if (fn === 'size') return json(size(x));
						break;
					}
					case 'rcall': {
						const [fn, receiver, args] = n.args,
							source = child(receiver);
						if (['map', 'filter', 'exists', 'all'].includes(fn)) {
							const [variable, body] = args;
							if (variable?.op !== 'id' || body === undefined) break;
							const alias = `label_${serial++}`;
							const bindings = new Map(locals).set(variable.args, `${alias}.value`);
							const value = emit(fn === 'map' && args[2] !== undefined ? args[2] : body, bindings),
								from = `jsonb_array_elements(${source}) WITH ORDINALITY ${alias}(value, ord)`;
							if (fn === 'exists' || fn === 'all')
								return json(
									`(SELECT coalesce(${fn === 'exists' ? 'bool_or' : 'bool_and'}(${bool(value)}), ${fn === 'all'}) FROM ${from})`
								);
							const filter =
								fn === 'filter' || (fn === 'map' && args[2] !== undefined)
									? ` FILTER (WHERE ${bool(emit(body, bindings))})`
									: '';
							return `(SELECT coalesce(jsonb_agg(${fn === 'map' ? value : `${alias}.value`} ORDER BY ${alias}.ord)${filter}, '[]'::jsonb) FROM ${from})`;
						}
						if (fn === 'join') {
							const alias = `label_${serial++}`,
								sep = args[0] === undefined ? "''" : string(child(args[0]));
							return json(
								`(SELECT coalesce(string_agg(${alias}.value #>> '{}', ${sep} ORDER BY ${alias}.ord), '') FROM jsonb_array_elements(${source}) WITH ORDINALITY ${alias}(value, ord))`
							);
						}
						const x = string(source),
							first = args[0] === undefined ? undefined : string(child(args[0]));
						if (fn === 'lowerAscii')
							return json(
								`translate(${x}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
							);
						if (fn === 'upperAscii')
							return json(
								`translate(${x}, 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')`
							);
						if (fn === 'trim') return json(`btrim(${x})`);
						if (fn === 'size') return json(size(source));
						if (first === undefined) break;
						if (fn === 'contains') return json(`strpos(${x}, ${first}) > 0`);
						if (fn === 'startsWith') return json(`left(${x}, length(${first})) = ${first}`);
						if (fn === 'endsWith') return json(`right(${x}, length(${first})) = ${first}`);
						if (fn === 'replace' && args.length === 2 && args[1] !== undefined)
							return json(`replace(${x}, ${first}, ${string(child(args[1]))})`);
						break;
					}
				}
				throw new Error(
					`CEL '${n.op === 'call' || n.op === 'rcall' ? n.args[0] : n.op}' is not supported in record labels.`
				);
			};
			return emit(ast);
		};
		sql(() => "'null'::jsonb");
		return {
			paths: [...paths],
			evaluate: (row: { readonly [field: string]: Value }) => {
				const values = Object.fromEntries(
					Object.entries(row).map(([key, value]) => [key, input(value)])
				);
				return program({ ...values, record: values });
			},
			sql
		};
	});
	const compiled = Result.isSuccess(result)
		? result.success
		: { error: result.failure instanceof Error ? result.failure.message : String(result.failure) };
	if (cache.size >= 1024) cache.clear();
	cache.set(expression, compiled);
	return compiled;
}
