// std/formula (D21, M1): user-edited rules as CEL text, compiled against a context declared with field-kind
// literals (object roots included) and evaluated over plain values. The numeric mode belongs to the context:
// 'decimal' (default) evaluates money and decimals exactly as `Decimal`, 'float' in doubles (hr's law, D21).
// Registered functions keep today's `registerFunction` signatures, so hr's law seed (`.age_on(`, `.birthday(`) runs
// unchanged; object roots are `map<string, dyn>` for them, and their member paths are checked here instead.
import { Environment, type ASTNode, type ParseResult } from '@marcbachmann/cel-js';
import { children } from './cel-ast.ts';
import * as Result from 'effect/Result';
import { Decimal } from './decimal.ts';
import { PlainDate } from './date.ts';
import * as Predicate from 'effect/Predicate';
import type { Json } from './wire.ts';

type Scalar =
	| 'text'
	| 'int'
	| 'decimal'
	| 'money'
	| 'number'
	| 'bool'
	| 'date'
	| 'instant'
	| 'time'
	| 'enum'
	| 'currency'
	| 'count'
	| 'sum';
/** A root's kind: the field-kind literals that a formula can read. */
type Kind = { readonly many?: true } & (
	| { readonly kind: Scalar; readonly optional?: true; readonly values?: readonly string[] }
	| { readonly kind: 'record'; readonly of: Kind; readonly optional?: true }
	| {
			readonly kind: 'object';
			readonly fields: { readonly [name: string]: Kind };
			readonly optional?: true;
	  }
	| { readonly kind: 'json'; readonly optional?: true }
);
type Roots = { readonly [name: string]: Kind };
type Mode = 'decimal' | 'float';
type Fn = { readonly signature: string; readonly fn: (...args: never[]) => unknown };

type Num<M extends Mode> = M extends 'float' ? number : Decimal;
type InValue<K> = K extends { many: true } ? readonly In0<K>[] : In0<K>;
type In<K> = K extends { optional: true } ? InValue<K> | null : InValue<K>;
type In0<K> = K extends { kind: 'record'; of: infer O }
	? { readonly [key: string]: In<O> }
	: K extends { kind: 'object'; fields: infer F }
		? { readonly [N in keyof F]: In<F[N]> }
		: K extends { kind: 'decimal' | 'money' | 'sum' }
			? Decimal | number | string
			: K extends { kind: 'int' | 'number' | 'count' }
				? number
				: K extends { kind: 'bool' }
					? boolean
					: K extends { kind: 'json' }
						? unknown
						: string;
type ValuesOf<R extends Roots> = { readonly [N in keyof R]: In<R[N]> };

/** The type a compiled formula must produce. */
type FormulaResult = 'bool' | 'decimal' | 'money' | 'int' | 'date' | 'text' | 'json';
/** The value a compiled formula produces for its result kind and numeric mode. */
export type Out<T extends FormulaResult, M extends Mode> = T extends 'json'
	? Json
	: T extends 'bool'
		? boolean
		: T extends 'int'
			? number
			: T extends 'decimal' | 'money'
				? Num<M>
				: T extends 'date'
					? PlainDate
					: string;

type Reader<T extends FormulaResult, M extends Mode> = (v: unknown, bad: () => TypeError) => Out<T, M>;
type Readers<M extends Mode> = { readonly [T in FormulaResult]: Reader<T, M> };
type Site<R extends Roots, M extends Mode> = {
	readonly roots: R;
	readonly numbers: M;
	/** Each result kind's reader in this mode, so a result carries its `Out` type. */
	readonly read: Readers<M>;
};
/**
 * A formula context from `context()`: the typed roots a formula reads, the numeric mode, its registered functions and an optional typed `derive` from rows to root values.
 */
type FormulaContext<R extends Roots = Roots, M extends Mode = Mode, D = undefined> = Site<
	R,
	M
> & {
	/** M1: the typed builder from the caller's rows to this context's values, when one was declared. */
	readonly derive: D;
};
type Derive<R extends Roots> = ((rows: never) => ValuesOf<R>) | undefined;
type Options<M extends Mode, D> = {
	readonly numbers?: M;
	readonly functions?: { readonly [name: string]: Fn };
	readonly derive?: D;
};
type Compiled<R extends Roots, M extends Mode, T extends FormulaResult> = {
	readonly text: string;
	readonly result: T;
	readonly context: Site<R, M>;
	readonly program: ParseResult;
};

const DIV_SCALE = 12; // ponytail: `/` on decimals rounds to 12 places half-up; a formula needing more calls round() itself
const NUMERIC = new Set<string>(['int', 'decimal', 'money', 'number', 'count', 'sum']);
const EXACT = new Set<string>(['decimal', 'money', 'sum']);
const internals = new WeakMap<object, { env: Environment; cache: Map<string, ParseResult> }>();
/** A null literal is a dyn value for checking, then evaluates to null; cel-js 8 rejects it beside a concrete branch. */
const NULL_ROOT = '__cel_null';

function celType(k: Kind, mode: Mode): string {
	if (k.many === true) return 'list<dyn>';
	if (k.kind === 'record' || k.kind === 'object') return 'map<string, dyn>';
	if (k.kind === 'json') return 'dyn';
	if (k.kind === 'bool') return 'bool';
	if (!NUMERIC.has(k.kind)) return 'string';
	if (mode === 'float' || k.kind === 'number') return 'double';
	return EXACT.has(k.kind) ? 'Decimal' : 'int';
}

/** Maps inside cel-js (a map literal) reach registered functions as plain objects, as today's rows did. */
const plain = (v: unknown): unknown =>
	v instanceof Map
		? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)]))
		: Array.isArray(v)
			? v.map(plain)
			: v;

function arithmetic(env: Environment, mode: Mode) {
	const ops = ['+', '-', '*', '/'] as const,
		cmp = ['<', '<=', '>', '>=', '=='] as const;
	if (mode === 'float') {
		const n = (x: unknown) => Number(x);
		const calc = {
			'+': (a: number, b: number) => a + b,
			'-': (a: number, b: number) => a - b,
			'*': (a: number, b: number) => a * b,
			'/': (a: number, b: number) => a / b
		};
		for (const op of ops) {
			env.registerOperator(`double ${op} int`, (a, b) => calc[op](n(a), n(b)));
			env.registerOperator(`int ${op} double`, (a, b) => calc[op](n(a), n(b)));
		}
		return;
	}
	const d = (x: Decimal | number | bigint) =>
		x instanceof Decimal ? x : typeof x === 'number' ? fromDouble(x) : Decimal.of(x);
	const calc = {
		'+': (a: Decimal, b: Decimal) => a.plus(b),
		'-': (a: Decimal, b: Decimal) => a.minus(b),
		'*': (a: Decimal, b: Decimal) => a.times(b),
		'/': (a: Decimal, b: Decimal) => a.div(b, DIV_SCALE)
	};
	const test = {
		'<': (c: number) => c < 0,
		'<=': (c: number) => c <= 0,
		'>': (c: number) => c > 0,
		'>=': (c: number) => c >= 0,
		'==': (c: number) => c === 0
	};
	env.registerType('Decimal', { ctor: Decimal });
	env.registerOperator('-Decimal', (a: Decimal) => a.neg());
	for (const [l, r] of [
		['Decimal', 'Decimal'],
		['Decimal', 'int'],
		['int', 'Decimal'],
		['Decimal', 'double'],
		['double', 'Decimal']
	] as const) {
		for (const op of ops) env.registerOperator(`${l} ${op} ${r}`, (a, b) => calc[op](d(a), d(b)));
		for (const op of cmp)
			if (op !== '==' || l === 'Decimal')
				env.registerOperator(`${l} ${op} ${r}`, (a, b) => test[op](d(a).cmp(d(b)))); // == registers its mirror and !=
	}
	env.registerFunction('round(Decimal, int): Decimal', (a: Decimal, s: bigint) =>
		a.round(Number(s))
	);
	env.registerFunction('decimal(string): Decimal', (s: string) => Decimal.of(s));
}

/**
 * A formula context: its roots (field-kind literals), numeric mode, registered CEL functions (`{ signature, fn }`,
 * today's `registerFunction`) and, for derived roots (M1), a typed `derive(rows)` builder.
 */
export function context<const R extends Roots, D extends Derive<R> = undefined>(
	roots: R,
	opts?: Options<'decimal', D>
): FormulaContext<R, 'decimal', D>;
export function context<const R extends Roots, M extends Mode, D extends Derive<R> = undefined>(
	roots: R,
	opts: Options<M, D> & { readonly numbers: M }
): FormulaContext<R, M, D>;
export function context(
	roots: Roots,
	opts: Options<Mode, Derive<Roots>> = {}
): FormulaContext<Roots, Mode, Derive<Roots>> {
	const numbers = opts.numbers ?? 'decimal';
	const env = new Environment({ homogeneousAggregateLiterals: false });
	arithmetic(env, numbers);
	const allRoots: Roots = { ...roots, [NULL_ROOT]: { kind: 'json' } };
	for (const [name, k] of Object.entries(allRoots)) env.registerVariable(name, celType(k, numbers));
	for (const { signature, fn } of Object.values(opts.functions ?? {}))
		env.registerFunction(signature, (...args: unknown[]): unknown =>
			Reflect.apply(fn, undefined, args.map(plain))
		);
	const read: Readers<Mode> = numbers === 'float' ? FLOAT : DECIMAL;
	const ctx = { roots, numbers, read, derive: opts.derive };
	internals.set(ctx, { env, cache: new Map() });
	return ctx;
}

function chain(n: ASTNode): [string, ...string[]] | null {
	if (n.op === 'id') return [n.args];
	if (n.op !== '.' && n.op !== '.?') return null;
	const c = chain(n.args[0]);
	return c === null ? null : [...c, n.args[1]];
}
/** The first member path through an object root that its literal does not declare. */
function unknownPath(n: ASTNode, roots: Roots): string | null {
	const c = chain(n);
	if (c !== null) {
		if (c[0] === NULL_ROOT) return null;
		let k: Kind | undefined = roots[c[0]];
		for (const [i, part] of c.slice(1).entries()) {
			if (k?.kind !== 'object') break;
			k = k.fields[part];
			if (k === undefined) return c.slice(0, i + 2).join('.');
		}
		return null;
	}
	for (const x of children(n)) {
		const u = unknownPath(x, roots);
		if (u) return u;
	}
	return null;
}

const ACCEPTS: { readonly [T in FormulaResult]: { readonly [M in Mode]: readonly string[] } } = {
	bool: { decimal: ['bool'], float: ['bool'] },
	int: { decimal: ['int'], float: ['int', 'double'] },
	decimal: { decimal: ['Decimal', 'int', 'double'], float: ['double', 'int'] },
	money: { decimal: ['Decimal', 'int', 'double'], float: ['double', 'int'] },
	date: { decimal: ['string'], float: ['string'] },
	text: { decimal: ['string'], float: ['string'] },
	json: {
		decimal: ['bool', 'string', 'int', 'double', 'null', 'list<dyn>', 'map<string, dyn>'],
		float: ['bool', 'string', 'int', 'double', 'null', 'list<dyn>', 'map<string, dyn>']
	}
};
/** A double (a CEL literal like `0.17`) as the decimal it prints as. */
const fromDouble = (x: number) =>
	/e/i.test(String(x)) ? Decimal.from_number(x, 15) : Decimal.of(String(x));
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n', 1).join('');
/** Replace every null literal with the hidden dyn root so optional branches keep one checkable type. */
function rewriteNull(node: unknown, nullNode: ASTNode): unknown {
	if (Array.isArray(node)) return node.map((child) => rewriteNull(child, nullNode));
	if (node == null || typeof node !== 'object') return node;
	if ('op' in node && node.op === 'value' && 'args' in node && node.args === null) return nullNode;
	for (const [key, value] of Object.entries(node))
		if (value != null && typeof value === 'object') Reflect.set(node, key, rewriteNull(value, nullNode));
	return node;
}

/** Compiles `text` for a result kind; `{ error }` names the syntax fault, the unknown path or the wrong type. Cached per (context, text, result). */
export function compile<R extends Roots, M extends Mode, T extends FormulaResult>(
	ctx: Site<R, M>,
	text: string,
	result: T
): Compiled<R, M, T> | { readonly error: string } {
	const own = internals.get(ctx);
	if (own === undefined) throw new TypeError('not a formula context');
	const key = `${result}\u0000${text}`,
		hit = own.cache.get(key);
	if (hit) return { text, result, context: ctx, program: hit };
	const parsed = Result.try(() => own.env.parse(text));
	if (Result.isFailure(parsed)) return { error: first(parsed.failure) };
	const program = parsed.success;
	const nullNode = own.env.parse(NULL_ROOT).ast;
	rewriteNull(program.ast, nullNode);
	const path = unknownPath(program.ast, ctx.roots);
	if (path !== null) return { error: `unknown path ${path}` };
	const checked = program.check();
	if (!checked.valid) return { error: first(checked.error) };
	// CEL object roots are maps of dyn; a declared member still has its own result type.
	const declared = chain(program.ast)?.reduce<Kind | undefined>(
		(kind, part, i) =>
			i === 0 ? ctx.roots[part] : kind?.kind === 'object' ? kind.fields[part] : undefined,
		undefined
	);
	const type = declared === undefined ? (checked.type ?? 'dyn') : celType(declared, ctx.numbers);
	if (result !== 'json' && type !== 'dyn' && !ACCEPTS[result][ctx.numbers].includes(type))
		return {
			error: `expected ${result === 'bool' ? 'a yes/no' : `a ${result}`} result, got ${type}`
		};
	const compiled: Compiled<R, M, T> = { text, result, context: ctx, program };
	if (own.cache.size >= 65_536) own.cache.clear();
	own.cache.set(key, program);
	return compiled;
}

function input(k: Kind, v: unknown, mode: Mode): unknown {
	if (v === null || v === undefined) return null;
	if (k.many === true) {
		const { many: _many, optional: _optional, ...item } = k;
		return Array.isArray(v) ? v.map((value) => input(item, value, mode)) : v;
	}
	switch (k.kind) {
		case 'record':
			return Object.fromEntries(
				Object.entries(Predicate.isObject(v) ? v : {}).map(([n, x]) => [n, input(k.of, x, mode)])
			);
		case 'object':
			return Object.fromEntries(
				Object.entries(k.fields).map(([n, f]) => [
					n,
					input(f, Predicate.isObject(v) ? v[n] : undefined, mode)
				])
			);
		case 'json':
			return v;
	}
	if (!NUMERIC.has(k.kind)) return v;
	if (mode === 'float' || k.kind === 'number')
		return v instanceof Decimal ? v.to_number() : Number(v);
	if (!EXACT.has(k.kind)) return BigInt(typeof v === 'bigint' || typeof v === 'string' ? v : Number(v));
	if (v instanceof Decimal || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint')
		return Decimal.of(v);
	throw new TypeError(`${String(v)} is not a decimal`);
}

function jsonValue(value: unknown): Json {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'bigint') {
		const number = Number(value);
		if (!Number.isSafeInteger(number))
			throw new TypeError('CEL JSON integer is outside the safe number range');
		return number;
	}
	if (Array.isArray(value)) return value.map(jsonValue);
	if (value instanceof Map) {
		const entries: [string, Json][] = [];
		for (const [key, entry] of value) {
			if (typeof key !== 'string') throw new TypeError('CEL JSON map needs string keys');
			entries.push([key, jsonValue(entry)]);
		}
		return Object.fromEntries(entries);
	}
	if (
		typeof value === 'object' &&
		value !== null &&
		Object.getPrototypeOf(value) === Object.prototype
	)
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonValue(entry)]));
	throw new TypeError('CEL result is not finite JSON');
}

/** Evaluates a compiled formula; a runtime fault (a missing value, a wrong result) throws. */
export function evaluate<R extends Roots, M extends Mode, T extends FormulaResult>(
	compiled: Compiled<R, M, T>,
	values: ValuesOf<R>
): Out<T, M> {
	const { context: ctx, result } = compiled,
		mode = ctx.numbers;
	const given = new Map<string, unknown>(Object.entries(values));
	const scope: Record<string, unknown> = { [NULL_ROOT]: null };
	for (const [name, k] of Object.entries(ctx.roots)) scope[name] = input(k, given.get(name), mode);
	const v: unknown = compiled.program(scope);
	return ctx.read[result](v, () => new TypeError(`'${compiled.text}' produced ${String(v)}, not a ${result}`));
}

const asBool = (v: unknown, bad: () => TypeError): boolean => {
	if (typeof v !== 'boolean') throw bad();
	return v;
};
const asText = (v: unknown, bad: () => TypeError): string => {
	if (typeof v !== 'string') throw bad();
	return v;
};
const asDate = (v: unknown, bad: () => TypeError): PlainDate => PlainDate(asText(v, bad));
const asInt = (v: unknown, bad: () => TypeError): number => {
	const n = typeof v === 'bigint' ? Number(v) : v;
	if (typeof n !== 'number' || !Number.isInteger(n)) throw bad();
	return n;
};
const asDouble = (v: unknown, bad: () => TypeError): number => {
	if (typeof v !== 'bigint' && typeof v !== 'number') throw bad();
	return Number(v);
};
const asDecimal = (v: unknown, bad: () => TypeError): Decimal => {
	if (v instanceof Decimal) return v;
	if (typeof v === 'bigint') return Decimal.of(v);
	if (typeof v === 'number' && Number.isFinite(v)) return fromDouble(v);
	throw bad();
};
const SAME = { json: jsonValue, bool: asBool, text: asText, date: asDate, int: asInt };
const DECIMAL: Readers<'decimal'> = { ...SAME, decimal: asDecimal, money: asDecimal };
const FLOAT: Readers<'float'> = { ...SAME, decimal: asDouble, money: asDouble };

/** A value validator for stored formula text (a custom field's `validate`, a transform refusal): the error or undefined. */
export const formula =
	<R extends Roots, M extends Mode>(ctx: Site<R, M>, result: FormulaResult) =>
	(text: string): string | undefined => {
		const c = compile(ctx, text, result);
		return 'error' in c ? c.error : undefined;
	};
