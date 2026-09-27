// std/formula (§3.7, D21, M1): user-edited rules as CEL text, compiled against a context declared with field-kind
// literals (object roots included) and evaluated over plain values. The numeric mode belongs to the context:
// 'decimal' (default) evaluates money and decimals exactly as `Decimal`, 'float' in doubles (hr's law, D21).
// Registered functions keep today's `registerFunction` signatures, so hr's law seed (`.age_on(`, `.birthday(`) runs
// unchanged; object roots are `map<string, dyn>` for them, and their member paths are checked here instead.
import { Environment, type ParseResult } from '@marcbachmann/cel-js';
import { Decimal } from './decimal.ts';
import { PlainDate } from './date.ts';

type Scalar = 'text' | 'int' | 'decimal' | 'money' | 'number' | 'bool' | 'date' | 'instant' | 'time' | 'enum' | 'currency' | 'duration' | 'count' | 'sum';
/** A root's kind: the field-kind literals of §3.3.2 that a formula can read. */
type Kind =
	| { readonly kind: Scalar; readonly optional?: true; readonly values?: readonly string[] }
	| { readonly kind: 'list'; readonly of: Kind; readonly optional?: true }
	| { readonly kind: 'record'; readonly of: Kind; readonly optional?: true }
	| { readonly kind: 'object'; readonly fields: { readonly [name: string]: Kind }; readonly optional?: true }
	| { readonly kind: 'json'; readonly optional?: true };
type Roots = { readonly [name: string]: Kind };
type Mode = 'decimal' | 'float';
type Fn = { readonly signature: string; readonly fn: (...args: never[]) => unknown };

type Num<M extends Mode> = M extends 'float' ? number : Decimal;
type In<K> = K extends { optional: true } ? In0<K> | null : In0<K>;
type In0<K> =
	K extends { kind: 'list'; of: infer O } ? readonly In<O>[]
	: K extends { kind: 'record'; of: infer O } ? { readonly [key: string]: In<O> }
	: K extends { kind: 'object'; fields: infer F } ? { readonly [N in keyof F]: In<F[N]> }
	: K extends { kind: 'decimal' | 'money' | 'sum' } ? Decimal | number | string
	: K extends { kind: 'int' | 'number' | 'duration' | 'count' } ? number
	: K extends { kind: 'bool' } ? boolean
	: K extends { kind: 'json' } ? unknown
	: string;
type ValuesOf<R extends Roots> = { readonly [N in keyof R]: In<R[N]> };

/** The type a compiled formula must produce. */
export type FormulaResult = 'bool' | 'decimal' | 'money' | 'int' | 'date' | 'text';
type Out<T extends FormulaResult, M extends Mode> =
	T extends 'bool' ? boolean : T extends 'int' ? number : T extends 'decimal' | 'money' ? Num<M> : T extends 'date' ? PlainDate : string;

type Site<R extends Roots, M extends Mode> = { readonly roots: R; readonly numbers: M };
/**
 * A formula context from `context()`: the typed roots a formula reads, the numeric mode, its registered functions and an optional typed `derive` from rows to root values.
 */
export type FormulaContext<R extends Roots = Roots, M extends Mode = Mode, D = undefined> = Site<R, M> & {
	/** M1: the typed builder from the caller's rows to this context's values, when one was declared. */
	readonly derive: D extends (rows: infer X) => unknown ? (rows: X) => ValuesOf<R> : undefined;
};
type Compiled<R extends Roots, M extends Mode, T extends FormulaResult> = {
	readonly text: string; readonly result: T; readonly context: Site<R, M>; readonly program: ParseResult;
};

const DIV_SCALE = 12; // ponytail: `/` on decimals rounds to 12 places half-up; a formula needing more calls round() itself
const NUMERIC = new Set<string>(['int', 'decimal', 'money', 'number', 'duration', 'count', 'sum']);
const EXACT = new Set<string>(['decimal', 'money', 'sum']);
const internals = new WeakMap<object, { env: Environment; cache: Map<string, Compiled<Roots, Mode, FormulaResult>> }>();

function celType(k: Kind, mode: Mode): string {
	if (k.kind === 'list') return 'list<dyn>';
	if (k.kind === 'record' || k.kind === 'object') return 'map<string, dyn>';
	if (k.kind === 'json') return 'dyn';
	if (k.kind === 'bool') return 'bool';
	if (!NUMERIC.has(k.kind)) return 'string';
	if (mode === 'float' || k.kind === 'number') return 'double';
	return EXACT.has(k.kind) ? 'Decimal' : 'int';
}

/** Maps inside cel-js (a map literal) reach registered functions as plain objects, as today's rows did. */
const plain = (v: unknown): unknown =>
	v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, plain(x)])) : Array.isArray(v) ? v.map(plain) : v;

function arithmetic(env: Environment, mode: Mode) {
	const ops = ['+', '-', '*', '/'] as const, cmp = ['<', '<=', '>', '>=', '=='] as const;
	if (mode === 'float') {
		const n = (x: unknown) => Number(x);
		const calc = { '+': (a: number, b: number) => a + b, '-': (a: number, b: number) => a - b, '*': (a: number, b: number) => a * b, '/': (a: number, b: number) => a / b };
		for (const op of ops) {
			env.registerOperator(`double ${op} int`, (a, b) => calc[op](n(a), n(b)));
			env.registerOperator(`int ${op} double`, (a, b) => calc[op](n(a), n(b)));
		}
		return;
	}
	const d = (x: unknown) => x instanceof Decimal ? x : typeof x === 'number' ? fromDouble(x) : Decimal.of(x as bigint);
	const calc = {
		'+': (a: Decimal, b: Decimal) => a.plus(b), '-': (a: Decimal, b: Decimal) => a.minus(b),
		'*': (a: Decimal, b: Decimal) => a.times(b), '/': (a: Decimal, b: Decimal) => a.div(b, DIV_SCALE)
	};
	const test = { '<': (c: number) => c < 0, '<=': (c: number) => c <= 0, '>': (c: number) => c > 0, '>=': (c: number) => c >= 0, '==': (c: number) => c === 0 };
	env.registerType('Decimal', Decimal as never);
	env.registerOperator('-Decimal', (a) => (a as Decimal).neg());
	for (const [l, r] of [['Decimal', 'Decimal'], ['Decimal', 'int'], ['int', 'Decimal'], ['Decimal', 'double'], ['double', 'Decimal']] as const) {
		for (const op of ops) env.registerOperator(`${l} ${op} ${r}`, (a, b) => calc[op](d(a), d(b)));
		for (const op of cmp) if (op !== '==' || l === 'Decimal') env.registerOperator(`${l} ${op} ${r}`, (a, b) => test[op](d(a).cmp(d(b)))); // == registers its mirror and !=
	}
	env.registerFunction('round(Decimal, int): Decimal', (a, s) => (a as Decimal).round(Number(s)));
	env.registerFunction('decimal(string): Decimal', (s) => Decimal.of(s as string));
}

/**
 * A formula context: its roots (field-kind literals), numeric mode, registered CEL functions (`{ signature, fn }`,
 * today's `registerFunction`) and, for derived roots (M1), a typed `derive(rows)` builder.
 */
export function context<const R extends Roots, M extends Mode = 'decimal', D extends ((rows: never) => ValuesOf<R>) | undefined = undefined>(
	roots: R,
	opts: { readonly numbers?: M; readonly functions?: { readonly [name: string]: Fn }; readonly derive?: D } = {}
): FormulaContext<R, M, D> {
	const numbers = (opts.numbers ?? 'decimal') as M;
	const env = new Environment({ homogeneousAggregateLiterals: false });
	arithmetic(env, numbers);
	for (const [name, k] of Object.entries(roots)) env.registerVariable(name, celType(k, numbers));
	for (const { signature, fn } of Object.values(opts.functions ?? {}))
		env.registerFunction(signature, (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args.map(plain)));
	const ctx = { roots, numbers, derive: opts.derive } as FormulaContext<R, M, D>;
	internals.set(ctx, { env, cache: new Map() });
	return ctx;
}

type Node = { readonly op: string; readonly args: unknown };
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && 'op' in v;
function chain(n: Node): string[] | null {
	if (n.op === 'id' && typeof n.args === 'string') return [n.args];
	if (n.op !== '.' && n.op !== '.?') return null;
	const [obj, prop] = n.args as [unknown, unknown];
	const c = isNode(obj) ? chain(obj) : null;
	return c === null || typeof prop !== 'string' ? null : [...c, prop];
}
/** The first member path through an object root that its literal does not declare. */
function unknownPath(n: unknown, roots: Roots): string | null {
	if (Array.isArray(n)) { for (const x of n) { const u = unknownPath(x, roots); if (u) return u; } return null; }
	if (!isNode(n)) return null;
	const c = chain(n);
	if (c !== null) {
		let k: Kind | undefined = roots[c[0]!];
		for (let i = 1; i < c.length && k?.kind === 'object'; i++) {
			k = k.fields[c[i]!];
			if (k === undefined) return c.slice(0, i + 1).join('.');
		}
		return null;
	}
	return unknownPath(n.args, roots);
}

const ACCEPTS: { readonly [T in FormulaResult]: { readonly [M in Mode]: readonly string[] } } = {
	bool: { decimal: ['bool'], float: ['bool'] }, int: { decimal: ['int'], float: ['int', 'double'] },
	decimal: { decimal: ['Decimal', 'int', 'double'], float: ['double', 'int'] }, money: { decimal: ['Decimal', 'int', 'double'], float: ['double', 'int'] },
	date: { decimal: ['string'], float: ['string'] }, text: { decimal: ['string'], float: ['string'] }
};
/** A double (a CEL literal like `0.17`) as the decimal it prints as. */
const fromDouble = (x: number) => /e/i.test(String(x)) ? Decimal.fromNumber(x, 15) : Decimal.of(String(x));
const first = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

/** Compiles `text` for a result kind; `{ error }` names the syntax fault, the unknown path or the wrong type. Cached per (context, text, result). */
export function compile<R extends Roots, M extends Mode, T extends FormulaResult>(ctx: Site<R, M>, text: string, result: T):
	Compiled<R, M, T> | { readonly error: string } {
	const own = internals.get(ctx);
	if (own === undefined) throw new TypeError('not a formula context');
	const key = `${result}\u0000${text}`, hit = own.cache.get(key);
	if (hit) return hit as unknown as Compiled<R, M, T>;
	let program: ParseResult;
	try { program = own.env.parse(text); } catch (e) { return { error: first(e) }; }
	const path = unknownPath(program.ast, ctx.roots);
	if (path !== null) return { error: `unknown path ${path}` };
	const checked = own.env.check(text);
	if (!checked.valid) return { error: first(checked.error) };
	const type = checked.type ?? 'dyn';
	if (type !== 'dyn' && !ACCEPTS[result][ctx.numbers].includes(type))
		return { error: `expected ${result === 'bool' ? 'a yes/no' : `a ${result}`} result, got ${type}` };
	const compiled: Compiled<R, M, T> = { text, result, context: ctx, program };
	if (own.cache.size >= 65_536) own.cache.clear();
	own.cache.set(key, compiled as unknown as Compiled<Roots, Mode, FormulaResult>);
	return compiled;
}

function input(k: Kind, v: unknown, mode: Mode): unknown {
	if (v === null || v === undefined) return null;
	switch (k.kind) {
		case 'list': return (v as readonly unknown[]).map((x) => input(k.of, x, mode));
		case 'record': return Object.fromEntries(Object.entries(v as object).map(([n, x]) => [n, input(k.of, x, mode)]));
		case 'object': return Object.fromEntries(Object.entries(k.fields).map(([n, f]) => [n, input(f, (v as Record<string, unknown>)[n], mode)]));
		case 'json': return v;
	}
	if (!NUMERIC.has(k.kind)) return v;
	if (mode === 'float' || k.kind === 'number') return v instanceof Decimal ? v.toNumber() : Number(v);
	return EXACT.has(k.kind) ? Decimal.of(v as string) : BigInt(v as number);
}

/** Evaluates a compiled formula; a runtime fault (a missing value, a wrong result) throws. */
export function evaluate<R extends Roots, M extends Mode, T extends FormulaResult>(compiled: Compiled<R, M, T>, values: ValuesOf<R>): Out<T, M> {
	const { context: ctx, result } = compiled, mode = ctx.numbers;
	const scope: Record<string, unknown> = {};
	for (const [name, k] of Object.entries(ctx.roots)) scope[name] = input(k, (values as Record<string, unknown>)[name], mode);
	const v: unknown = compiled.program(scope);
	const bad = () => new TypeError(`'${compiled.text}' produced ${String(v)}, not a ${result}`);
	switch (result) {
		case 'bool': if (typeof v !== 'boolean') throw bad(); return v as Out<T, M>;
		case 'text': if (typeof v !== 'string') throw bad(); return v as Out<T, M>;
		case 'date': if (typeof v !== 'string') throw bad(); return PlainDate(v) as Out<T, M>;
		case 'int': {
			const n = typeof v === 'bigint' ? Number(v) : v;
			if (typeof n !== 'number' || !Number.isInteger(n)) throw bad();
			return n as Out<T, M>;
		}
	}
	if (mode === 'float') { if (typeof v !== 'bigint' && typeof v !== 'number') throw bad(); return Number(v) as Out<T, M>; }
	if (v instanceof Decimal) return v as Out<T, M>;
	if (typeof v === 'bigint') return Decimal.of(v) as Out<T, M>;
	if (typeof v === 'number' && Number.isFinite(v)) return fromDouble(v) as Out<T, M>;
	throw bad();
}

/** A value validator for stored formula text (a custom field's `validate`, a transform refusal): the error or undefined. */
export const formula = <R extends Roots, M extends Mode>(ctx: Site<R, M>, result: FormulaResult) =>
	(text: string): string | undefined => { const c = compile(ctx, text, result); return 'error' in c ? c.error : undefined; };
