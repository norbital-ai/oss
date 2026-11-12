// std/pricing (M2): catalogue lines → bands → formula → bucket → line. A catalogue line carries ordered bands of
// formula text; a band that holds (`when`) takes a slice of the quantity (`take`, default all that is left) and prices
// it (`price`, reading the slice as the root `quantity`); each priced slice is one line in the catalogue line's bucket.
// Payroll overtime bands, allowance families, CRM price breaks and commissions are all this shape.
import { Decimal, type DecimalLike } from './decimal.ts';
import * as Result from 'effect/Result';
import { compile, evaluate, type Out } from './formula.ts';

type Band = {
	readonly when?: string;
	readonly take?: string;
	readonly price: string;
	readonly label?: string;
};
type Line = {
	readonly code: string;
	readonly label: string;
	readonly bucket: string;
	readonly quantity?: DecimalLike | null;
	readonly bands: readonly Band[];
};
type Ctx = Parameters<typeof compile>[0];
type Values = { readonly [root: string]: unknown };
type Amount<C extends Ctx> = Out<'decimal', C['numbers']>;
type Slice<C extends Ctx> = {
	readonly band: number;
	readonly label: string | undefined;
	readonly quantity: Decimal | null;
	readonly amount: Amount<C>;
};

/** A priced line: its code, label, bucket and band, the quantity (or `null`) and the amount. */
type PricedLine<C extends Ctx = Ctx> = {
	readonly code: string;
	readonly label: string;
	readonly bucket: string;
	readonly band: number;
	readonly quantity: Decimal | null;
	readonly amount: Amount<C>;
};

function run<C extends Ctx, T extends 'bool' | 'decimal'>(
	ctx: C,
	text: string,
	result: T,
	values: Values
): Result.Result<Out<T, C['numbers']>, string> {
	const c = compile<Ctx['roots'], C['numbers'], T>(ctx, text, result);
	return 'error' in c
		? Result.fail(`'${text}' does not compile: ${c.error}`)
		: Result.succeed(evaluate(c, values));
}
const toDecimal = (v: number | Decimal) => (v instanceof Decimal ? v : Decimal.from_number(v, 10));

/**
 * The slices one band list prices. With no quantity the first band that holds prices the whole (a flat amount);
 * with one, bands take slices in order until it is used up. A band formula that does not compile fails.
 */
export function band<C extends Ctx>(
	ctx: C,
	bands: readonly Band[],
	values: Values,
	quantity?: DecimalLike | null
): Result.Result<Slice<C>[], string> {
	const holds = (b: Band, q: Decimal | null) =>
		b.when === undefined
			? Result.succeed(true)
			: run(ctx, b.when, 'bool', { ...values, quantity: q });
	const price = (b: Band, q: Decimal | null) =>
		run(ctx, b.price, 'decimal', { ...values, quantity: q });
	return Result.gen(function* () {
		const out: Slice<C>[] = [];
		if (quantity == null) {
			for (const [i, b] of bands.entries())
				if (yield* holds(b, null))
					return [{ band: i, label: b.label, quantity: null, amount: yield* price(b, null) }];
			return out;
		}
		let left = Decimal.of(quantity);
		for (const [i, b] of bands.entries()) {
			if (left.sign() <= 0) break;
			if (!(yield* holds(b, left))) continue;
			const want =
				b.take === undefined
					? left
					: toDecimal(yield* run(ctx, b.take, 'decimal', { ...values, quantity: left }));
			const take = want.gt(left) ? left : want;
			if (take.sign() <= 0) continue;
			out.push({ band: i, label: b.label, quantity: take, amount: yield* price(b, take) });
			left = left.minus(take);
		}
		return out;
	});
}

/** Every catalogue line priced through its bands, one `PricedLine` per slice, in catalogue order. */
export function priced_lines<C extends Ctx>(
	ctx: C,
	lines: readonly Line[],
	values: Values
): Result.Result<PricedLine<C>[], string> {
	return Result.gen(function* () {
		const out: PricedLine<C>[] = [];
		for (const l of lines)
			for (const s of yield* band(ctx, l.bands, values, l.quantity))
				out.push({
					code: l.code,
					label: s.label ?? l.label,
					bucket: l.bucket,
					band: s.band,
					quantity: s.quantity,
					amount: s.amount
				});
		return out;
	});
}
