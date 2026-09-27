// std/decimal (§3.7, rule 68): exact decimals. A value is a bigint coefficient and a scale, so no amount ever passes
// through a float; `Decimal.fromNumber` is the one explicit door from a double. `valueOf` throws, so `a + b` on two
// decimals fails loudly instead of concatenating strings (`>` on Decimal is doctor DR-1).

/** The rounding modes; `halfUp` is Postgres `round(numeric)`: half away from zero. */
export const Rounding = ['halfUp', 'halfEven', 'down', 'up', 'floor', 'ceil'] as const;
export type Rounding = (typeof Rounding)[number];
/** An ISO 4217 currency code, branded. */
export type CurrencyCode = string & { readonly __currency: unique symbol };
/** A decimal string, a bigint, an integer, or a tagged wire value (`{ $dec: '1.20' }`). */
export type DecimalLike = Decimal | string | bigint | number | { readonly $dec: string };

const TEXT = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const FLOAT = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;
const TEN = 10n;
const pow10 = (n: number) => TEN ** BigInt(n);

/** `n / d` rounded by `mode`; `d > 0`. */
function divRound(n: bigint, d: bigint, mode: Rounding): bigint {
	const q = n / d, r = n % d;
	if (r === 0n) return q;
	const neg = n < 0n, away = neg ? q - 1n : q + 1n;
	const twice = (r < 0n ? -r : r) * 2n;
	switch (mode) {
		case 'down': return q;
		case 'up': return away;
		case 'floor': return neg ? away : q;
		case 'ceil': return neg ? q : away;
		case 'halfUp': return twice >= d ? away : q;
		case 'halfEven': return twice > d || (twice === d && q % 2n !== 0n) ? away : q;
	}
}

/** Every std copy's brand: a page can hold several std builds (the shell's, each template bundle's), one kind of value. */
const BRAND: unique symbol = Symbol.for('norbital.std.decimal');

/**
 * An exact decimal: a bigint coefficient and a scale, so no amount passes through a float. Build one with `Decimal.of` (or
 * `dec`); arithmetic is `plus`, `minus`, `times`, `div` with a rounding mode, comparison is `cmp`. `valueOf` throws, so
 * `a + b` on decimals fails loudly.
 * @example
 * dec('19.90').times(3).round(2, 'halfUp').toString() // '59.70'
 */
export class Decimal {
	readonly #c: bigint;
	readonly #s: number;
	private constructor(c: bigint, s: number) { this.#c = c; this.#s = s; }
	/** `x instanceof Decimal` holds for a decimal from any std copy; its methods are its own copy's, and `of` re-reads it. */
	static [Symbol.hasInstance](v: unknown): boolean { return typeof v === 'object' && v !== null && (v as { [BRAND]?: unknown })[BRAND] === true; }
	get [BRAND](): true { return true; }

	/** Refuses NaN, exponents, blanks and non-numeric text; a JS number must be an integer. */
	static of(v: DecimalLike): Decimal {
		if (typeof v === 'object' && #c in v) return v;
		if (typeof v === 'bigint') return new Decimal(v, 0);
		if (typeof v === 'number') {
			if (!Number.isSafeInteger(v)) throw new RangeError(`${v} is not an integer; use Decimal.fromNumber(x, scale)`);
			return new Decimal(BigInt(v), 0);
		}
		// another copy's Decimal (two std builds on one page) crosses as its exact text
		const text = typeof v === 'string' ? v : '$dec' in v ? v.$dec : String(v);
		const m = TEXT.exec(typeof text === 'string' ? text.trim() : '');
		if (m === null) throw new RangeError(`'${String(text)}' is not a decimal`);
		const frac = m[3] ?? '';
		const c = BigInt(m[2]! + frac);
		return new Decimal(m[1] === '-' ? -c : c, frac.length);
	}

	/** The only door from a float: its shortest round-trip digits, rounded to `scale`. */
	static fromNumber(v: number, scale: number, mode: Rounding = 'halfUp'): Decimal {
		const m = Number.isFinite(v) ? FLOAT.exec(String(v)) : null;
		if (m === null) throw new RangeError(`${v} is not a finite number`);
		const digits = m[2]! + (m[3] ?? ''), exp = Number(m[4] ?? 0) - (m[3] ?? '').length;
		const c = (m[1] === '-' ? -1n : 1n) * BigInt(digits);
		const d = exp >= 0 ? new Decimal(c * pow10(exp), 0) : new Decimal(c, -exp);
		return d.round(scale, mode);
	}

	#at(s: number): bigint { return this.#c * pow10(s - this.#s); }
	static #pair(a: Decimal, o: DecimalLike): [bigint, bigint, number] {
		const b = Decimal.of(o), s = Math.max(a.#s, b.#s);
		return [a.#at(s), b.#at(s), s];
	}

	plus(o: DecimalLike): Decimal { const [a, b, s] = Decimal.#pair(this, o); return new Decimal(a + b, s); }
	minus(o: DecimalLike): Decimal { const [a, b, s] = Decimal.#pair(this, o); return new Decimal(a - b, s); }
	times(o: DecimalLike): Decimal { const b = Decimal.of(o); return new Decimal(this.#c * b.#c, this.#s + b.#s); }
	/** Division needs a scale: the result is rounded to it. */
	div(o: DecimalLike, scale: number, mode: Rounding = 'halfUp'): Decimal {
		const b = Decimal.of(o);
		if (b.#c === 0n) throw new RangeError('division by zero');
		// (a / 10^sa) / (b / 10^sb) = a·10^(sb + scale − sa) / b, then / 10^scale.
		const shift = b.#s + scale - this.#s;
		let n = shift >= 0 ? this.#c * pow10(shift) : this.#c, d = shift >= 0 ? b.#c : b.#c * pow10(-shift);
		if (d < 0n) { n = -n; d = -d; }
		return new Decimal(divRound(n, d, mode), scale);
	}
	round(scale: number, mode: Rounding = 'halfUp'): Decimal {
		if (!Number.isInteger(scale) || scale < 0) throw new RangeError(`scale ${scale} is not a whole number ≥ 0`);
		if (scale >= this.#s) return new Decimal(this.#at(scale), scale);
		return new Decimal(divRound(this.#c, pow10(this.#s - scale), mode), scale);
	}
	/** Rounded to the currency's minor unit (JPY 0, SGD 2, KWD 3). */
	roundTo(c: CurrencyCode | string, mode: Rounding = 'halfUp'): Decimal { return this.round(minorDigits(c), mode); }
	neg(): Decimal { return new Decimal(-this.#c, this.#s); }
	abs(): Decimal { return this.#c < 0n ? this.neg() : this; }
	sign(): -1 | 0 | 1 { return this.#c < 0n ? -1 : this.#c > 0n ? 1 : 0; }
	isZero(): boolean { return this.#c === 0n; }
	/** The number of digits after the point, as stored (`1.20` → 2). */
	get scale(): number { return this.#s; }
	cmp(o: DecimalLike): -1 | 0 | 1 { const [a, b] = Decimal.#pair(this, o); return a < b ? -1 : a > b ? 1 : 0; }
	eq(o: DecimalLike): boolean { return this.cmp(o) === 0; }
	lt(o: DecimalLike): boolean { return this.cmp(o) < 0; }
	lte(o: DecimalLike): boolean { return this.cmp(o) <= 0; }
	gt(o: DecimalLike): boolean { return this.cmp(o) > 0; }
	gte(o: DecimalLike): boolean { return this.cmp(o) >= 0; }
	toString(): string {
		const neg = this.#c < 0n, digits = (neg ? -this.#c : this.#c).toString().padStart(this.#s + 1, '0');
		const cut = digits.length - this.#s;
		return `${neg ? '-' : ''}${digits.slice(0, cut)}${this.#s > 0 ? `.${digits.slice(cut)}` : ''}`;
	}
	/** Strings on the wire (rule 68). */
	toJSON(): string { return this.toString(); }
	/** Lossy, and named so. */
	toNumber(): number { return Number(this.toString()); }
	valueOf(): never { throw new TypeError('Decimal has no primitive value: use plus/minus/cmp, or toNumber() explicitly'); }
}
/** Bolt's decoders (the guest prelude, the `$bolt` client) build row decimals with this class once it is loaded. */
(globalThis as { [k: symbol]: unknown })[Symbol.for('norbital.std.Decimal')] ??= Decimal;

/** Shorthand for `Decimal.of`: a decimal from a string, bigint, integer or tagged wire value. */
export const dec = (v: DecimalLike): Decimal => Decimal.of(v);
/** The exact total of decimal-like values; `0` for none. */
export const sum = (values: Iterable<DecimalLike>): Decimal => {
	let t = Decimal.of(0);
	for (const v of values) t = t.plus(v);
	return t;
};

const ZERO = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
let known: ReadonlySet<string> | undefined;

/** An ISO 4217 code (from the runtime's Intl data); anything else throws. */
export function currency(code: string): CurrencyCode {
	known ??= new Set(Intl.supportedValuesOf('currency'));
	if (!/^[A-Z]{3}$/.test(code) || !known.has(code)) throw new RangeError(`'${code}' is not an ISO 4217 currency`);
	return code as CurrencyCode;
}
/** ISO 4217 minor-unit digits. */
export const minorDigits = (c: CurrencyCode | string): 0 | 2 | 3 => ZERO.has(c) ? 0 : THREE.has(c) ? 3 : 2;
